import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const SITE = 'https://music.163.com';
const CLIENT_API = 'https://interfacepc.music.163.com';
const PAGE_SIZE = 24;
const genres = {
  song: { type: 1, items: 'songs', count: 'songCount' },
  playlist: { type: 1000, items: 'playlists', count: 'playlistCount' },
};

export class MusicError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validId(value) {
  const id = String(value ?? '');
  return /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
}

function idOf(value) {
  const id = validId(value);
  if (!id) throw new MusicError(400, '无效的网易云音乐 ID。');
  return id;
}

function offsetOf(value) {
  if (value == null) return 0;
  if (!/^\d{1,7}$/.test(String(value)) || Number(value) > 1_000_000) {
    throw new MusicError(400, '无效的分页位置。');
  }
  return Number(value);
}

export function cdnUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !/^[a-z0-9-]+\.music\.126\.net$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

const array = value => Array.isArray(value) ? value : [];
const str = value => typeof value === 'string' ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function song(item) {
  const id = validId(item?.id);
  if (!id) return null;
  const album = item.al ?? item.album;
  return {
    id, title: str(item.name) || '歌曲暂不可用',
    artists: array(item.ar ?? item.artists).map(artist => str(artist?.name)).filter(Boolean).join(' / '),
    album: str(album?.name), cover: cdnUrl(album?.picUrl), duration: count(item.dt ?? item.duration),
  };
}

function playlist(item) {
  const id = validId(item?.id);
  if (!id) return null;
  return {
    id, title: str(item.name) || '未命名歌单',
    owner: str(item.creator?.nickname), count: count(item.trackCount),
    cover: cdnUrl(item.coverImgUrl ?? item.picUrl),
  };
}

