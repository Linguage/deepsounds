import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { createMusicService } from '../lib/netease.js';
import { createPodcastService } from '../lib/xiaoyuzhou.js';
import { createBilibiliService } from '../lib/bilibili.js';
import { parseShare } from '../web/links.js';
import { createHandler, PREFIX } from '../lib/http.js';
import { apply, inject } from '../lib/index.js';
import { activeLine, mergeLyrics } from '../web/lyrics.js';

function upstream(routes) {
  return createMusicService(async (url, init) => {
    assert.equal(url.origin, 'https://music.163.com');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    const response = routes[url.pathname];
    assert.ok(response, 'unexpected upstream request: ' + url.pathname);
    return Response.json({ code: 200, ...response(url.searchParams) });
  });
}

test('search pagination advances by upstream results; raw payload is not exposed', async () => {
  const service = upstream({
    '/api/cloudsearch/pc': params => {
      assert.equal(params.get('s'), '海阔天空');
      assert.equal(params.get('type'), '1');
      return { result: { songCount: 40, songs: [
        { id: 123, name: '样本', ar: [{ name: '歌手' }], al: { name: '专辑', picUrl: 'http://p1.music.126.net/cover.jpg' }, dt: 33000 },
        { id: -1 },
      ] } };
    },
  });
  assert.deepEqual(await service.search({ query: ' 海阔天空 ', kind: 'song', offset: '24' }), {
    items: [{ id: '123', title: '样本', artists: '歌手', album: '专辑', cover: 'https://p1.music.126.net/cover.jpg', duration: 33000 }],
    next: 26,
  });
  await assert.rejects(service.search({ query: 'q', kind: 'constructor' }), { status: 400 });
});

test('public playlist pagination preserves order and missing track slots', async () => {
  const service = upstream({
    '/api/v6/playlist/detail': () => ({
      playlist: { id: 30, name: '公开歌单', trackCount: 4,
        trackIds: [1, 2, 3, 4].map(id => ({ id })),
        tracks: [{ id: 1, name: '第一首' }, { id: 3, name: '第三首' }] },
    }),
    '/api/v3/song/detail': params => {
      assert.deepEqual(JSON.parse(params.get('c')), [{ id: 2 }, { id: 4 }]);
      return { songs: [{ id: 4, name: '第四首' }] };
    },
  });
  const data = await service.playlist({ id: '30', offset: '1' });
  assert.deepEqual(data.items.map(item => [item.id, !!item.missing]), [['2', true], ['3', false], ['4', false]]);
  assert.equal(data.next, null);
});

test('stream rejects previews, denied tracks and media outside the NetEase CDN', async () => {
  const service = upstream({
    '/api/song/enhance/player/url/v1': params => {
      const [id] = JSON.parse(params.get('ids'));
      assert.equal(params.get('level'), 'standard');
      const clean = { id, code: 200, url: 'http://m801.music.126.net/a.mp3', freeTrialInfo: null };
      const failures = {
        2: { freeTrialInfo: { start: 10, end: 20 } },
        3: { code: -110, url: null },
        4: { url: 'https://m801.music.126.net.example/a.mp3' },
        5: { url: 'https://name@p1.music.126.net/a.mp3' },
      };
      return { data: [{ ...clean, ...failures[id] }] };
    },
  });
  assert.deepEqual(await service.stream({ id: 1 }), { url: 'https://m801.music.126.net/a.mp3' });
  for (const id of [2, 3, 4, 5]) await assert.rejects(service.stream({ id }), { status: 404 });
  await assert.rejects(service.stream({ id: '9007199254740992' }), { status: 400 });
});

test('lyrics honor offsets, repeated timestamps, translations and backwards seeks', () => {
  const lines = mergeLyrics('[offset:+100]\n[00:09.00][00:21]原文\n[ar:歌手]\n[00:12.50]下一句', '[00:09.09]译文');
  assert.deepEqual(lines, [
    { time: 9100, text: '原文', translation: '译文' },
    { time: 12600, text: '下一句' },
    { time: 21100, text: '原文' },
  ]);
  assert.equal(activeLine(lines, 25000), 2);
  assert.equal(activeLine(lines, 12600), 1);
  assert.equal(activeLine(lines, 9099), -1);
});

