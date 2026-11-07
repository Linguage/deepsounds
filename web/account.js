const STORAGE_KEY = 'deepsounds-session';

export async function request(path, params, { signal, token, method = 'GET', keepalive = false } = {}) {
  const headers = {};
  const scope = path.startsWith('podcast/') ? 'podcast' : path.startsWith('bilibili/') ? 'bilibili' : 'netease';
  if (token) headers['x-' + scope + '-session'] = token;
  if (method === 'POST') headers['x-deepsounds-client'] = 'panel';
  const query = new URLSearchParams(params).toString();
  const res = await fetch('./api/' + path + (query ? '?' + query : ''), {
    method, headers, signal, keepalive, cache: 'no-store', credentials: 'omit',
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error || '请求失败，请重试。');
    error.status = res.status;
    throw error;
  }
  return data;
}

export function accountPanel({ onLogin, onLogout, scope = 'netease' }) {
  const prefix = scope === 'netease' ? '' : scope + '-';
  const apiPrefix = scope === 'netease' ? '' : scope + '/';
  const serviceName = { podcast: '小宇宙', bilibili: '哔哩哔哩', netease: '网易云音乐' }[scope];
  const storageKey = prefix + STORAGE_KEY;
  const name = document.getElementById(prefix + 'account-name');
  const action = document.getElementById(prefix + 'account-action');
  const original = document.getElementById('login-dialog');
  const dialog = prefix ? original.cloneNode(true) : original;
  if (prefix) {
    dialog.id = prefix + 'login-dialog';
    for (const node of dialog.querySelectorAll('[id]')) node.id = prefix + node.id;
    dialog.setAttribute('aria-labelledby', prefix + 'login-title');
    dialog.querySelector('h2').textContent = '扫码登录' + serviceName;
    document.body.append(dialog);
  }
  const qr = dialog.querySelector('.login-qr');
  qr.alt = serviceName + '登录二维码';
  const status = dialog.querySelector('.login-status');
  const retry = dialog.querySelector('#' + prefix + 'login-retry');
  const close = dialog.querySelector('#' + prefix + 'login-close');
  const scanPrompt = '用' + serviceName + ' App 扫码，并在手机上确认。';

  let token;
  let pending;
  let restoring = false;
  let restoreFailed = false;

  function remember(value, previous) {
    let persisted = false;
    try {
      if (value) {
        localStorage.setItem(storageKey, value);
        persisted = true;
      } else if (localStorage.getItem(storageKey) === previous) localStorage.removeItem(storageKey);
    } catch { /* Login still works when the browser disables persistent storage. */ }
    try {
      if (value && !persisted) sessionStorage.setItem(storageKey, value);
      else if (persisted || sessionStorage.getItem(storageKey) === previous) sessionStorage.removeItem(storageKey);
    } catch { /* Some browsers disable all storage. */ }
  }

  function showProfile(profile) {
    name.hidden = !profile;
    name.textContent = profile?.name ?? '';
    action.textContent = profile ? '退出登录' : '扫码登录';
    action.removeAttribute('title');
  }

  const post = (path, id) => request(apiPrefix + 'login/' + path, null, { token: id, method: 'POST' });
  const revoke = id => { if (id) void post('clear', id).catch(() => {}); };

  function stopPending(revokeToken = true) {
    if (pending) {
      clearTimeout(pending.timer);
      if (revokeToken) revoke(pending.token);
      pending = null;
    }
    qr.hidden = true;
    qr.removeAttribute('src');
  }

  function signedIn(profile, id) {
    stopPending(false);
    if (dialog.open) dialog.close();
    token = id;
    remember(token);
    showProfile(profile);
    onLogin(profile);
  }

  function signedOut(expired) {
    remember(undefined, token);
    token = undefined;
    showProfile(null);
    onLogout(expired);
  }

  async function signOut() {
    action.disabled = true;
    const id = token;
    try {
      await post('clear', id);
      if (token === id) signedOut(false);
    } catch (error) {
      if (token !== id) return;
      action.textContent = '重试退出登录';
      action.title = error.message;
    } finally {
      action.disabled = false;
    }
  }

  function fail(message) {
    stopPending();
    status.textContent = message;
    retry.hidden = false;
    close.textContent = '关闭';
  }

  function schedule(attempt) {
    attempt.timer = setTimeout(() => poll(attempt), 2000);
  }

  async function poll(attempt) {
    try {
      const result = await post('check', attempt.token);
      if (pending !== attempt) return;
      attempt.failures = 0;
      if (result.state === 'signed-in') return signedIn(result.profile, attempt.token);
      if (result.state === 'expired') return fail('二维码已过期，请刷新后再扫码。');
      status.textContent = result.state === 'confirming' ? '已扫码，请在手机上确认登录。' : scanPrompt;
      schedule(attempt);
    } catch (error) {
      if (pending !== attempt) return;
      if (error.status === 401 || ++attempt.failures >= 3) return fail(error.message || '无法检查登录状态。');
      status.textContent = '暂时无法检查登录状态，正在重试。';
      schedule(attempt);
    }
  }

  async function start() {
    if (token || pending || restoring) return;
    if (restoreFailed) return restore();
    const attempt = { failures: 0 };
    pending = attempt;
    retry.hidden = true;
    close.textContent = '取消';
    status.textContent = '正在生成二维码…';
    if (!dialog.open) dialog.showModal();
    try {
      const response = await post('start');
      if (pending !== attempt) return revoke(response.token);
      attempt.token = response.token;
      qr.src = response.qr;
      qr.hidden = false;
      status.textContent = scanPrompt;
      schedule(attempt);
    } catch (error) {
      if (pending === attempt) fail(error.message || '暂时无法生成二维码。');
    }
  }

  function cancel() {
    stopPending();
    dialog.close();
  }

  async function restore() {
    if (restoring || token || pending) return;
    let saved;
    try { saved = localStorage.getItem(storageKey); } catch { /* Try session storage below. */ }
    if (!saved) {
      try { saved = sessionStorage.getItem(storageKey); } catch { return; }
    }
    if (!saved) return;
    restoring = true;
    action.disabled = true;
    try {
      const { profile } = await request(apiPrefix + 'account', null, { token: saved });
      restoreFailed = false;
      signedIn(profile, saved);
    } catch (error) {
      restoreFailed = error.status !== 401;
      if (restoreFailed) {
        action.textContent = '重试恢复登录';
        action.title = error.message;
      } else {
        remember(undefined, saved);
        showProfile(null);
      }
    } finally {
      restoring = false;
      action.disabled = false;
    }
  }

  action.addEventListener('click', () => token ? signOut() : restoreFailed ? restore() : start());
  retry.addEventListener('click', start);
  close.addEventListener('click', cancel);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancel();
  });

  return {
    get token() { return token; },
    start,
    expire() { if (token) signedOut(true); },
    restore,
  };
}
