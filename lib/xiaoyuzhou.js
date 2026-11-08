import { randomUUID } from 'node:crypto';
import { MusicError } from './netease.js';
import { parseShare } from '../web/links.js';

const SITE = 'https://www.xiaoyuzhoufm.com';
const INDEX = 'https://xyzrank.top';
const WEB_API = 'https://web-api.xiaoyuzhoufm.com';
const APP_API = 'https://api.xiaoyuzhoufm.com';
const ACCOUNT_ORIGIN = 'https://accounts.xiaoyuzhoufm.com';
const ID = /^[a-f0-9]{24}$/;
const EPISODE_BATCH = 30;
const MAX_PAGE_BYTES = 5_000_000;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9',
};

const array = value => Array.isArray(value) ? value : [];
const str = value => typeof value === 'string' ? value.trim() : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function idOf(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new MusicError(400, '无效的小宇宙节目或单集链接。');
  return value;
}

function enabled(value) {
  if (!['true', 'false'].includes(value)) throw new MusicError(400, '无效的小宇宙操作。');
  return value === 'true';
}

function subscriptionStatus(show) {
  return show.subscriptionStatus === 'ON' ? true : show.subscriptionStatus === 'OFF' ? false : undefined;
}

function cdnUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !/^[a-z0-9-]+\.xyzcdn\.net$/.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function scripts(html, pattern) {
  return [...html.matchAll(pattern)].flatMap(match => {
    try {
      const value = JSON.parse(match[1]);
      return Array.isArray(value) ? value : [value];
    } catch {
      return [];
    }
  });
}

function toPlainText(value) {
  return str(value)
    .replace(/<(?:br\s*\/?|\/p|\/li|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
    })[entity])
    .trim();
}

function showInfo(show) {
  return {
    id: show.pid, title: str(show.title) || '未命名节目', owner: str(show.author),
    count: count(show.episodeCount), cover: cdnUrl(show.image?.picUrl),
    description: toPlainText(show.description || show.brief).slice(0, 1200),
    subscribed: subscriptionStatus(show),
    url: SITE + '/podcast/' + show.pid,
  };
}

function restricted(episode) {
  return episode.isPrivateMedia === true || !!(episode.payType && episode.payType !== 'FREE') ||
    !!(episode.status && episode.status !== 'NORMAL');
}

function publicAudio(episode) {
  if (restricted(episode)) return null;
  return cdnUrl(episode.media?.source?.url) ?? cdnUrl(episode.enclosure?.url);
}

function episodeInfo(episode, show) {
  return {
    id: episode.eid, title: str(episode.title) || '未命名单集', artists: str(show?.title),
    album: str(episode.pubDate).slice(0, 10), duration: count(episode.duration) * 1000,
    cover: cdnUrl(episode.image?.picUrl) ?? cdnUrl(show?.image?.picUrl),
    missing: restricted(episode), url: SITE + '/episode/' + episode.eid,
    favorited: typeof episode.isFavorited === 'boolean' ? episode.isFavorited : undefined,
  };
}