test('DSH registers one plugin prefix; HTTP keeps assets and actions scoped', async () => {
  let entry;
  assert.deepEqual(inject, ['webServer']);
  apply({ effect: fn => fn(), webServer: { register: value => { entry = value; } } });
  assert.equal(entry.path + '/', PREFIX);
  const handler = createHandler({ lyrics: ({ id }) => ({ original: id, translation: '' }) });
  async function call(url, method = 'GET') {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      end(body) { this.body = body; } };
    await handler({ url, method }, response);
    return response;
  }
  const home = await call(PREFIX);
  assert.equal(home.status, 200);
  assert.match(String(home.body), /网易云音乐/);
  assert.match(home.headers['content-security-policy'], /media-src https:\/\/\*\.music\.126\.net/);
  assert.deepEqual(JSON.parse((await call(PREFIX + 'api/lyrics?id=12')).body), { original: '12', translation: '' });
  assert.equal((await call(PREFIX + 'api/lyrics', 'POST')).status, 405);
  assert.equal((await call(PREFIX + '../package.json')).status, 404);
  assert.equal((await call(PREFIX, 'HEAD')).body, undefined);
});

test('QR confirmation scopes NetEase cookies and playlists to the active panel session', async () => {
  const cookieValue = 'test-cookie-never-returned';
  const calls = [];
  let deviceId;
  const service = createMusicService(async (url, init) => {
    const cookie = new Headers(init.headers).get('cookie');
    calls.push(url.pathname);
    if (url.pathname.startsWith('/eapi/')) {
      assert.equal(url.origin, 'https://interfacepc.music.163.com');
      assert.equal(init.method, 'POST');
      assert.doesNotMatch(cookie, /NMTID=|MUSIC_U=/);
      const decipher = createDecipheriv('aes-128-ecb', 'e82ckenh8dichen8', null);
      const encrypted = Buffer.from(init.body.get('params'), 'hex');
      const [path, payload] = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString().split('-36cd479b6b5-');
      const params = JSON.parse(payload);
      assert.equal(params.type, 3);
      if (path === '/api/login/qrcode/unikey') {
        deviceId = params.header.deviceId;
        return Response.json({ code: 200, unikey: 'mock_qr_key_1' }, { headers: { 'set-cookie': 'NMTID=guest-marker; Path=/' } });
      }
      assert.equal(path, '/api/login/qrcode/client/login');
      assert.equal(params.header.deviceId, deviceId);
      assert.equal(params.key, 'mock_qr_key_1');
      return Response.json({ code: 803 }, { headers: [['set-cookie', 'MUSIC_U=' + cookieValue + '; HttpOnly'], ['set-cookie', 'unrelated=ignore-me']] });
    }
    assert.equal(url.origin, 'https://music.163.com');
    switch (url.pathname) {
      case '/api/nuser/account/get':
        assert.equal(cookie, 'MUSIC_U=' + cookieValue);
        return Response.json({ code: 200, profile: { userId: 501, nickname: '模拟账号' } });
      case '/api/user/playlist':
        assert.equal(cookie, 'MUSIC_U=' + cookieValue);
        assert.equal(url.searchParams.get('uid'), '501');
        assert.equal(url.searchParams.get('offset'), '24');
        return Response.json({ code: 200, more: true, playlist: [{ id: 43, name: '模拟歌单', trackCount: 1 }] });
      case '/api/v6/playlist/detail':
        assert.equal(cookie, 'MUSIC_U=' + cookieValue);
        return Response.json({ code: 200, playlist: { id: 43, name: '模拟歌单', tracks: [{ id: 22, name: '模拟歌曲' }] } });
      default: throw new Error('Unexpected request');
    }
  });
  const handler = createHandler(service);
  async function call(path, { token, post = false, panel = true } = {}) {
    const headers = {};
    if (token) headers['x-netease-session'] = token;
    if (post && panel) headers['x-deepsounds-client'] = 'panel';
    const response = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; },
    };
    await handler({ url: PREFIX + 'api/' + path, method: post ? 'POST' : 'GET', headers }, response);
    assert.ok(!response.body.includes(cookieValue));
    assert.equal(response.headers['set-cookie'], undefined);
    return { status: response.status, data: JSON.parse(response.body) };
  }
  assert.equal((await call('login/start', { post: true, panel: false })).status, 403);
  assert.equal((await call('my-playlists')).status, 401);
  const { data: pending } = await call('login/start', { post: true });
  assert.match(pending.qr, /^data:image\/gif;base64,/);
  assert.equal((await call('my-playlists', { token: pending.token })).status, 401);
  const { data: confirmed } = await call('login/check', { token: pending.token, post: true });
  assert.deepEqual(confirmed, { state: 'signed-in', profile: { id: '501', name: '模拟账号' } });
  const { data } = await call('my-playlists?offset=24&uid=999', { token: pending.token });
  assert.equal(data.items[0].title, '模拟歌单');
  assert.equal(data.next, 25);
  assert.equal((await call('playlist?id=43', { token: pending.token })).data.items[0].id, '22');
  assert.equal((await call('my-playlists', { token: 'B'.repeat(43) })).status, 401);
  assert.equal((await call('login/clear', { token: pending.token, post: true })).status, 200);
  assert.equal((await call('my-playlists', { token: pending.token })).status, 401);
  assert.equal(calls.length, 5);
});