export function createMusicService(fetcher = globalThis.fetch) {
  const deviceId = randomBytes(26).toString('hex').toUpperCase();

  async function request(path, params, { cookies, allowed = [200], signedIn = false, loginStep, useClientApi = false } = {}) {
    const url = new URL(useClientApi ? path.replace('/api/', '/eapi/') : path, useClientApi ? CLIENT_API : SITE);
    const init = {
      redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { referer: SITE + '/', 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
    };
    if (useClientApi) {
      Object.assign(init, clientLoginRequest(path, params, deviceId));
    } else {
      url.search = new URLSearchParams(params);
      if (cookies?.size) init.headers.cookie = [...cookies].map(([name, value]) => name + '=' + value).join('; ');
    }
    let response;
    let data;
    try {
      response = await fetcher(url, init);
      if (signedIn && response.status === 401) throw new MusicError(401, '登录已失效，请重新扫码。');
      if ([429, 460].includes(response.status)) throw new MusicError(503, '网易云暂时限制了请求，请稍后重试。');
      if (loginStep && !response.ok) throw new MusicError(502, '网易云未能' + loginStep + '（HTTP ' + response.status + '）。');
      if (!response.ok) throw new MusicError(502, '网易云暂时无法响应，请稍后重试。');
      data = await response.json();
    } catch (error) {
      if (error instanceof MusicError) throw error;
      throw new MusicError(502, loginStep ? '暂时无法' + loginStep + '，请检查网络后重试。' : '无法连接网易云音乐，请检查网络后重试。');
    }
    const code = Number(data?.code);
    if (allowed.includes(code)) {
      if (cookies && (!useClientApi || code === 803)) receiveCookies(cookies, response.headers.getSetCookie());
      if (signedIn && !cookies.has('MUSIC_U')) throw new MusicError(401, '登录已失效，请重新扫码。');
      return data;
    }
    if (signedIn && [301, 401].includes(code)) throw new MusicError(401, '登录已失效，请重新扫码。');
    if (loginStep) {
      const detail = Number.isSafeInteger(code) ? '（网易云 ' + code + '）' : '';
      throw new MusicError(502, '暂时无法' + loginStep + detail + '，请稍后重试。');
    }
    if ([301, 401, 403, 404, -110].includes(code)) {
      throw new MusicError(404, '内容不存在，或游客没有访问权限。');
    }
    if ([429, 405, 460, -460].includes(code)) throw new MusicError(503, '网易云暂时限制了请求，请稍后重试。');
    throw new MusicError(502, '网易云暂时未返回可用数据，请稍后重试。');
  }

  async function details(ids, options) {
    const data = await request('/api/v3/song/detail', {
      c: JSON.stringify(ids.map(id => ({ id: Number(id) }))),
    }, options);
    const entries = array(data.songs).map(song).filter(Boolean);
    return new Map(entries.map(entry => [entry.id, entry]));
  }

  return {
    async recommendations() {
      const data = await request('/api/personalized/playlist', { limit: 16 });
      if (!Array.isArray(data.result)) throw new MusicError(502, '网易云暂时没有返回推荐歌单。');
      return { items: data.result.map(playlist).filter(Boolean), next: null };
    },

    async loginStart() {
      const data = await request('/api/login/qrcode/unikey', { type: 3 }, { loginStep: '生成二维码', useClientApi: true });
      if (typeof data.unikey !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(data.unikey)) {
        throw new MusicError(502, '网易云暂时没有提供登录二维码。');
      }
      const url = new URL('/login', SITE);
      url.searchParams.set('codekey', data.unikey);
      return { key: data.unikey, url: url.href };
    },

    async loginPoll(key) {
      const cookies = new Map();
      const data = await request('/api/login/qrcode/client/login', { key, type: 3 }, {
        cookies, allowed: [800, 801, 802, 803], loginStep: '检查扫码状态', useClientApi: true,
      });
      if (Number(data.code) === 803) {
        if (!cookies.has('MUSIC_U')) throw new MusicError(401, '网易云没有完成登录，请重新扫码。');
        return { state: 'confirming', credentials: cookies };
      }
      return { state: { 800: 'expired', 801: 'waiting', 802: 'confirming' }[data.code] };
    },

    async profile(cookies) {
      const data = await request('/api/nuser/account/get', {}, { cookies, signedIn: true, loginStep: '读取登录账号' });
      const id = validId(data.profile?.userId);
      if (!id) throw new MusicError(401, '登录已失效，请重新扫码。');
      return { id, name: str(data.profile.nickname) || '网易云用户' };
    },

    async myPlaylists({ offset }, { profile, credentials: cookies }) {
      offset = offsetOf(offset);
      const data = await request('/api/user/playlist', { uid: profile.id, limit: PAGE_SIZE, offset }, {
        cookies, signedIn: true,
      });
      if (!Array.isArray(data.playlist)) throw new MusicError(502, '网易云暂时没有返回歌单。');
      const items = data.playlist.map(playlist).filter(Boolean);
      return { items, next: data.more && data.playlist.length ? offset + data.playlist.length : null };
    },

    async search({ query, kind, offset }) {
      query = str(query).trim();
      const spec = Object.hasOwn(genres, kind) ? genres[kind] : null;
      if (!spec || !query || query.length > 100) throw new MusicError(400, '请输入 1–100 个字符的搜索关键词。');
      offset = offsetOf(offset);
      const { result } = await request('/api/cloudsearch/pc', {
        s: query, type: spec.type, offset, limit: PAGE_SIZE, total: true,
      });
      const records = array(result?.[spec.items]);
      const items = records.map(kind === 'song' ? song : playlist).filter(Boolean);
      const next = offset + records.length;
      return { items, next: records.length && next < count(result?.[spec.count]) ? next : null };
    },

    async playlist({ id, offset }, account) {
      id = idOf(id);
      offset = offsetOf(offset);
      const options = account ? { cookies: account.credentials, signedIn: true } : undefined;
      const data = await request('/api/v6/playlist/detail', { id, n: PAGE_SIZE }, options);
      const source = data.playlist;
      const info = playlist(source);
      if (!info || info.id !== id) throw new MusicError(404, '找不到该公开歌单。');
      info.description = str(source.description).slice(0, 700);
      const embedded = new Map(array(source.tracks).map(song).filter(Boolean).map(item => [item.id, item]));
      const ids = array(source.trackIds ?? source.tracks).slice(offset, offset + PAGE_SIZE).map(item => validId(item?.id));
      const missing = [...new Set(ids.filter(id => id && !embedded.has(id)))];
      const found = missing.length ? await details(missing, options) : new Map();
      const items = ids.flatMap(id => {
        if (!id) return [];
        return [embedded.get(id) ?? found.get(id) ?? { ...song({ id }), missing: true }];
      });
      const next = offset + ids.length;
      const total = array(source.trackIds ?? source.tracks).length;
      return { playlist: info, items, next: next < total ? next : null };
    },

    async lyrics({ id }) {
      const data = await request('/api/song/lyric', { id: idOf(id), lv: 1, tv: -1 });
      return { original: str(data.lrc?.lyric), translation: str(data.tlyric?.lyric) };
    },

    async stream({ id }, account) {
      id = idOf(id);
      const data = await request('/api/song/enhance/player/url/v1', {
        ids: JSON.stringify([Number(id)]), level: 'standard', encodeType: 'mp3',
      }, account ? { cookies: account.credentials, signedIn: true } : undefined);
      const track = array(data.data).find(item => validId(item?.id) === id);
      const url = cdnUrl(track?.url);
      if (Number(track?.code) !== 200 || !url || track.freeTrialInfo != null ||
          track.freeTrialPrivilege?.cannotListenReason != null) {
        throw new MusicError(404, '当前无法完整播放这首歌。可以在网易云音乐中打开。');
      }
      return { url };
    },
  };
}

function clientLoginRequest(path, params, deviceId) {
  const now = Date.now();
  // These are client identifiers. QR polling starts without guest or account cookies.
  const client = {
    os: 'pc', osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    appver: '3.1.17.204416', versioncode: '140', deviceId, mobilename: '',
    channel: 'netease', resolution: '1920x1080', buildver: String(Math.floor(now / 1000)),
    requestId: now + '_' + String(randomBytes(2).readUInt16BE() % 1000).padStart(4, '0'), __csrf: '',
  };
  const json = JSON.stringify({ ...params, header: client, e_r: false });
  const digest = createHash('md5').update('nobody' + path + 'use' + json + 'md5forencrypt').digest('hex');
  // Fixed protocol key. No user data is used to construct the QR requests.
  const cipher = createCipheriv('aes-128-ecb', 'e82ckenh8dichen8', null);
  const input = [path, json, digest].join('-36cd479b6b5-');
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]).toString('hex').toUpperCase();
  return {
    method: 'POST',
    headers: {
      referer: SITE + '/',
      'user-agent': 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: Object.entries(client).map(([key, value]) => key + '=' + encodeURIComponent(value)).join('; '),
    },
    body: new URLSearchParams({ params: encrypted }),
  };
}

function receiveCookies(cookies, headers) {
  for (const header of headers) {
    const [pair, ...attributes] = header.split(';');
    const equals = pair.indexOf('=');
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    if (!['MUSIC_U', '__csrf', 'NMTID'].includes(name)) continue;
    const value = pair.slice(equals + 1).trim();
    const maxAge = attributes.map(part => /^\s*max-age=(-?\d+)$/i.exec(part)).find(Boolean);
    const expires = attributes.map(part => /^\s*expires=(.+)$/i.exec(part)).find(Boolean);
    const expired = maxAge ? Number(maxAge[1]) <= 0 : expires && Date.parse(expires[1]) <= Date.now();
    if (!value || expired) cookies.delete(name);
    else if (/^[!-~]{1,4096}$/.test(value) && !/[,;"\\]/.test(value)) cookies.set(name, value);
  }
}