function indexItems(html) {
  const lists = scripts(html, /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
    .filter(item => item?.['@type'] === 'ItemList');
  if (!lists.length) throw new MusicError(502, '播客目录暂时无法读取。仍可粘贴小宇宙分享链接。');
  const seen = new Set();
  return lists.flatMap(list => array(list.itemListElement)).flatMap(entry => {
    const item = entry?.item ?? entry;
    const id = /^https:\/\/xyzrank\.top\/podcast\/([a-f0-9]{24})(?:[?#].*)?$/.exec(str(item?.url))?.[1];
    const title = str(item?.name);
    if (!id || !title || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title, owner: str(item.author?.name), count: count(item.numberOfEpisodes), cover: cdnUrl(item.image),
      url: SITE + '/podcast/' + id }];
  });
}

function readCursor(value) {
  if (!value || value === '0') return undefined;
  try {
    if (value.length > 2048) throw new Error();
    const cursor = JSON.parse(value);
    if (typeof cursor === 'string' || (cursor && typeof cursor === 'object' && !Array.isArray(cursor))) return cursor;
  } catch { /* Invalid cursors cannot become app API parameters. */ }
  throw new MusicError(400, '无效的小宇宙分页位置。');
}

function appPage(response, previousCursor) {
  const page = Array.isArray(response.data) ? response : response.data;
  if (!Array.isArray(page?.data)) throw new MusicError(502, '小宇宙未返回可读取的列表。');
  const next = page.loadMoreKey ? JSON.stringify(page.loadMoreKey) : null;
  return { entries: page.data, next: page.data.length && next !== previousCursor && next?.length <= 2048 ? next : null };
}

function episodePage(response, cursor, favorite = false) {
  const { entries, next } = appPage(response, cursor);
  const items = entries.map(entry => entry?.episode ?? entry).filter(entry => ID.test(str(entry?.eid)))
    .map(entry => episodeInfo(entry, entry.podcast));
  if (favorite) for (const item of items) item.favorited = true;
  return { items, next };
}

export function createPodcastService(fetcher = globalThis.fetch) {
  const device = randomUUID().toUpperCase();
  const refreshes = new WeakMap();
  const qrHeaders = {
    accept: 'application/json', 'content-type': 'application/json;charset=UTF-8',
    'user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    origin: ACCOUNT_ORIGIN, referer: ACCOUNT_ORIGIN + '/', 'x-midway-app-id': 'v6worU4NnWyL',
  };
  const appHeaders = {
    'user-agent': 'Xiaoyuzhou/2.57.1 (build:1576; iOS 17.4.1)',
    os: 'ios', manufacturer: 'Apple', model: 'iPhone14,2', bundleid: 'app.podcast.cosmos',
    'app-version': '2.57.1', 'app-buildno': '1576', market: 'AppStore',
    accept: 'application/json', 'content-type': 'application/json',
    'accept-language': 'zh-Hans-CN;q=1.0',
  };
  const deviceHeaders = credentials => ({ ...appHeaders, 'x-jike-device-id': credentials.device ?? device });

  async function json(origin, path, headers, body) {
    try {
      const response = await fetcher(origin + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(8500),
      });
      const data = await response.json().catch(() => null);
      return { response, data };
    } catch {
      throw new MusicError(502, '无法连接小宇宙，请检查网络后重试。');
    }
  }

  function checkResponse({ response, data }) {
    if (response.status === 401) throw new MusicError(401, '小宇宙登录已失效，请重新扫码。');
    if (response.status === 429) throw new MusicError(429, '小宇宙暂时限制了请求，请稍后重试。');
    if (!response.ok || !data) throw new MusicError(502, '小宇宙暂时没有返回可用数据，请稍后重试。');
    return data;
  }

  async function refresh({ credentials, saveCredentials }) {
    if (!credentials.refresh) throw new MusicError(401, '小宇宙登录已失效，请重新扫码。');
    const pending = refreshes.get(credentials);
    if (pending) return pending;
    const renewing = (async () => {
      const result = await json(APP_API, '/app_auth_tokens.refresh', {
        ...deviceHeaders(credentials), 'x-jike-refresh-token': credentials.refresh,
      }, {});
      const data = checkResponse(result);
      const access = result.response.headers.get('x-jike-access-token') ?? data['x-jike-access-token'] ?? data.data?.['x-jike-access-token'];
      const refreshToken = result.response.headers.get('x-jike-refresh-token') ?? data['x-jike-refresh-token'] ?? data.data?.['x-jike-refresh-token'];
      if (!access) throw new MusicError(401, '小宇宙登录已失效，请重新扫码。');
      credentials.access = access;
      if (refreshToken) credentials.refresh = refreshToken;
      saveCredentials?.();
    })().finally(() => { refreshes.delete(credentials); });
    refreshes.set(credentials, renewing);
    await renewing;
  }

  async function appRequest(path, body, account) {
    const { credentials } = account;
    const access = credentials.access;
    const request = () => json(APP_API, path, { ...deviceHeaders(credentials), 'x-jike-access-token': credentials.access }, body);
    const result = await request();
    if (result.response.status !== 401) return checkResponse(result);
    if (credentials.access === access) await refresh(account);
    return checkResponse(await request());
  }

  async function accountDetail(type, id, account) {
    const key = type === 'podcast' ? 'pid' : 'eid';
    const { data } = await appRequest('/v1/' + type + '/get?' + key + '=' + idOf(id), undefined, account);
    if (data?.[key] !== id) throw new MusicError(502, '小宇宙未返回该' + (type === 'podcast' ? '节目' : '单集') + '的详情。');
    return data;
  }

  async function page(url, source) {
    let response;
    try {
      response = await fetcher(url, { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(8500) });
    } catch {
      throw new MusicError(502, '无法连接' + source + '，请检查网络后重试。');
    }
    if (response.status === 404 && source === '小宇宙') throw new MusicError(404, '这条小宇宙链接无法打开。');
    if (!response.ok) throw new MusicError(502, source + '暂时无法访问，请稍后重试。');
    try {
      if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES) throw new Error();
      const body = await response.text();
      if (body.length > MAX_PAGE_BYTES) throw new Error();
      return body;
    } catch {
      throw new MusicError(502, '暂时无法读取' + source + '页面。');
    }
  }

  async function details(type, id) {
    const html = await page(SITE + '/' + type + '/' + idOf(id), '小宇宙');
    const data = scripts(html, /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)[0]?.props?.pageProps;
    const item = data?.[type];
    if (item?.[type === 'podcast' ? 'pid' : 'eid'] !== id) {
      throw new MusicError(404, '小宇宙暂时未公开这条节目或单集。');
    }
    return item;
  }

  return {
    async loginStart() {
      const data = checkResponse(await json(WEB_API, '/v1/auth/qrcode/create', qrHeaders, { clientId: 'xyz-web' }));
      const key = idOf(data.id);
      const url = new URL('/oauth', 'https://h5.xiaoyuzhoufm.com');
      url.searchParams.set('qrcode_id', key);
      if (data.url) {
        try {
          const link = new URL(data.url);
          if (link.origin === url.origin && !link.username && !link.password &&
              link.pathname === '/oauth' && link.searchParams.get('qrcode_id') === key) return { key, url: link.href };
        } catch { /* The canonical QR URL can be reconstructed from the ID. */ }
      }
      return { key, url: url.href };
    },

    async loginPoll(key) {
      const result = await json(WEB_API, '/v1/auth/qrcode/login', qrHeaders, { id: idOf(key) });
      if ([400, 401, 404].includes(result.response.status)) return { state: 'expired' };
      const data = checkResponse(result);
      if (data.status === 'EXPIRED') return { state: 'expired' };
      if (data.status === 'SCANNED') return { state: 'confirming' };
      if (['WAITTING', 'WAITING'].includes(data.status)) return { state: 'waiting' };
      const access = result.response.headers.get('x-jike-access-token');
      const refreshToken = result.response.headers.get('x-jike-refresh-token');
      if (['USED', 'CONFIRMED'].includes(data.status) && access) {
        return { state: 'confirming', credentials: { access, refresh: refreshToken, device } };
      }
      throw new MusicError(502, '小宇宙未完成扫码授权，请刷新二维码后重试。');
    },

    async profile(credentials) {
      const data = checkResponse(await json(WEB_API, '/web/user/get-me', {
        accept: 'application/json', 'user-agent': qrHeaders['user-agent'],
        origin: SITE, referer: SITE + '/', 'x-jike-access-token': credentials.access,
      }));
      const profile = data.data;
      if (!str(profile?.uid)) throw new MusicError(401, '未能读取小宇宙账号，请重新扫码。');
      return { id: profile.uid, name: str(profile.nickname) || '小宇宙用户' };
    },

    async subscriptions({ cursor }, account) {
      const data = await appRequest('/v1/subscription/list', {
        sortBy: 'subscribedAt', loadMoreKey: readCursor(cursor),
      }, account);
      const { entries, next } = appPage(data, cursor);
      return { items: entries.filter(item => ID.test(str(item?.pid))).map(showInfo), next };
    },

    async updates({ cursor }, account) {
      const response = await appRequest('/v1/inbox/list', { limit: '20', loadMoreKey: readCursor(cursor) }, account);
      return episodePage(response, cursor);
    },

    async favorites({ cursor }, account) {
      const response = await appRequest('/v1/favorite/list', { loadMoreKey: readCursor(cursor) }, account);
      return episodePage(response, cursor, true);
    },

    async subscribe(id, value, account) {
      const pid = idOf(id);
      const subscribed = enabled(value);
      const { data } = await appRequest('/v1/subscription/update', { pid, mode: subscribed ? 'ON' : 'OFF' }, account);
      if (data?.pid !== pid || subscriptionStatus(data) !== subscribed) {
        throw new MusicError(502, '小宇宙未确认订阅状态，请刷新后重试。');
      }
      return { subscribed };
    },

    async favorite(id, value, account) {
      const eid = idOf(id);
      const favorited = enabled(value);
      const result = await appRequest('/v1/favorite/update', { eid, favorited, sourcePageName: 8, currentPageName: 9 }, account);
      if (typeof result !== 'object' || Array.isArray(result) || (Object.keys(result).length && result.data?.isFavorited !== favorited)) {
        throw new MusicError(502, '小宇宙未确认收藏状态，请刷新后重试。');
      }
      return { favorited };
    },

    async playbackList(account) {
      // With no previous revision, the app requests a complete snapshot.
      // The mobile client's playlist adapter discriminates on "kind".
      const { data } = await appRequest('/v1/playlist/pull', {}, account);
      if (data?.kind === 'UP_TO_DATE') return { items: [], next: null };
      if (data?.kind !== 'FULL_LIST' || !Array.isArray(data.list)) {
        throw new MusicError(502, '小宇宙未返回完整的播放列表，请重新同步。');
      }
      const ids = [...new Set(data.list.filter(id => typeof id === 'string' && ID.test(id)))];
      const episodes = new Map();
      let offset = 0;
      async function readBatch() {
        while (offset < ids.length) {
          const eids = ids.slice(offset, offset + EPISODE_BATCH);
          offset += EPISODE_BATCH;
          const batch = new Set(eids);
          const response = await appRequest('/v1/episode/list-by-ids', { eids }, account);
          if (!Array.isArray(response.data)) throw new MusicError(502, '暂时无法读取播放列表中的单集，请重试。');
          for (const episode of response.data) {
            if (batch.has(episode?.eid)) episodes.set(episode.eid, episodeInfo(episode, episode.podcast));
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, Math.ceil(ids.length / EPISODE_BATCH)) }, readBatch));
      return {
        items: ids.map(id => episodes.get(id) ?? {
          id, title: '单集暂不可用', missing: true, url: SITE + '/episode/' + id,
        }),
        next: null,
      };
    },

    async recommendations() {
      const items = indexItems(await page(INDEX + '/', '播客目录'));
      return { items: items.slice(0, 16), next: null };
    },

    async search({ query, kind, cursor }, account) {
      query = str(query);
      if (!query || query.length > 100) throw new MusicError(400, '请输入 1–100 个字符的节目名称。');
      if (account) {
        const single = kind === 'song';
        const data = await appRequest('/v1/search/create', {
          keyword: query, type: single ? 'EPISODE' : 'PODCAST', loadMoreKey: readCursor(cursor),
        }, account);
        const { entries, next } = appPage(data, cursor);
        const key = single ? 'eid' : 'pid';
        return { items: entries.filter(item => ID.test(str(item?.[key]))).map(item => single ? episodeInfo(item, item.podcast) : showInfo(item)), next };
      }
      const url = new URL(INDEX);
      url.searchParams.set('keyword', query);
      return { items: indexItems(await page(url.href, '播客目录')).slice(0, 50), next: null };
    },

    async show({ id, cursor }, account) {
      idOf(id);
      const [podcast, page] = await Promise.all([
        account ? accountDetail('podcast', id, account) : details('podcast', id),
        account ? appRequest('/v1/episode/list', { pid: id, order: 'desc', loadMoreKey: readCursor(cursor) }, account) : null,
      ]);
      const { entries, next } = page ? appPage(page, cursor) : { entries: array(podcast.episodes), next: null };
      const items = entries.filter(episode => ID.test(str(episode?.eid))).map(episode => episodeInfo(episode, podcast));
      return { playlist: showInfo(podcast), items, next };
    },

    async episode({ id }, account) {
      const episode = account ? await accountDetail('episode', id, account) : await details('episode', id);
      const item = episodeInfo(episode, episode.podcast);
      item.missing = !publicAudio(episode);
      return { playlist: {
        id: item.id, title: item.title, owner: item.artists, cover: item.cover, url: item.url,
        description: toPlainText(episode.description || episode.shownotes).slice(0, 1200),
      }, items: [item], next: null };
    },

    async stream({ id }) {
      const episode = await details('episode', id);
      const url = publicAudio(episode);
      if (!url) throw new MusicError(404, '小宇宙未提供这集的公开音频，可以在原页收听。');
      return { url, notes: toPlainText(episode.shownotes || episode.description).slice(0, 24000) };
    },

    async resolve({ code }) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
        throw new MusicError(400, '无效的小宇宙分享短链接。');
      }
      let url = new URL('/' + code, 'https://xyzfm.link');
      try {
        for (let step = 0; step < 4; step++) {
          const response = await fetcher(url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(5000) });
          void response.body?.cancel().catch(() => {});
          const location = response.headers.get('location');
          if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
          const target = new URL(location, url);
          const link = parseShare(target.href);
          if (link?.source !== 'xiaoyuzhou') break;
          if (link.type !== 'short') return { type: link.type, id: link.id };
          url = new URL('/' + link.code, 'https://xyzfm.link');
        }
      } catch { /* Direct public URLs remain usable when the short-link service is down. */ }
      throw new MusicError(404, '暂时无法打开这个短链接，请粘贴小宇宙节目或单集的完整链接。');
    },
  };
}