test('Xiaoyuzhou QR confirmation loads subscriptions and the mobile queue without exposing credentials', async () => {
  const id = '63b7c6697dcc05cd33b51cd5';
  const other = '63c91b2e78910ae65c9a5748';
  const unavailable = 'a'.repeat(24);
  const auth = 'test-xyz-access';
  const renew = 'test-xyz-refresh';
  const service = createPodcastService(async (raw, init) => {
    const url = new URL(raw);
    const token = new Headers(init.headers).get('x-jike-access-token');
    if (url.pathname === '/v1/auth/qrcode/create') {
      assert.equal(url.origin, 'https://web-api.xiaoyuzhoufm.com');
      assert.equal(token, null);
      return Response.json({ id });
    }
    if (url.pathname === '/v1/auth/qrcode/login') {
      assert.equal(JSON.parse(init.body).id, id);
      return Response.json({ status: 'USED' }, { headers: {
        'x-jike-access-token': auth, 'x-jike-refresh-token': renew,
      } });
    }
    assert.equal(token, auth);
    if (url.pathname === '/web/user/get-me') {
      return Response.json({ data: { uid: id, nickname: '测试听众' } });
    }
    assert.equal(url.origin, 'https://api.xiaoyuzhoufm.com');
    if (url.pathname === '/v1/playlist/pull') {
      assert.deepEqual(JSON.parse(init.body), {});
      return Response.json({ data: { kind: 'FULL_LIST', list: [other, unavailable, id], sha: 'private-revision' } });
    }
    if (url.pathname === '/v1/episode/list-by-ids') {
      assert.deepEqual(JSON.parse(init.body), { eids: [other, unavailable, id] });
      return Response.json({ data: [
        { eid: id, title: '已排队甲', podcast: { title: '节目甲' } },
        { eid: other, title: '已排队乙', duration: 90, podcast: { title: '节目乙' } },
      ] });
    }
    assert.equal(url.pathname, '/v1/subscription/list');
    const body = JSON.parse(init.body);
    assert.equal(body.sortBy, 'subscribedAt');
    assert.deepEqual(body.loadMoreKey, { id: 'previous' });
    return Response.json({ data: { data: [{ pid: id, title: '测试订阅节目' }], loadMoreKey: { id: 'next' } } });
  });
  const handler = createHandler({}, service);
  async function call(path, { token, post = false, header = 'x-podcast-session' } = {}) {
    const headers = token ? { [header]: token } : {};
    if (post) headers['x-deepsounds-client'] = 'panel';
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler({ url: PREFIX + 'api/' + path, method: post ? 'POST' : 'GET', headers }, response);
    assert.doesNotMatch(response.body, /test-xyz-(access|refresh)|private-revision/);
    return [response.status, JSON.parse(response.body)];
  }
  const [, pending] = await call('podcast/login/start', { post: true });
  assert.match(pending.qr, /^data:image\/gif;base64,/);
  const { token } = pending;
  assert.equal((await call('podcast/account', { token }))[0], 401);
  assert.equal((await call('podcast/playback-list', { token }))[0], 401);
  const [, ready] = await call('podcast/login/check', { post: true, token });
  assert.deepEqual(ready, { state: 'signed-in', profile: { id, name: '测试听众' } });
  assert.equal((await call('account', { token, header: 'x-netease-session' }))[0], 401);
  const cursor = encodeURIComponent(JSON.stringify({ id: 'previous' }));
  const [, list] = await call('podcast/subscriptions?offset=' + cursor, { token });
  assert.equal(list.items[0].title, '测试订阅节目');
  assert.equal(list.next, JSON.stringify({ id: 'next' }));
  const [status, queue] = await call('podcast/playback-list', { token });
  assert.equal(status, 200);
  assert.equal(queue.next, null);
  assert.deepEqual(queue.items.map(item => [item.id, item.title, !!item.missing]), [
    [other, '已排队乙', false], [unavailable, '单集暂不可用', true], [id, '已排队甲', false],
  ]);
  assert.equal(queue.items[0].artists, '节目乙');
  assert.equal(queue.items[0].duration, 90_000);
  await call('podcast/login/clear', { post: true, token });
  assert.equal((await call('podcast/playback-list', { token }))[0], 401);
});

