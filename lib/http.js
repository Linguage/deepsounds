import { readFile } from 'node:fs/promises';
import { createMusicService, MusicError } from './netease.js';
import { createAccounts } from './account.js';
import { createPodcastService } from './xiaoyuzhou.js';
import { createBilibiliService } from './bilibili.js';
import { createBilibiliPlayback } from './bilibili-playback.js';
import { createUpdater } from './update.js';
import { createSessionStore } from './session-store.js';

export const PREFIX = '/deepsounds/';
const assets = {
  '': ['../web/index.html', 'text/html; charset=utf-8'],
  'app.js': ['../web/app.js', 'text/javascript; charset=utf-8'],
  'account.js': ['../web/account.js', 'text/javascript; charset=utf-8'],
  'bilibili-updates.js': ['../web/bilibili-updates.js', 'text/javascript; charset=utf-8'],
  'bilibili-player.js': ['../web/bilibili-player.js', 'text/javascript; charset=utf-8'],
  'dash.mediaplayer.min.js': ['../lib/vendor/dash.mediaplayer.min.js', 'text/javascript; charset=utf-8'],
  'lyrics.js': ['../web/lyrics.js', 'text/javascript; charset=utf-8'],
  'links.js': ['../web/links.js', 'text/javascript; charset=utf-8'],
  'style.css': ['../web/style.css', 'text/css; charset=utf-8'],
  'icon.svg': ['../icon.svg', 'image/svg+xml'],
};
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://*.music.126.net https://*.xyzcdn.net https://*.hdslb.com https://*.biliimg.com; media-src https://*.music.126.net https://*.xyzcdn.net 'self' blob:; frame-src https://player.bilibili.com; object-src 'none'; base-uri 'none'; form-action 'none'";

