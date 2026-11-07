import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAccounts } from '../lib/account.js';
import { MusicError } from '../lib/netease.js';
import { createSessionStore } from '../lib/session-store.js';
import { createPodcastService } from '../lib/xiaoyuzhou.js';

function storage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deepsounds-session-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('only confirmed sessions survive a restart and can be revoked while requests are in flight', async t => {
  const dir = storage(t);
  const profile = { id: '1', name: 'Test account' };
  const credentials = new Map([['MUSIC_U', 'mock-cookie']]);
  const service = {
    loginStart: async () => ({ key: 'test-qr', url: 'https://example.com/qr' }),
    loginPoll: async () => ({ state: 'confirming', credentials }),
    profile: async () => profile,
  };
  let store = createSessionStore(dir);
  let accounts = createAccounts(service, '网易云音乐', 'netease', store);
  const { token } = await accounts.start();
  const pending = await accounts.start();
  assert.deepEqual(await accounts.check(token), { state: 'signed-in', profile });
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'sessions.sqlite')).mode & 0o777, 0o600);
  store.close();

  const nextDay = Date.now() + 24 * 60 * 60_000;
  t.mock.method(Date, 'now', () => nextDay);
  store = createSessionStore(dir);
  accounts = createAccounts({}, '网易云音乐', 'netease', store);
  const other = createAccounts({}, '哔哩哔哩', 'bilibili', store);
  assert.deepEqual(await accounts.check(pending.token), { state: 'expired' });
  await assert.rejects(other.use(token, assert.fail, true), { status: 401 });
  assert.deepEqual(await accounts.use(token, account => account.credentials), credentials);
  await assert.rejects(accounts.use(token, () => { throw new MusicError(502, 'offline'); }), { status: 502 });
  assert.deepEqual(await accounts.use(token, account => account.profile), profile);

  const { promise, resolve } = Promise.withResolvers();
  const inFlight = accounts.use(token, async account => {
    await promise;
    account.credentials.set('MUSIC_U', 'changed-cookie');
  });
  accounts.clear(token);
  resolve();
  await assert.rejects(inFlight, { status: 401 });
  store.close();
  store = createSessionStore(dir);
  assert.deepEqual(await createAccounts({}, '网易云音乐', 'netease', store).check(token), { state: 'expired' });
  store.close();
});

test('Xiaoyuzhou keeps its device identity and saves rotated tokens for the next host process', async t => {
  const dir = storage(t);
  const id = '63b7c6697dcc05cd33b51cd5';
  let device;
  let generation = 0;
  let refreshCount = 0;
  const fetcher = async (raw, { headers }) => {
    const path = new URL(raw).pathname;
    if (path === '/v1/auth/qrcode/create') return Response.json({ id });
    if (path === '/v1/auth/qrcode/login') {
      return Response.json({ status: 'USED' }, { headers: {
        'x-jike-access-token': 'access-0', 'x-jike-refresh-token': 'refresh-0',
      } });
    }
    if (path === '/web/user/get-me') return Response.json({ data: { uid: id, nickname: 'Test podcast account' } });
    device ??= headers['x-jike-device-id'];
    assert.ok(device);
    assert.equal(headers['x-jike-device-id'], device);
    if (path === '/app_auth_tokens.refresh') {
      assert.equal(headers['x-jike-refresh-token'], 'refresh-' + (generation - 1));
      refreshCount++;
      return Response.json({}, { headers: {
        'x-jike-access-token': 'access-' + generation, 'x-jike-refresh-token': 'refresh-' + generation,
      } });
    }
    assert.equal(path, '/v1/playlist/pull');
    if (headers['x-jike-access-token'] !== 'access-' + generation) return new Response(null, { status: 401 });
    return Response.json({ data: { kind: 'FULL_LIST', list: [] } });
  };
  const boot = () => {
    const store = createSessionStore(dir);
    const podcast = createPodcastService(fetcher);
    return { store, podcast, accounts: createAccounts(podcast, '小宇宙', 'podcast', store) };
  };
  let host = boot();
  const { token } = await host.accounts.start();
  assert.equal((await host.accounts.check(token)).state, 'signed-in');
  await host.accounts.use(token, host.podcast.playbackList, true);
  host.store.close();

  generation++;
  host = boot();
  const queue = () => host.accounts.use(token, host.podcast.playbackList, true);
  assert.deepEqual(await Promise.all([queue(), queue()]), Array(2).fill({ items: [], next: null }));
  assert.equal(refreshCount, 1);
  host.store.close();

  generation++;
  host = boot();
  assert.deepEqual(await queue(), { items: [], next: null });
  assert.equal(refreshCount, 2);
  await assert.rejects(host.accounts.use(token, () => { throw new MusicError(401, 'revoked'); }), { status: 401 });
  assert.deepEqual(await host.accounts.check(token), { state: 'expired' });
  host.store.close();
});