test('Xiaoyuzhou distinguishes an empty mobile queue from an unrecognized response', async () => {
  let data = { kind: 'FULL_LIST', list: [] };
  const service = createPodcastService(async url => {
    assert.equal(url, 'https://api.xiaoyuzhoufm.com/v1/playlist/pull');
    return Response.json({ data });
  });
  const account = { credentials: { access: 'test-xyz-access' } };
  assert.deepEqual(await service.playbackList(account), { items: [], next: null });
  data = { kind: 'UP_TO_DATE' };
  assert.deepEqual(await service.playbackList(account), { items: [], next: null });
  data = { kind: 'PATCH', patch: {} };
  await assert.rejects(service.playbackList(account), { status: 502 });
});

test('Xiaoyuzhou public links, protected episodes and short redirects stay scoped', async () => {
  const id = '63c91b2e78910ae65c9a5748';
  assert.deepEqual(parseShare('分享 https://www.xiaoyuzhoufm.com/episode/' + id + '?s=123'), {
    source: 'xiaoyuzhou', type: 'episode', id,
  });
  assert.equal(parseShare('https://www.xiaoyuzhoufm.com.example/episode/' + id), null);
  const service = createPodcastService(async raw => {
    const url = new URL(raw);
    if (url.hostname === 'xyzfm.link') {
      return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/episode/' + id } });
    }
    assert.equal(url.origin, 'https://www.xiaoyuzhoufm.com');
    return new Response('<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { episode: {
      eid: id, title: '受限单集', isPrivateMedia: true, media: { source: { url: 'https://media.xyzcdn.net/test.mp3' } },
    } } } }) + '</script>');
  });
  assert.equal((await service.episode({ id })).items[0].missing, true);
  await assert.rejects(service.stream({ id }), { status: 404 });
  await assert.rejects(service.resolve({ code: 'example' }), { status: 404 });
});