export function createHandler(service = createMusicService(), podcast = createPodcastService(), bilibili = createBilibiliService(),
    updater = createUpdater(), store = createSessionStore()) {
  const accounts = createAccounts(service, '网易云音乐', 'netease', store);
  const podcastAccounts = createAccounts(podcast, '小宇宙', 'podcast', store);
  const biliAccounts = createAccounts(bilibili, '哔哩哔哩', 'bilibili', store);
  const biliPlayback = createBilibiliPlayback(bilibili, biliAccounts);
  const actions = {
    'api/update': () => updater.check(),
    'api/recommendations': () => service.recommendations(),
    'api/search': params => service.search({ query: params.get('q'), kind: params.get('kind'), offset: params.get('offset') }),
    'api/playlist': (params, token) => accounts.use(token,
      account => service.playlist({ id: params.get('id'), offset: params.get('offset') }, account)),
    'api/lyrics': params => service.lyrics({ id: params.get('id') }),
    'api/stream': (params, token) => accounts.use(token, account => service.stream({ id: params.get('id') }, account)),
    'api/account': (_, token) => accounts.use(token, account => ({ profile: account.profile }), true),
    'api/my-playlists': (params, token) => accounts.use(token,
      account => service.myPlaylists({ offset: params.get('offset') }, account), true),
    'api/podcast/recommendations': () => podcast.recommendations(),
    'api/podcast/search': (params, token) => podcastAccounts.use(token, account => podcast.search({
      query: params.get('q'), kind: params.get('kind'), cursor: params.get('offset'),
    }, account)),
    'api/podcast/show': (params, token) => podcastAccounts.use(token, account => podcast.show({
      id: params.get('id'), cursor: params.get('offset'),
    }, account)),
    'api/podcast/episode': (params, token) => podcastAccounts.use(token, account => podcast.episode({ id: params.get('id') }, account)),
    'api/podcast/stream': params => podcast.stream({ id: params.get('id') }),
    'api/podcast/link': params => podcast.resolve({ code: params.get('code') }),
    'api/podcast/account': (_, token) => podcastAccounts.use(token, account => ({ profile: account.profile }), true),
    'api/podcast/subscriptions': (params, token) => podcastAccounts.use(token, account =>
      podcast.subscriptions({ cursor: params.get('offset') }, account), true),
    'api/podcast/updates': (params, token) => podcastAccounts.use(token, account =>
      podcast.updates({ cursor: params.get('offset') }, account), true),
    'api/podcast/favorites': (params, token) => podcastAccounts.use(token, account =>
      podcast.favorites({ cursor: params.get('offset') }, account), true),
    'api/podcast/playback-list': (_, token) => podcastAccounts.use(token, account => podcast.playbackList(account), true),
    'api/bilibili/account': (_, token) => biliAccounts.use(token, account => ({ profile: account.profile }), true),
    'api/bilibili/playback': (params, token) => biliPlayback.open(params.get('id'), token),
    'api/bilibili/video-relation': (params, token) => biliAccounts.use(token, account => bilibili.videoRelation(params.get('id'), account), true),
    'api/bilibili/video-folders': (params, token) => biliAccounts.use(token, account => bilibili.videoFolders(params.get('id'), account), true),
    'api/bilibili/creator-relation': (params, token) => biliAccounts.use(token, account => bilibili.creatorRelation(params.get('id'), account), true),
    'api/bilibili/favorites': (_, token) => biliAccounts.use(token, account => bilibili.favorites(account), true),
    'api/bilibili/folder': (params, token) => biliAccounts.use(token, account =>
      bilibili.favoriteFolder({ id: params.get('id'), offset: params.get('offset') }, account), true),
    'api/bilibili/watch-later': (_, token) => biliAccounts.use(token, account => bilibili.watchLater(account), true),
    'api/bilibili/following': (params, token) => biliAccounts.use(token, account =>
      bilibili.following({ offset: params.get('offset') }, account), true),
    'api/bilibili/updates': (params, token) => biliAccounts.use(token, account =>
      bilibili.updates({ offset: params.get('offset') }, account), true),
    'api/bilibili/creator': (params, token) => biliAccounts.use(token, account =>
      bilibili.creatorVideos({ id: params.get('id'), offset: params.get('offset') }, account)),
    'api/bilibili/search': (params, token) => biliAccounts.use(token, account => bilibili.search({
      query: params.get('q'), kind: params.get('kind'), offset: params.get('offset'),
    }, account)),
  };
  const writes = {
    'api/update/install': (_, params) => updater.install(params.get('version')),
    'api/login/start': () => accounts.start(),
    'api/login/check': token => accounts.check(token),
    'api/login/clear': token => accounts.clear(token),
    'api/podcast/login/start': () => podcastAccounts.start(),
    'api/podcast/login/check': token => podcastAccounts.check(token),
    'api/podcast/login/clear': token => podcastAccounts.clear(token),
    'api/podcast/subscribe': (token, params) => podcastAccounts.use(token, account =>
      podcast.subscribe(params.get('id'), params.get('enabled'), account), true),
    'api/podcast/favorite': (token, params) => podcastAccounts.use(token, account =>
      podcast.favorite(params.get('id'), params.get('enabled'), account), true),
    'api/bilibili/login/start': () => biliAccounts.start(),
    'api/bilibili/login/check': token => biliAccounts.check(token),
    'api/bilibili/login/clear': token => biliAccounts.clear(token),
    'api/bilibili/history': (token, params) => biliPlayback.history(params, token),
    'api/bilibili/like': (token, params) => biliAccounts.use(token, account =>
      bilibili.likeVideo(params.get('id'), params.get('enabled'), account), true),
    'api/bilibili/save': (token, params) => biliAccounts.use(token, account =>
      bilibili.saveVideo(params.get('id'), params.get('add'), params.get('remove'), account), true),
    'api/bilibili/follow': (token, params) => biliAccounts.use(token, account =>
      bilibili.followCreator(params.get('id'), params.get('enabled'), account), true),
  };
  return async (req, res) => {
    function send(status, body, type = 'text/plain; charset=utf-8') {
      res.writeHead(status, {
        'content-type': type, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': csp,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    }
    const json = (status, data) => send(status, JSON.stringify(data), 'application/json; charset=utf-8');
    const raw = req.url ?? '';
    const path = raw.split('?', 1)[0];
    const key = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : null;
    const write = Object.hasOwn(writes, key);
    if (write ? req.method !== 'POST' : !['GET', 'HEAD'].includes(req.method)) {
      if (write) {
        res.setHeader('allow', 'POST');
        return send(405, '请从 deepsounds 面板操作。');
      }
      res.setHeader('allow', 'GET, HEAD');
      return send(405, '仅支持读取。');
    }
    if (path === PREFIX.slice(0, -1)) {
      res.writeHead(308, { location: PREFIX });
      return res.end();
    }
    if (!path.startsWith(PREFIX)) return send(404, '找不到此页面。');
    const media = /^api\/bilibili\/media\/([a-f0-9]{32})\/(manifest\.mpd|(?:video|audio)-\d+\.m4s)$/.exec(key);
    if (media) {
      try { return await biliPlayback.serve(media[1], media[2], req, res); }
      catch (error) {
        if (!res.headersSent && !res.destroyed) return send(error instanceof MusicError ? error.status : 502,
          error instanceof MusicError ? error.message : '视频分段暂时无法加载。');
        return;
      }
    }
    if (write || Object.hasOwn(actions, key)) {
      if (req.method === 'HEAD') return json(200, {});
      const scope = key.startsWith('api/podcast/') ? 'podcast' : key.startsWith('api/bilibili/') ? 'bilibili' : 'netease';
      const token = req.headers?.['x-' + scope + '-session'];
      if (write && req.headers?.['x-deepsounds-client'] !== 'panel') return json(403, { error: '请从 deepsounds 面板操作。' });
      if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token)) return json(401, { error: '登录已失效，请重新扫码。' });
      try {
        const params = new URLSearchParams(raw.slice(path.length + 1));
        return json(200, await (write ? writes[key](token, params) : actions[key](params, token)));
      } catch (error) {
        return error instanceof MusicError ? json(error.status, { error: error.message }) :
          json(500, { error: '插件暂时无法处理此请求。' });
      }
    }
    if (!Object.hasOwn(assets, key)) return send(404, '找不到此页面。');
    try {
      const [file, mime] = assets[key];
      return send(200, await readFile(new URL(file, import.meta.url)), mime);
    } catch { return send(500, '插件资源加载失败。'); }
  };
}
