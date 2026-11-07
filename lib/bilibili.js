import { createHash } from 'node:crypto';
import { MusicError } from './netease.js';

const SITE = 'https://www.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const API = 'https://api.bilibili.com';
const NAV = '/x/web-interface/nav';
const DYNAMIC = '/x/polymer/web-dynamic/v1/feed/';
const QR_PATH = '/x/passport-login/web/qrcode/';
const SCAN_URLS = new Set([
  'https://account.bilibili.com/h5/account-h5/auth/scan-web',
  PASSPORT + '/h5-app/passport/login/scan',
]);
const PAGE_SIZE = 20;
const FOLLOW_PAGE_SIZE = 50;
const WBI_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
const HEADERS = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: SITE + '/',
  'accept-language': 'zh-CN,zh;q=0.9',
};

const str = value => typeof value === 'string' ? value.trim() : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const idOf = value => /^[1-9]\d{0,17}$/.test(String(value ?? '')) ? String(value) : '';
const cookieValue = value => typeof value === 'string' && /^[\x21-\x3A\x3C-\x7E]+$/.test(value);

function videoId(id) {
  if (/^BV[a-zA-Z0-9]{10}$/.test(id)) return { bvid: id };
  if (/^av[1-9]\d{0,17}$/.test(id)) return { aid: id.slice(2) };
  throw new MusicError(400, '无效的哔哩哔哩视频编号。');
}

function enabled(value) {
  if (value === '1' || value === '0') return value === '1';
  throw new MusicError(400, '无效的操作状态。');
}

function folderIds(value) {
  const ids = value ? value.split(',') : [];
  if (ids.length > 100 || !ids.every(idOf)) throw new MusicError(400, '无效的哔哩哔哩收藏夹。');
  return [...new Set(ids)];
}

function pageNumber(offset) {
  const page = Number(offset || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new MusicError(400, '无效的哔哩哔哩页码。');
  return page;
}

function dynamicOffset(value) {
  if (!value || value === '0') return undefined;
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f]/.test(value)) {
    throw new MusicError(400, '无效的哔哩哔哩分页位置。');
  }
  return value;
}

function durationMs(value) {
  if (typeof value === 'string' && /^\d{1,3}(?::\d{1,2}){1,2}$/.test(value)) {
    return value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
  }
  return count(value) * 1000;
}