test('Bilibili scopes account lists and following updates to the signed-in session', async () => {
  const key = 'a'.repeat(32);
  const csrf = 'b'.repeat(32);
  const session = 'mock%2Cbili-session';
  const bvid = 'BV17x411w7KC';
  const published = 1793990000;
  let scanState = 86101;
  let liked = false;
  let attribute = 1;
  let selectedFolder = 42;
  const bili = createBilibiliService(async (url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, 'error');
    if (url.origin === 'https://passport.bilibili.com') {
      assert.equal(headers.get('cookie'), null);
      if (url.pathname.endsWith('/generate')) return Response.json({ code: 0, data: {
        qrcode_key: key, url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=' + key,
      } });
      assert.equal(url.pathname, '/x/passport-login/web/qrcode/poll');
      assert.equal(url.searchParams.get('qrcode_key'), key);
      return Response.json({ code: 0, data: { code: scanState, refresh_token: 'never-expose-refresh' } },
        scanState === 0 ? { headers: [
          ['set-cookie', 'bili_jct=' + csrf + '; HttpOnly'], ['set-cookie', 'SESSDATA=' + session + '; HttpOnly'],
        ] } : {});
    }
    assert.equal(url.origin, 'https://api.bilibili.com');
    if (url.pathname === '/x/frontend/finger/spi') {
      assert.equal(headers.get('cookie'), null);
      return Response.json({ code: 0, data: { b_3: 'guest-3', b_4: 'guest-4' } });
    }
    const updatesPath = '/x/polymer/web-dynamic/v1/feed/all';
    const post = init.method === 'POST';
    assert.equal(headers.get('cookie'), 'SESSDATA=' + session + (post ? '; bili_jct=' + csrf :
      url.pathname === updatesPath ? '; buvid3=guest-3; buvid4=guest-4' : ''));
    if (post) {
      assert.equal(headers.get('origin'), 'https://www.bilibili.com');
      assert.equal(init.body.get('csrf'), csrf);
    }
    switch (url.pathname) {
      case '/x/web-interface/nav':
        return Response.json({ code: 0, data: { mid: 24, uname: '测试用户', isLogin: true, wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/' + key + '.png', sub_url: 'https://i0.hdslb.com/bfs/' + csrf + '.png',
        } } });
      case '/x/v3/fav/folder/created/list-all':
        assert.equal(url.searchParams.get('up_mid'), '24');
        if (url.searchParams.has('rid')) {
          assert.equal(url.searchParams.get('rid'), '170001');
          assert.equal(url.searchParams.get('type'), '2');
          return Response.json({ code: 0, data: { count: 2, list: [42, 43].map(id => ({
            id, title: '收藏夹 ' + id, fav_state: Number(selectedFolder === id),
          })) } });
        }
        return Response.json({ code: 0, data: { count: 1, list: [{ id: 42, title: '私人收藏', media_count: 2 }] } });
      case '/x/v3/fav/resource/list':
        assert.equal(url.searchParams.get('media_id'), '42');
        assert.equal(url.searchParams.get('pn'), '2');
        return Response.json({ code: 0, data: {
          info: { title: '私人收藏' }, has_more: true, medias: [
            { type: 2, bvid, pubtime: published, fav_time: published + 90_000, title: '收藏的视频',
              cover: '//i0.hdslb.com/bfs/archive/test.jpg', upper: { mid: 19, name: 'UP 主' } },
            { type: 12, id: 9, title: '非视频条目' },
          ],
        } });
      case '/x/v2/history/toview/web':
        return Response.json({ code: 0, data: { count: 1, list: [
          { aid: 170001, pubdate: String(published), title: '稍后看', pic: 'https://i0.hdslb.com.example/ignored.jpg', uri: 'https://example.invalid/' },
        ] } });
      case '/x/web-interface/wbi/search/type':
        return Response.json({ code: 0, data: { numPages: 1, result: [{ bvid, aid: 170001, pubdate: published, mid: 19 }] } });
      case '/x/web-interface/view':
        assert.equal(url.searchParams.get('bvid'), bvid);
        return Response.json({ code: 0, data: { aid: 170001 } });
      case '/x/web-interface/archive/relation':
        assert.equal(url.searchParams.get('bvid'), bvid);
        return Response.json({ code: 0, data: { like: liked, favorite: !!selectedFolder } });
      case '/x/web-interface/archive/like':
        assert.equal(init.body.get('bvid'), bvid);
        assert.equal(init.body.get('like'), liked ? '2' : '1');
        liked = !liked;
        return Response.json({ code: 0 });
      case '/x/v3/fav/resource/deal':
        assert.equal(init.body.get('rid'), '170001');
        assert.equal(init.body.get('type'), '2');
        assert.equal(init.body.get('add_media_ids'), '43');
        assert.equal(init.body.get('del_media_ids'), '42');
        selectedFolder = 43;
        return Response.json({ code: 0 });
      case '/x/relation':
        assert.equal(url.searchParams.get('fid'), '19');
        return Response.json({ code: 0, data: { attribute } });
      case '/x/relation/modify':
        assert.equal(init.body.get('fid'), '19');
        assert.equal(init.body.get('act'), attribute === 1 ? '4' : attribute === 2 ? '2' : '1');
        attribute = attribute ? 0 : 2;
        return Response.json({ code: 0 });
      case '/x/relation/followings':
        assert.equal(url.searchParams.get('vmid'), '24');
        assert.equal(url.searchParams.get('pn'), '2');
        return Response.json({ code: 0, data: { total: 101, list: [{ mid: 19, uname: '关注的作者' }] } });
      case updatesPath:
        assert.equal(url.searchParams.get('type'), 'video');
        assert.equal(url.searchParams.get('offset'), '1160000000000000000');
        return Response.json({ code: 0, data: { has_more: true, offset: '1150000000000000000', items: [
          { id_str: '1159999999999999999', type: 'DYNAMIC_TYPE_AV', modules: {
            module_author: { mid: 19, name: '关注的作者', pub_ts: 1793990000 },
            module_dynamic: { major: { archive: { bvid, title: '最新投稿', duration_text: '1:02' } } },
          } },
          { type: 'DYNAMIC_TYPE_WORD', id_str: '1159999999999999998' },
        ] } });
      default: throw new Error('Unexpected Bilibili route: ' + url.pathname);
    }
  });
  assert.deepEqual(await bili.loginPoll(key), { state: 'waiting' });
  scanState = 86090;
  assert.deepEqual(await bili.loginPoll(key), { state: 'confirming' });
  scanState = 0;
  const handler = createHandler({}, {}, bili);
  async function call(path, { token, post = false, scope = 'bilibili' } = {}) {
    const headers = token ? { ['x-' + scope + '-session']: token } : {};
    if (post) headers['x-deepsounds-client'] = 'panel';
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler({ url: PREFIX + 'api/' + path, method: post ? 'POST' : 'GET', headers }, response);
    assert.doesNotMatch(response.body, /mock%2C|never-expose|b{32}/);
    return [response.status, JSON.parse(response.body)];
  }
  const [, login] = await call('bilibili/login/start', { post: true });
  assert.match(login.qr, /^data:image\/gif;base64,/);
  const { token } = login;
  assert.equal((await call('bilibili/favorites', { token }))[0], 401);
  assert.deepEqual(await call('bilibili/login/check', { token, post: true }), [200, {
    state: 'signed-in', profile: { id: '24', name: '测试用户' },
  }]);
  assert.equal((await call('bilibili/favorites', { token, scope: 'podcast' }))[0], 401);
  assert.equal((await call('account', { token, scope: 'netease' }))[0], 401);
  const [, folders] = await call('bilibili/favorites?up_mid=999', { token });
  assert.deepEqual(folders.items.map(item => [item.id, item.title]), [['42', '私人收藏']]);
  const [, folder] = await call('bilibili/folder?id=42&offset=2', { token });
  assert.equal(folder.next, 3);
  assert.deepEqual(folder.items.map(item => [item.url, item.cover]), [
    ['https://www.bilibili.com/video/' + bvid + '/', 'https://i0.hdslb.com/bfs/archive/test.jpg'],
  ]);
  const [, watch] = await call('bilibili/watch-later', { token });
  assert.equal(watch.items[0].url, 'https://www.bilibili.com/video/av170001/');
  assert.equal(watch.items[0].cover, null);
  const [, search] = await call('bilibili/search?q=测试&kind=song', { token });
  assert.deepEqual([folder.items[0], watch.items[0], search.items[0]].map(item => item.published), [published, published, published]);
  assert.equal(folder.items[0].ownerId, '19');
  assert.equal((await call('bilibili/updates'))[0], 401);
  const [followingStatus, following] = await call('bilibili/following?vmid=99&offset=2', { token });
  assert.equal(followingStatus, 200);
  assert.deepEqual(following.items.map(item => item.title), ['关注的作者']);
  assert.equal(following.next, 3);
  const [updatesStatus, updates] = await call('bilibili/updates?offset=1160000000000000000', { token });
  assert.equal(updatesStatus, 200);
  assert.deepEqual(updates.items.map(item => [item.updateId, item.title, item.duration]), [
    ['1159999999999999999', '最新投稿', 62_000],
  ]);
  assert.equal(updates.next, '1150000000000000000');
  assert.equal(updates.items[0].published, published);
  assert.equal(updates.items[0].ownerId, '19');
  const likePath = 'bilibili/like?id=' + bvid;
  assert.equal((await call(likePath + '&enabled=1', { post: true }))[0], 401);
  assert.equal((await call(likePath + '&enabled=invalid', { token, post: true }))[0], 400);
  assert.deepEqual(await call('bilibili/video-relation?id=' + bvid, { token }), [200, { liked: false, favorite: true }]);
  assert.deepEqual(await call(likePath + '&enabled=1', { token, post: true }), [200, { liked: true }]);
  assert.deepEqual(await call(likePath + '&enabled=0', { token, post: true }), [200, { liked: false }]);
  const folderPath = 'bilibili/video-folders?id=' + bvid;
  assert.deepEqual((await call(folderPath, { token }))[1].items.map(item => item.selected), [true, false]);
  assert.equal((await call('bilibili/save?id=av170001&add=42&remove=42', { token, post: true }))[0], 400);
  assert.deepEqual(await call('bilibili/save?id=av170001&add=43&remove=42', { token, post: true }), [200, { ok: true }]);
  assert.deepEqual((await call(folderPath, { token }))[1].items.map(item => item.selected), [false, true]);
  assert.deepEqual(await call('bilibili/creator-relation?id=19', { token }), [200, { following: true, self: false }]);
  assert.equal((await call('bilibili/follow?id=24&enabled=1', { token, post: true }))[0], 400);
  for (const value of [0, 1, 0]) {
    assert.deepEqual(await call('bilibili/follow?id=19&enabled=' + value, { token, post: true }), [200, { following: !!value }]);
  }
  await call('bilibili/login/clear', { token, post: true });
  assert.equal((await call('bilibili/watch-later', { token }))[0], 401);
});
