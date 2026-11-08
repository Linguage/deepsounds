import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler, PREFIX } from '../lib/http.js';
import { createPodcastService } from '../lib/xiaoyuzhou.js';

test('Xiaoyuzhou account updates, subscriptions and favorites use authenticated upstream state', async () => {
  const pid = 'a'.repeat(24);
  const eid = 'b'.repeat(24);
  const nextId = 'c'.repeat(24);
  const cursor = { id: eid, pubDate: '2026-11-06T12:00:00.000Z' };
  const access = 'mock-account-access';
  let subscribed = true;
  let favorited = false;
  let rejectFavorite = false;
  const show = () => ({ pid, title: '测试播客', subscriptionStatus: subscribed ? 'ON' : 'OFF' });
  const episode = id => ({ eid: id, title: '测试单集', pubDate: cursor.pubDate, podcast: show(), isFavorited: favorited });
  const podcast = createPodcastService(async (raw, init) => {
    const url = new URL(raw);
    const headers = new Headers(init.headers);
    if (url.pathname === '/v1/auth/qrcode/create') return Response.json({ id: pid });
    if (url.pathname === '/v1/auth/qrcode/login') {
      return Response.json({ status: 'USED' }, { headers: { 'x-jike-access-token': access } });
    }
    assert.equal(headers.get('x-jike-access-token'), access);
    if (url.pathname === '/web/user/get-me') return Response.json({ data: { uid: pid, nickname: '测试账号' } });
    assert.equal(url.origin, 'https://api.xiaoyuzhoufm.com');
    const body = init.body && JSON.parse(init.body);
    switch (url.pathname) {
      case '/v1/inbox/list':
        assert.equal(body.limit, '20');
        if (body.loadMoreKey) {
          assert.deepEqual(body.loadMoreKey, cursor);
          return Response.json({ data: [episode(nextId)] });
        }
        return Response.json({ data: [episode(eid)], loadMoreKey: cursor });
      case '/v1/podcast/get':
        assert.equal(init.method, 'GET');
        assert.equal(url.searchParams.get('pid'), pid);
        return Response.json({ data: show() });
      case '/v1/episode/get':
        assert.equal(init.method, 'GET');
        assert.equal(url.searchParams.get('eid'), eid);
        return Response.json({ data: episode(eid) });
      case '/v1/episode/list': return Response.json({ data: [episode(eid)] });
      case '/v1/subscription/list': return Response.json({ data: subscribed ? [show()] : [] });
      case '/v1/favorite/list': return Response.json({ data: favorited ? [episode(eid)] : [] });
      case '/v1/subscription/update':
        assert.deepEqual(body, { pid, mode: subscribed ? 'OFF' : 'ON' });
        subscribed = body.mode === 'ON';
        return Response.json({ data: show() });
      case '/v1/favorite/update':
        assert.deepEqual(body, { eid, favorited: !favorited, sourcePageName: 8, currentPageName: 9 });
        if (rejectFavorite) return Response.json({ error: 'rejected' });
        favorited = body.favorited;
        return Response.json({});
      default: assert.fail('unexpected upstream path ' + url.pathname);
    }
  });
  const handler = createHandler({}, podcast);
  let token;
  async function call(path, { post = false, panel = true, authenticated = true } = {}) {
    const headers = {};
    if (post && panel) headers['x-deepsounds-client'] = 'panel';
    if (token && authenticated) headers['x-podcast-session'] = token;
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler({ url: PREFIX + 'api/podcast/' + path, method: post ? 'POST' : 'GET', headers }, response);
    assert.ok(!response.body.includes(access));
    return { status: response.status, data: JSON.parse(response.body) };
  }

  assert.equal((await call('updates')).status, 401);
  token = (await call('login/start', { post: true })).data.token;
  assert.equal((await call('login/check', { post: true })).data.state, 'signed-in');
  const feed = (await call('updates')).data;
  assert.equal(feed.items[0].album, '2026-11-06');
  assert.equal(feed.items[0].artists, '测试播客');
  assert.equal(feed.items[0].favorited, false);
  assert.equal((await call('updates?offset=' + encodeURIComponent(feed.next))).data.items[0].id, nextId);

  assert.equal((await call('show?id=' + pid)).data.playlist.subscribed, true);
  assert.deepEqual((await call('subscribe?id=' + pid + '&enabled=false', { post: true })).data, { subscribed: false });
  assert.deepEqual((await call('subscriptions')).data.items, []);
  assert.deepEqual((await call('subscribe?id=' + pid + '&enabled=true', { post: true })).data, { subscribed: true });
  assert.equal((await call('subscriptions')).data.items[0].id, pid);

  const favorite = 'favorite?id=' + eid + '&enabled=';
  assert.equal((await call(favorite + 'true', { post: true, panel: false })).status, 403);
  assert.equal((await call(favorite + 'true', { post: true, authenticated: false })).status, 401);
  assert.equal((await call(favorite + 'maybe', { post: true })).status, 400);
  rejectFavorite = true;
  assert.equal((await call(favorite + 'true', { post: true })).status, 502);
  rejectFavorite = false;
  assert.deepEqual((await call(favorite + 'true', { post: true })).data, { favorited: true });
  assert.equal((await call('favorites')).data.items[0].favorited, true);
  assert.equal((await call('episode?id=' + eid)).data.items[0].favorited, true);
  assert.deepEqual((await call(favorite + 'false', { post: true })).data, { favorited: false });
  assert.deepEqual((await call('favorites')).data.items, []);

  favorited = true; // A change made on another device appears on refresh.
  assert.equal((await call('favorites')).data.items[0].id, eid);
});
