const CHECK_INTERVAL = 5 * 60_000;
const UPDATE_ID = /^[1-9]\d{0,23}$/;
const MAX_UNREAD = 150;

function newer(id, baseline) {
  return id.length > baseline.length || (id.length === baseline.length && id > baseline);
}

export function monitorBilibiliUpdates({ load, read, write, onChange, onNew }) {
  const initialState = () => ({ enabled: false, baseline: null, unread: [] });
  let state = initialState();
  let accountKey, timer, pending;

  function save() {
    if (accountKey) write(accountKey, JSON.stringify(state));
    onChange(state);
  }

  function cancel() {
    clearTimeout(timer);
    pending?.abort();
    pending = null;
  }

  function observe(items) {
    if (!state.enabled) return;
    const baseline = state.baseline;
    const seen = new Set();
    let newest = baseline ?? '';
    const added = [];
    for (const item of items) {
      const id = item.updateId;
      if (typeof id !== 'string' || !UPDATE_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      if (newer(id, newest)) newest = id;
      if (baseline !== null && newer(id, baseline)) added.push(item);
    }
    if (baseline === newest) return;
    state.baseline = newest;
    state.unread = [...new Set([...added.map(item => item.updateId), ...state.unread])].slice(0, MAX_UNREAD);
    save();
    if (added.length) onNew(added);
  }

  async function check(firstPage) {
    if (!state.enabled || !accountKey || pending) return;
    clearTimeout(timer);
    const request = new AbortController();
    pending = request;
    let delay = CHECK_INTERVAL;
    try {
      let page = firstPage ?? await load(request.signal);
      const baseline = state.baseline;
      const items = [...page.items];
      const cursors = new Set();
      while (pending === request && baseline && page.next && cursors.size < 3 && !cursors.has(page.next) &&
             !page.items.some(item => item.updateId && !newer(item.updateId, baseline))) {
        cursors.add(page.next);
        try {
          page = await load(request.signal, page.next);
          items.push(...page.items);
        } catch (error) {
          if (error.status === 429) delay *= 3;
          break;
        }
      }
      if (pending === request) observe(items);
    } catch (error) {
      if (error.status === 429) delay *= 3;
    } finally {
      if (pending === request) {
        pending = null;
        timer = setTimeout(check, delay);
      }
    }
  }

  return {
    get state() { return state; },
    connect(id) {
      cancel();
      accountKey = 'dsh-bilibili-updates:' + id;
      state = initialState();
      try {
        const stored = JSON.parse(read(accountKey));
        if (stored?.enabled === true) {
          state.enabled = true;
          if (stored.baseline === '' || (typeof stored.baseline === 'string' && UPDATE_ID.test(stored.baseline))) state.baseline = stored.baseline;
          if (Array.isArray(stored.unread)) state.unread = stored.unread.filter(id => typeof id === 'string' && UPDATE_ID.test(id)).slice(0, MAX_UNREAD);
        }
      } catch { /* Invalid local data starts a fresh baseline. */ }
      onChange(state);
      if (state.enabled) void check();
    },
    disconnect() {
      cancel();
      accountKey = null;
      state = initialState();
      onChange(state);
    },
    enable(enabled) {
      if (!accountKey || enabled === state.enabled) return;
      cancel();
      state = { ...initialState(), enabled };
      save();
      if (enabled) void check();
    },
    refresh(page) { void check(page); },
    markRead() {
      if (!state.unread.length) return;
      state.unread = [];
      save();
    },
  };
}