function searchText(value) {
  const entities = { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return str(value).replace(/<\/?em\b[^>]*>/gi, '').replace(/&(amp|quot|#39|apos|lt|gt|nbsp);/g, (_, key) => entities[key]);
}

function cover(value) {
  try {
    const url = new URL(str(value), SITE);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      /^[a-z0-9-]+\.(?:hdslb\.com|biliimg\.com)$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function video(item, favorite = false) {
  if (!item || (favorite && item.type !== undefined && item.type !== 2)) return null;
  const bvid = /^BV[a-zA-Z0-9]{10}$/.test(item.bvid) ? item.bvid : null;
  const aid = idOf(item.aid ?? item.id);
  const id = bvid ?? (aid ? 'av' + aid : null);
  if (!id) return null;
  return {
    id, aid: aid || null, title: str(item.title) || '未命名视频',
    owner: str(item.upper?.name ?? item.owner?.name ?? item.author), cover: cover(item.cover ?? item.pic),
    ownerId: idOf(item.upper?.mid ?? item.owner?.mid ?? item.mid) || null,
    duration: durationMs(item.duration),
    published: count(Number(item.pubdate ?? item.pubtime ?? item.pub_ts)),
    url: SITE + '/video/' + id + '/',
  };
}

function list(value, empty, label) {
  if (Array.isArray(value)) return value;
  if (value == null && empty) return [];
  throw new MusicError(502, '哔哩哔哩未返回可读取的' + label + '。');
}

function creator(item) {
  const id = idOf(item?.mid);
  if (!id) return null;
  return { id, title: searchText(item.uname ?? item.name) || '未命名 UP 主',
    cover: cover(item.face ?? item.upic), description: str(item.sign).slice(0, 200),
    url: 'https://space.bilibili.com/' + id + '/video' };
}

function dynamicPage(data, offset) {
  const entries = list(data?.items, data?.has_more === false, '投稿列表');
  const next = typeof data.offset === 'string' && data.offset && data.offset !== offset &&
    data.offset.length <= 1024 && !/[\u0000-\u001f]/.test(data.offset) ? data.offset : null;
  const items = entries.flatMap(entry => {
    if (entry?.type !== 'DYNAMIC_TYPE_AV') return [];
    const author = entry.modules?.module_author;
    const archive = entry.modules?.module_dynamic?.major?.archive;
    const item = archive && video({ ...archive, author: author?.name, mid: author?.mid,
      pub_ts: author?.pub_ts, duration: archive.duration_text });
    if (!item) return [];
    return [{ ...item,
      updateId: /^[1-9]\d{0,23}$/.test(entry.id_str) ? entry.id_str : null }];
  });
  return { items, next: entries.length && data.has_more === true ? next : null };
}

export function createBilibiliService(fetcher = globalThis.fetch) {
  let wbiKey, visitorCookie;

  async function request(origin, path, params, credentials, options = {}) {
    const url = new URL(path, origin);
    if (params) url.search = typeof params === 'string' ? params : new URLSearchParams(params).toString();
    const headers = { ...HEADERS };
    if (options.referer) headers.referer = options.referer;
    if (origin === API) {
      const cookies = [];
      if (credentials) cookies.push('SESSDATA=' + credentials.sessdata);
      if (options.body) cookies.push('bili_jct=' + credentials.csrf);
      if (options.visitor) cookies.push(await getVisitorCookie());
      if (cookies.length) headers.cookie = cookies.join('; ');
    }
    let response, body;
    try {
      if (options.body) headers.origin = SITE;
      response = await fetcher(url, {
        headers, redirect: 'error', signal: AbortSignal.timeout(8500),
        method: options.body ? 'POST' : 'GET', body: options.body,
      });
      body = await response.json().catch(() => null);
    } catch {
      throw new MusicError(502, '无法连接哔哩哔哩，请检查网络后重试。');
    }
    if (response.ok && path === NAV && !credentials && body?.code === -101 && body.data?.wbi_img) {
      return { data: body.data, response };
    }
    if (response.status === 401 || body?.code === -101) {
      throw new MusicError(401, '哔哩哔哩登录已失效，请重新扫码。');
    }
    if (options.body && body?.code === -111) {
      throw new MusicError(403, '哔哩哔哩未能验证本次操作，请退出 B 站账号并重新扫码。');
    }
    if ([412, 429].includes(response.status) || [-352, -412, -509].includes(body?.code)) {
      throw new MusicError(429, '哔哩哔哩暂时限制了请求，请稍后重试。');
    }
    if (!response.ok || body?.code !== 0) {
      throw new MusicError(502, '哔哩哔哩暂时没有返回可用数据，请稍后重试。');
    }
    return { data: body.data, response };
  }

  function rememberWbiKey(data) {
    const names = [data?.wbi_img?.img_url, data?.wbi_img?.sub_url].map(value =>
      /^https:\/\/[a-z0-9.-]+\/.*\/([a-f0-9]{32})\.[a-z]+$/i.exec(str(value))?.[1]);
    if (names.some(name => !name)) return;
    const source = names.join('');
    wbiKey = { value: WBI_ORDER.map(index => source[index]).join(''), expires: Date.now() + 30 * 60_000 };
  }

  async function signWbi(params) {
    if (!wbiKey || wbiKey.expires <= Date.now()) rememberWbiKey((await request(API, NAV)).data);
    if (!wbiKey || wbiKey.expires <= Date.now()) throw new MusicError(502, '暂时无法读取哔哩哔哩网页签名。');
    const fields = { ...params, wts: Math.floor(Date.now() / 1000) };
    const query = Object.keys(fields).sort().map(key =>
      encodeURIComponent(key) + '=' + encodeURIComponent(String(fields[key]).replace(/[!'()*]/g, ''))).join('&');
    return query + '&w_rid=' + createHash('md5').update(query + wbiKey.value).digest('hex');
  }

  async function getVisitorCookie() {
    if (visitorCookie && visitorCookie.expires > Date.now()) return visitorCookie.value;
    const { data } = await request(API, '/x/frontend/finger/spi');
    if (!cookieValue(data?.b_3) || !cookieValue(data?.b_4)) {
      throw new MusicError(502, '哔哩哔哩未返回可用的网页访客标识。');
    }
    const value = 'buvid3=' + data.b_3 + '; buvid4=' + data.b_4;
    visitorCookie = { value, expires: Date.now() + 12 * 60 * 60_000 };
    return value;
  }

  async function write(path, fields, { credentials }) {
    if (!credentials.csrf) throw new MusicError(403, '请退出 B 站账号并重新扫码，以使用账号操作。');
    return request(API, path, null, credentials, { body: new URLSearchParams({ ...fields, csrf: credentials.csrf }) });
  }

  async function archiveAid(id, credentials) {
    const params = videoId(id);
    if (params.aid) return params.aid;
    const { data } = await request(API, '/x/web-interface/view', params, credentials);
    const aid = idOf(data?.aid);
    if (!aid) throw new MusicError(502, '哔哩哔哩未返回可用的视频编号。');
    return aid;
  }

  async function ownedFolders({ profile, credentials }, aid) {
    const params = { up_mid: profile.id };
    if (aid) Object.assign(params, { rid: aid, type: 2 });
    const { data } = await request(API, '/x/v3/fav/folder/created/list-all', params, credentials);
    return list(data?.list, data?.count === 0, '收藏夹').flatMap(item => {
      const id = idOf(item?.id);
      if (aid && id && ![0, 1, false, true].includes(item.fav_state)) {
        throw new MusicError(502, '暂时无法读取这个视频在收藏夹里的状态。');
      }
      return id ? [{ id, title: str(item.title) || '未命名收藏夹', count: count(item.media_count), cover: cover(item.cover),
        ...(aid ? { selected: item.fav_state === 1 || item.fav_state === true } : {}) }] : [];
    });
  }

  async function relationAttribute(fid, credentials) {
    const { data } = await request(API, '/x/relation', { fid }, credentials);
    if (!Number.isInteger(data?.attribute)) throw new MusicError(502, '暂时无法读取这个 UP 主的关注状态。');
    return data.attribute;
  }

  return {
    async loginStart() {
      const { data } = await request(PASSPORT, QR_PATH + 'generate');
      const key = str(data?.qrcode_key);
      let url;
      try { url = new URL(data.url); } catch { /* Reject invalid QR URLs below. */ }
      if (!/^[a-zA-Z0-9]{32}$/.test(key) || !url || url.username || url.password ||
          !SCAN_URLS.has(url.origin + url.pathname) || url.searchParams.get('qrcode_key') !== key) {
        throw new MusicError(502, '哔哩哔哩未返回有效的登录二维码。');
      }
      return { key, url: url.href };
    },

    async loginPoll(key) {
      const { data, response } = await request(PASSPORT, QR_PATH + 'poll', { qrcode_key: key });
      if (data?.code === 86101) return { state: 'waiting' };
      if (data?.code === 86090) return { state: 'confirming' };
      if (data?.code === 86038) return { state: 'expired' };
      if (data?.code === 0) {
        const cookies = response.headers.getSetCookie();
        const sessdata = cookies.map(value => /^SESSDATA=([^;]+)/.exec(value)?.[1]).find(Boolean);
        const csrf = cookies.map(value => /^bili_jct=([a-f0-9]{32})(?:;|$)/i.exec(value)?.[1]).find(Boolean);
        if (cookieValue(sessdata)) {
          return { state: 'confirming', credentials: { sessdata, csrf } };
        }
      }
      throw new MusicError(502, '哔哩哔哩未完成扫码授权，请刷新二维码后重试。');
    },

    async profile(credentials) {
      const { data } = await request(API, NAV, null, credentials);
      const id = idOf(data?.mid);
      if (!data?.isLogin || !id) throw new MusicError(401, '未能读取哔哩哔哩账号，请重新扫码。');
      rememberWbiKey(data);
      credentials.vip = data.vipStatus === 1 || data.vip?.status === 1;
      return { id, name: str(data.uname) || '哔哩哔哩用户' };
    },

    async favorites(account) {
      return { items: await ownedFolders(account), next: null };
    },

    async videoRelation(id, { credentials }) {
      const { data } = await request(API, '/x/web-interface/archive/relation', videoId(id), credentials);
      if (typeof data?.like !== 'boolean' || typeof data.favorite !== 'boolean') {
        throw new MusicError(502, '暂时无法读取这个视频的互动状态。');
      }
      return { liked: data.like, favorite: data.favorite };
    },

    async videoFolders(id, account) {
      const aid = await archiveAid(id, account.credentials);
      return { aid, items: await ownedFolders(account, aid) };
    },

    async likeVideo(id, value, account) {
      const liked = enabled(value);
      await write('/x/web-interface/archive/like', { ...videoId(id), like: liked ? 1 : 2 }, account);
      return { liked };
    },

    async saveVideo(id, added, removed, account) {
      const add = folderIds(added);
      const remove = folderIds(removed);
      if (add.some(id => remove.includes(id))) throw new MusicError(400, '同一收藏夹不能同时添加和移除视频。');
      if (!add.length && !remove.length) throw new MusicError(400, '请选择要修改的收藏夹。');
      const aid = await archiveAid(id, account.credentials);
      await write('/x/v3/fav/resource/deal', { rid: aid, type: 2, platform: 'web',
        add_media_ids: add.join(','), del_media_ids: remove.join(',') }, account);
      return { ok: true };
    },

    async creatorRelation(id, { profile, credentials }) {
      const fid = idOf(id);
      if (!fid) throw new MusicError(400, '无效的哔哩哔哩 UP 主。');
      if (fid === profile.id) return { following: false, self: true };
      return { following: [1, 2, 6].includes(await relationAttribute(fid, credentials)), self: false };
    },

    async followCreator(id, value, account) {
      const fid = idOf(id);
      if (!fid || fid === account.profile.id) throw new MusicError(400, '无效的哔哩哔哩 UP 主。');
      const following = enabled(value);
      const attribute = following ? null : await relationAttribute(fid, account.credentials);
      if (!following && ![1, 2, 6].includes(attribute)) return { following: false };
      const act = following ? 1 : attribute === 1 ? 4 : 2;
      await write('/x/relation/modify', { fid, act, re_src: 17, cross_domain: true, gaia_source: 'main_web' }, account);
      return { following };
    },

    async favoriteFolder({ id, offset }, { credentials }) {
      const page = Number(offset || 1);
      if (!idOf(id) || !Number.isSafeInteger(page) || page < 1 || page > 10_000) {
        throw new MusicError(400, '无效的哔哩哔哩收藏夹或页码。');
      }
      const { data } = await request(API, '/x/v3/fav/resource/list', { media_id: id, pn: page, ps: PAGE_SIZE, platform: 'web' }, credentials);
      const { info } = data ?? {};
      const entries = list(data?.medias, info?.media_count === 0, '收藏视频');
      return {
        playlist: {
          id, title: str(info?.title) || '收藏夹', owner: str(info?.upper?.name),
          cover: cover(info?.cover), description: str(info?.intro).slice(0, 1200),
        },
        items: entries.map(item => video(item, true)).filter(Boolean),
        next: entries.length && data.has_more === true ? page + 1 : null,
      };
    },

    async watchLater({ credentials }) {
      const { data } = await request(API, '/x/v2/history/toview/web', null, credentials);
      return {
        items: list(data?.list, data?.count === 0, '稍后再看列表').map(item => video(item)).filter(Boolean),
        next: null,
      };
    },

    async playback(id, account) {
      const params = videoId(id);
      const credentials = account?.credentials;
      const { data: detail } = await request(API, '/x/web-interface/view', params, credentials);
      const cid = idOf(detail?.cid ?? detail?.pages?.[0]?.cid);
      const aid = idOf(detail?.aid);
      if (!cid || !aid || detail?.redirect_url) throw new MusicError(404, '这个视频需要在哔哩哔哩原页播放。');
      const referer = SITE + '/video/' + id + '/';
      const query = await signWbi({ ...params, cid, qn: 120, fnver: 0, fnval: 4048, fourk: 1 });
      const { data } = await request(API, '/x/player/wbi/playurl', query, credentials, { referer });
      if (!data?.dash || data.is_preview) throw new MusicError(404, '哔哩哔哩没有提供完整的网页播放流。');
      return { aid, cid, referer, dash: data.dash };
    },

    async reportHistory({ aid, cid, referer, duration, start }, { position, watched, event }, account) {
      const { credentials, profile } = account;
      if (!credentials.csrf) throw new MusicError(403, '请重新扫码后开启观看记录同步。');
      const current = position === -1 ? Math.floor(duration) : position;
      const fields = {
        start_ts: start, mid: profile.id, aid, cid, type: 3, dt: 2, play_type: event,
        played_time: position, realtime: watched, real_played_time: watched, video_duration: Math.floor(duration),
        last_play_progress_time: current, max_play_progress_time: current, platform: 'web', device: 'web',
        mobi_app: 'web', csrf: credentials.csrf,
      };
      const signed = await signWbi(Object.fromEntries(
        ['start_ts', 'mid', 'aid', 'dt', 'realtime', 'played_time', 'real_played_time', 'video_duration', 'last_play_progress_time']
          .map(key => ['w_' + key, fields[key]]),
      ));
      await request(API, '/x/click-interface/web/heartbeat', signed, credentials, { referer, body: new URLSearchParams(fields) });
      return { ok: true };
    },

    async following({ offset }, { profile, credentials }) {
      const page = pageNumber(offset);
      const { data } = await request(API, '/x/relation/followings', {
        vmid: profile.id, pn: page, ps: FOLLOW_PAGE_SIZE, order: 'desc', gaia_source: 'main_web', web_location: '333.1387',
      }, credentials, { referer: 'https://space.bilibili.com/' + profile.id + '/relation/follow' });
      const entries = list(data?.list, data?.total === 0, '关注列表');
      return { items: entries.map(creator).filter(Boolean),
        next: entries.length && page * FOLLOW_PAGE_SIZE < count(data.total) ? page + 1 : null };
    },

    async updates({ offset }, { credentials }) {
      const cursor = dynamicOffset(offset);
      const params = { type: 'video', platform: 'web', timezone_offset: -480 };
      if (cursor) params.offset = cursor;
      const { data } = await request(API, DYNAMIC + 'all', params, credentials, {
        referer: 'https://t.bilibili.com/', visitor: true,
      });
      return dynamicPage(data, cursor);
    },

    async creatorVideos({ id, offset }, account) {
      const mid = idOf(id);
      if (!mid) throw new MusicError(400, '无效的哔哩哔哩 UP 主。');
      const cursor = dynamicOffset(offset);
      const params = { host_mid: mid, type: 'video', platform: 'web', timezone_offset: -480 };
      if (cursor) params.offset = cursor;
      const { data } = await request(API, DYNAMIC + 'space', await signWbi(params), account?.credentials, {
        referer: 'https://space.bilibili.com/' + mid + '/dynamic', visitor: true,
      });
      return dynamicPage(data, cursor);
    },

    async search({ query, kind, offset }, account) {
      const keyword = str(query);
      if (!keyword || keyword.length > 100 || !['song', 'playlist'].includes(kind)) {
        throw new MusicError(400, '请输入 1–100 个字符的哔哩哔哩搜索关键词。');
      }
      const page = pageNumber(offset);
      const creators = kind === 'playlist';
      const params = await signWbi({ keyword, search_type: creators ? 'bili_user' : 'video', page });
      const { data } = await request(API, '/x/web-interface/wbi/search/type', params, account?.credentials, {
        referer: 'https://search.bilibili.com/',
      });
      const entries = list(data?.result, data?.numResults === 0, '搜索结果');
      const items = entries.map(item => creators ? creator(item) : item && video({ ...item, title: searchText(item.title) })).filter(Boolean);
      return { items, next: entries.length && page < count(data.numPages) ? page + 1 : null };
    },
  };
}
