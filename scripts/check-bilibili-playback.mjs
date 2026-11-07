import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHandler, PREFIX } from '../lib/http.js';
import { createBilibiliService } from '../lib/bilibili.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ??
  resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const id = 'BV1B7411m7LV';
const item = { id, ownerId: '19', owner: '样片作者', published: 1793990000,
  title: '公开样片', url: 'https://www.bilibili.com/video/' + id + '/' };
const csrf = 'a'.repeat(32);
const reports = [];
let liked = false;
let following = false;
let favoriteId = '11';
const live = createBilibiliService(async (url, init) => {
  if (url.pathname !== '/x/click-interface/web/heartbeat') return fetch(url, init);
  assert.match(init.headers.cookie, /^SESSDATA=fixture; bili_jct=/);
  assert.equal(init.method, 'POST');
  assert.equal(url.searchParams.get('w_played_time'), init.body.get('played_time'));
  assert.match(url.searchParams.get('w_rid'), /^[a-f0-9]{32}$/);
  reports.push(Object.fromEntries(init.body));
  return Response.json({ code: 0 });
});
const bilibili = {
  ...live,
  loginStart: async () => ({ key: 'fixture', url: 'https://example.invalid/' }),
  loginPoll: async () => ({ credentials: { sessdata: 'fixture', csrf, vip: true } }),
  profile: async () => ({ id: '12345', name: '测试账号' }),
  favorites: async () => ({ items: [{ id: '11', title: '测试收藏' }], next: null }),
  favoriteFolder: async () => ({ playlist: { title: '测试收藏' }, items: [item], next: null }),
  videoRelation: async () => ({ liked, favorite: !!favoriteId }),
  creatorRelation: async () => ({ following }),
  videoFolders: async () => ({ aid: '42', items: ['11', '12'].map(folder => ({
    id: folder, title: '收藏夹 ' + folder, selected: folder === favoriteId,
  })) }),
  likeVideo: async (id, value) => ({ liked: liked = value === '1' }),
  followCreator: async (id, value) => ({ following: following = value === '1' }),
  saveVideo: async (id, add, remove) => {
    assert.deepEqual([id, add, remove], ['av42', '12', '11']);
    favoriteId = add;
    return { ok: true };
  },
  playback: video => live.playback(video),
};
const handler = createHandler({ recommendations: async () => ({ items: [], next: null }) }, {}, bilibili);
const server = createServer(handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = 'http://127.0.0.1:' + server.address().port + PREFIX;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--no-proxy-server', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === new URL(address).origin && response.status() >= 400) errors.push(response.status() + ' ' + url.pathname);
  });
  await page.goto(address);
  await page.getByRole('button', { name: '哔哩哔哩', exact: true }).click();
  await page.locator('#empty-login').click();
  await page.getByRole('button', { name: '测试收藏', exact: true }).click();
  const videoCard = page.getByRole('link', { name: '公开样片 · 在插件中播放' });
  assert.equal(await videoCard.locator('time').getAttribute('datetime'), new Date(item.published * 1000).toISOString());
  await videoCard.click();
  const quality = page.locator('#video-quality');
  await page.locator('#video-quality option[value="video-32"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#video-frame #player').count(), 1);
  assert.equal(await page.locator('#player-title').textContent(), item.title);
  const manifest = await page.locator('video').evaluate(video => {
    return performance.getEntriesByType('resource').find(entry => entry.name.endsWith('manifest.mpd'))?.name;
  });
  assert.ok(manifest);
  assert.equal(await page.locator('#video-history').isChecked(), false);
  assert.equal(await page.locator('#video-status').textContent(), '');
  const likeButton = page.locator('#video-like');
  await likeButton.click();
  await page.locator('#video-like[aria-pressed="true"]').waitFor();
  await likeButton.click();
  await page.locator('#video-like[aria-pressed="false"]').waitFor();
  await page.locator('#video-follow').click();
  await page.locator('#video-follow[aria-pressed="true"]').waitFor();
  await page.locator('#video-save').click();
  const chooser = page.getByRole('dialog', { name: '收藏到 B 站' });
  assert.equal(await chooser.getByRole('checkbox', { name: '收藏夹 11' }).isChecked(), true);
  await chooser.getByRole('checkbox', { name: '收藏夹 11' }).uncheck();
  await chooser.getByRole('checkbox', { name: '收藏夹 12' }).check();
  await chooser.getByRole('button', { name: '保存' }).click();
  await chooser.waitFor({ state: 'hidden' });
  assert.equal(favoriteId, '12');
  await page.locator('#video-save').click();
  assert.equal(await chooser.getByRole('checkbox', { name: '收藏夹 12' }).isChecked(), true);
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'hidden' });
  const video = page.locator('#video-stage video');
  const videoFrame = page.locator('#video-frame');
  const settings = page.locator('#video-settings summary');
  await page.locator('#video-close').hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#player')).opacity === '0');
  await video.hover();
  await page.waitForFunction(() => document.querySelector('#video-frame').dataset.controls === 'shown');
  await page.waitForFunction(() => document.querySelector('#video-frame').dataset.controls === 'hidden', null, { timeout: 5500 });
  await video.hover({ position: { x: 120, y: 80 } });
  await settings.click();
  await quality.selectOption('video-32');
  await settings.click();
  assert.equal(await video.evaluate(node => node.controls), false);
  const play = page.locator('#play-toggle');
  await play.click();
  await page.waitForFunction(() => document.querySelector('#video-stage video').currentTime > 1.2);
  assert.equal(reports.length, 0);
  assert.equal(await play.getAttribute('aria-label'), '暂停');
  await play.click();
  assert.equal(await video.evaluate(node => node.paused), true);
  await page.locator('#mute').click();
  assert.equal(await video.evaluate(node => node.muted), true);
  await page.locator('#mute').click();
  assert.equal(await video.evaluate(node => node.muted), false);
  const defaultWidth = (await videoFrame.boundingBox()).width;
  await page.locator('#video-theater').click();
  assert.equal(await page.locator('#video-theater').getAttribute('aria-pressed'), 'true');
  assert.ok((await videoFrame.boundingBox()).width > defaultWidth + 40);
  assert.ok(await videoFrame.evaluate(node => node.getBoundingClientRect().bottom <= node.closest('#video-panel').getBoundingClientRect().bottom));
  await page.locator('#video-fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'video-frame');
  assert.equal(await page.locator('#video-frame:fullscreen #player').count(), 1);
  await page.locator('#video-fullscreen').click();
  await page.locator('#video-theater[aria-pressed="true"]').waitFor();
  assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false);
  await page.locator('#video-default').click();
  assert.equal(await page.locator('#video-default').getAttribute('aria-pressed'), 'true');
  assert.equal((await videoFrame.boundingBox()).width, defaultWidth);
  if (process.env.DSH_PLAYBACK_CAPTURE) await videoFrame.screenshot({ path: process.env.DSH_PLAYBACK_CAPTURE });
  await page.setViewportSize({ width: 320, height: 650 });
  await video.hover();
  await settings.click();
  assert.ok(await quality.isVisible());
  assert.equal(await page.locator('#video-frame').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 800 });
  const firstReport = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/bilibili/history'));
  await page.locator('#video-history').check();
  assert.equal((await firstReport).status(), 200);
  await settings.click();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].mid, '12345');
  assert.equal(reports[0].csrf, csrf);
  assert.ok(Number(reports[0].played_time) >= 1);
  assert.equal(reports[0].play_type, '1');
  await page.locator('#seek').evaluate(node => {
    node.value = '100';
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await play.click();
  await page.waitForFunction(() => document.querySelector('#video-stage video').currentTime > 59.2);
  const finalReport = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/bilibili/history'));
  await page.locator('#video-close').click();
  assert.equal((await finalReport).status(), 200);
  await page.getByRole('link', { name: '公开样片 · 在插件中播放' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#video-stage video'));
  assert.equal(await page.locator('main > #player').count(), 1);
  assert.equal(await page.locator('#player-title').textContent(), '暂无播放');
  assert.ok(reports.some(report => Number(report.played_time) >= 59), 'closing should report the final position');
  await page.locator('#bilibili-account-action').click();
  await page.locator('#empty-login').waitFor();
  assert.equal((await fetch(manifest)).status, 401);
  assert.deepEqual(errors, []);
  console.log('Bilibili playback: shared controls, fullscreen, narrow layout, seeking, opt-in history and logout passed.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
