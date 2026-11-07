import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.DSH_HOME) throw new Error('Use a temporary DSH_HOME with the plugin already installed in profile web.');
const path = process.env.PLAYWRIGHT_MODULE ||
  resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(path));
const host = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH did not start in 20 seconds')), 20_000);
    host.once('error', error => { clearTimeout(timer); reject(error); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error('DSH exited with code ' + code)); });
    let received = '';
    host.stdout.on('data', chunk => {
      received += chunk;
      const url = received.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)\r?\n/)?.[1];
      if (url) { clearTimeout(timer); resolve(url); }
    });
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-proxy-server', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  await page.goto(address, { waitUntil: 'domcontentloaded' });
  const sidebar = page.getByRole('button', { name: 'deepsounds', exact: true });
  async function dismissOnboarding(timeout) {
    const dialog = page.getByRole('dialog').first();
    if (await dialog.waitFor({ timeout }).then(() => true, () => false)) {
      const close = dialog.getByRole('button', { name: /稍后|跳过|关闭|继续|Close|Skip|Later|Continue/i }).first();
      if (await close.isVisible()) await close.click();
      else {
        const heading = (await dialog.innerText()).slice(0, 500);
        await page.keyboard.press('Escape');
        if (await dialog.isVisible()) throw new Error('Unexpected DSH onboarding dialog: ' + heading);
      }
    }
  }
  await dismissOnboarding(4500);
  await dismissOnboarding(3000);
  await sidebar.first().click({ timeout: 10000 });
  const frame = page.frameLocator('iframe[title="deepsounds"]');
  await frame.getByRole('heading', { name: 'deepsounds' }).waitFor();
  await mkdir('artifacts', { recursive: true });
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
  const input = frame.getByRole('searchbox');
  const results = frame.locator('#results :is(.result-row, .playlist-card)');
  const audio = frame.locator('audio');
  const status = frame.locator('#player-status');
  const responseOf = pathname => page.waitForResponse(response => new URL(response.url()).pathname.endsWith(pathname));
  await frame.getByRole('heading', { name: '推荐歌单' }).waitFor();
  assert.ok(await frame.locator('.home-grid .playlist-card').count() >= 4);
  const covers = await frame.locator('.home-grid .playlist-card').evaluateAll(async cards => {
    const featured = cards.slice(0, 8).map(card => card.querySelector('img')).filter(Boolean);
    return (await Promise.allSettled(featured.map(img => img.decode()))).filter(result => result.status === 'fulfilled').length;
  });
  assert.ok(covers >= 4, 'recommended cover art should load from the CDN');
  assert.equal(await frame.locator('#empty-icon').isVisible(), false);
  await page.screenshot({ path: 'artifacts/audio-music-home.png' });

  await input.fill('海阔天空');
  const searchResponse = responseOf('/api/search');
  await input.press('Enter');
  const { items } = await (await searchResponse).json();
  await results.first().waitFor();
  await dismissOnboarding(3000);
  const blocked = items.findIndex(item => item.id === '1357375695');
  const playable = items.findIndex(item => item.id === '1357374736');
  assert.ok(blocked >= 0 && playable >= 0);
  const songTitle = items[playable].title;
  await frame.locator('#results li').nth(playable).getByRole('button', { name: '收藏歌曲', exact: true }).click();
  await frame.locator('#track-favorites').click();
  await results.filter({ hasText: songTitle }).waitFor();
  const repeatedSearch = responseOf('/api/search');
  await input.press('Enter');
  await repeatedSearch;
  await results.nth(playable).waitFor();

  await results.nth(blocked).click();
  await status.filter({ hasText: '当前无法完整播放这首歌。' }).waitFor();
  assert.equal(await audio.getAttribute('src'), null);
  await results.nth(playable).click();
  await audio.waitFor({ state: 'attached' });
  const playing = () => audio.evaluate(node => new Promise((resolve, reject) => {
    const check = () => {
      if (node.currentTime > 0.2 && !node.paused) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(node.duration);
      }
    };
    const interval = setInterval(check, 100);
    const timer = setTimeout(() => { clearInterval(interval); reject(new Error('Audio did not start')); }, 16_000);
    check();
  }));
  assert.ok(await playing() > 100, 'real audio should have full duration');
  await frame.locator('#play-toggle').click();
  assert.equal(await audio.evaluate(node => node.paused), true);
  await frame.locator('#play-toggle').click();
  assert.equal(await audio.evaluate(node => node.paused), false);
  await frame.locator('#lyrics-toggle').click();
  await frame.locator('.lyric-line').first().waitFor();
  await frame.locator('#seek').evaluate(node => {
    node.value = '200';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await frame.locator('.lyric-line[aria-current]').waitFor();
  assert.ok(await audio.evaluate(node => node.currentTime) >= 44);
  assert.ok((await frame.locator('.lyric-line[aria-current]').textContent()).trim());
  await frame.locator('#lyric-cover img').evaluate(img => img.decode());
  await frame.locator('#lyrics-close').click();
  const beforeSwitch = await audio.evaluate(node => {
    node.dataset.continuityCheck = 'original';
    return node.currentTime;
  });
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.locator('iframe[title="deepsounds"]').waitFor({ state: 'hidden' });
  const parkedTime = await audio.evaluate((node, start) => new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!node.paused && node.currentTime > start + 0.5) {
        clearInterval(timer);
        clearTimeout(deadline);
        resolve(node.currentTime);
      }
    }, 50);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      reject(new Error('Playback did not advance while the player was hidden'));
    }, 5000);
  }), beforeSwitch);
  await sidebar.first().click();
  await frame.getByRole('heading', { name: 'deepsounds' }).waitFor();
  assert.equal(await audio.getAttribute('data-continuity-check'), 'original');
  assert.equal(await input.inputValue(), '海阔天空');
  assert.equal(await results.nth(playable).getAttribute('aria-current'), 'true');
  assert.ok(await audio.evaluate(node => !node.paused && node.currentTime >= 45));
  assert.ok(parkedTime > beforeSwitch);

  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const expandRight = page.getByRole('button', { name: '打开右侧边栏', exact: true });
  const right = page.locator('[data-sidebar-right-panel][data-sidebar-right-open="true"]');
  const playerFrame = 'iframe[title="deepsounds"]';
  await expandRight.click();
  await right.getByRole('button', { name: /^deepsounds/ }).click();
  await right.locator(playerFrame).waitFor();
  assert.ok(await page.getByRole('textbox', { name: /描述你想要构建的内容/ }).isVisible());
  const openNavigation = frame.getByRole('button', { name: '打开内容导航' });
  const sideDrawer = frame.getByRole('dialog', { name: '内容导航' });
  assert.equal(await frame.locator('#content-rail').isVisible(), false);
  assert.equal(await frame.locator('main').evaluate(node => node.clientWidth === innerWidth), true);
  await openNavigation.click();
  await sideDrawer.getByRole('heading', { name: 'deepsounds' }).waitFor();
  await page.keyboard.press('Escape');
  await sideDrawer.waitFor({ state: 'hidden' });
  assert.equal(await page.locator(playerFrame).count(), 1);
  assert.equal(await input.inputValue(), '海阔天空');
  assert.equal(await audio.getAttribute('data-continuity-check'), 'original');
  const sideTime = await audio.evaluate(node => node.currentTime);
  await right.getByRole('button', { name: '收起右侧边栏', exact: true }).click();
  await page.locator(playerFrame).waitFor({ state: 'hidden' });
  await audio.evaluate(async (node, start) => {
    await new Promise(resolve => setTimeout(resolve, 650));
    if (node.paused || node.currentTime <= start) throw new Error('Playback did not advance while the right sidebar was collapsed');
  }, sideTime);
  await expandRight.click();
  await right.locator(playerFrame).waitFor();
  await sidebar.first().click();
  await page.locator(playerFrame).waitFor();
  assert.equal(await right.locator(playerFrame).count(), 0);
  assert.equal(await audio.getAttribute('data-continuity-check'), 'original');
  assert.equal(await audio.evaluate(node => node.paused), false);

  await frame.getByRole('button', { name: '歌单', exact: true }).click();
  await input.fill('轻音乐');
  const playlistSearch = responseOf('/api/search');
  await input.press('Enter');
  const search = await (await playlistSearch).json();
  assert.ok(search.items.length > 0 && typeof search.items[0].count === 'number');
  const link = 'https://music.163.com/#/playlist?id=2392709157';
  await input.fill(link);
  const playlistRequest = responseOf('/api/playlist');
  await input.press('Enter');
  const playlist = await (await playlistRequest).json();
  assert.equal(playlist.playlist.id, '2392709157');
  assert.ok(playlist.items.length > 0 && playlist.next !== null);
  await frame.locator('#collection-cover img').evaluate(img => img.decode());
  await frame.locator('.result-row img').evaluateAll(images => Promise.allSettled(images.slice(0, 7).map(img => img.decode())));
  const more = frame.getByRole('button', { name: '加载更多' });
  await more.waitFor();
  const nextPage = responseOf('/api/playlist');
  await more.click();
  const second = await (await nextPage).json();
  assert.ok(second.items.length > 0);
  assert.notEqual(second.items[0].id, playlist.items[0].id);

  const switcher = frame.getByRole('group', { name: '内容来源' });
  const podcastSource = switcher.getByRole('button', { name: '小宇宙', exact: true });
  const musicSource = switcher.getByRole('button', { name: '网易云音乐', exact: true });
  const musicSrc = await audio.getAttribute('src');
  await podcastSource.click();
  await frame.getByRole('heading', { name: '热门播客' }).waitFor();
  assert.equal(await audio.getAttribute('src'), musicSrc);
  assert.equal(await audio.evaluate(node => node.paused), false);
  await frame.locator('.home-grid img').evaluateAll(images => Promise.allSettled(images.slice(0, 8).map(img => img.decode())));
  await page.screenshot({ path: 'artifacts/audio-podcast-home.png' });
  await input.fill('随机波动');
  const podcastsRequest = responseOf('/api/podcast/search');
  await input.press('Enter');
  const podcasts = await (await podcastsRequest).json();
  assert.ok(podcasts.items.some(item => item.id === '5e7cc741418a84a046b0c2bd'));
  await results.filter({ hasText: '随机波动StochasticVolatility' }).first().click();
  await frame.locator('.result-row').first().waitFor();
  assert.ok(await frame.locator('.result-row').count() >= 1);
  await frame.locator('#collection-save').click();
  assert.equal(await frame.locator('#collection-save').getAttribute('aria-pressed'), 'true');
  await frame.locator('#podcast-favorites').click();
  await results.filter({ hasText: '随机波动StochasticVolatility' }).first().waitFor();

  const episodeId = '63c91b2e78910ae65c9a5748';
  await input.fill('https://www.xiaoyuzhoufm.com/episode/' + episodeId);
  const episodeRequest = responseOf('/api/podcast/episode');
  await input.press('Enter');
  const episode = await (await episodeRequest).json();
  assert.equal(episode.playlist.id, episodeId);
  const episodeTitle = episode.items[0].title;
  await frame.locator('#results').getByRole('button', { name: '收藏单集', exact: true }).click();
  await frame.locator('#results').getByRole('button', { name: '加入本机队列', exact: true }).click();
  await frame.locator('#track-favorites').click();
  await results.filter({ hasText: episodeTitle }).waitFor();
  await frame.locator('#queue-toggle').click();
  await frame.getByRole('heading', { name: '本机队列', exact: true }).waitFor();
  assert.ok(await results.filter({ hasText: '网易云音乐' }).count() > 0);
  await page.screenshot({ path: 'artifacts/audio-mixed-queue.png' });
  const mediaRequest = responseOf('/api/podcast/stream');
  await results.filter({ hasText: episodeTitle }).click();
  const media = await (await mediaRequest).json();
  assert.match(media.url, /^https:\/\/[^/]+\.xyzcdn\.net\//);
  assert.ok(await playing() > 1200);
  await frame.getByRole('button', { name: '单集简介', exact: true }).click();
  await frame.getByRole('heading', { name: '单集简介', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/audio-podcast-playing.png' });
  await frame.locator('#lyrics-close').click();
  await frame.locator('#queue-toggle').click();
  await input.press('Enter');
  await results.filter({ hasText: episodeTitle }).waitFor();
  await musicSource.click();
  assert.match(await frame.locator('#results-title').textContent(), /轻音乐/);
  assert.equal(await audio.getAttribute('src'), media.url);
  assert.equal(await audio.evaluate(node => node.paused), false);
  await podcastSource.click();
  assert.match(await frame.locator('#results-title').textContent(), /挣脱社会期待/);

  await frame.locator('#podcast-playback-list').click();
  await frame.getByRole('heading', { name: '小宇宙播放列表' }).waitFor();
  await frame.locator('#empty-login').click();
  await frame.getByRole('dialog', { name: '扫码登录小宇宙' }).waitFor();
  await frame.getByRole('img', { name: '小宇宙登录二维码' }).waitFor();
  const pollRequest = responseOf('/api/podcast/login/check');
  assert.equal((await (await pollRequest).json()).state, 'waiting');
  await frame.getByRole('dialog', { name: '扫码登录小宇宙' }).getByRole('button', { name: '取消' }).click();

  // The live QR was not scanned. Exercise signed-in queue behavior using a separate fixture.
  const fakeToken = 'T'.repeat(43);
  const other = { id: 'a'.repeat(24), title: '排在前面的单集', artists: '测试节目', missing: true };
  let syncs = 0;
  await page.route(url => url.pathname.endsWith('/api/podcast/login/start'), route => route.fulfill({ json: { token: fakeToken, qr: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' } }));
  await page.route(url => url.pathname.endsWith('/api/podcast/login/check'), route => route.fulfill({ json: { state: 'signed-in', profile: { id: 'fixture', name: '测试听众' } } }));
  await page.route(url => url.pathname.endsWith('/api/podcast/playback-list'), route => {
    assert.equal(route.request().headers()['x-podcast-session'], fakeToken);
    syncs++;
    if (syncs === 1) return route.fulfill({ status: 502, json: { error: '小宇宙未返回完整的播放列表，请重新同步。' } });
    return route.fulfill({ json: { items: syncs === 2 ? [other, episode.items[0]] : [episode.items[0], other], next: null } });
  });
  await frame.locator('#empty-login').click();
  await frame.locator('#result-status').filter({ hasText: '小宇宙未返回完整的播放列表' }).waitFor();
  assert.equal(await frame.locator('#more').isVisible(), false);
  await frame.locator('#collection-sync').click();
  await results.filter({ hasText: episodeTitle }).waitFor({ timeout: 10_000 }).catch(async error => {
    throw new Error('Cloud queue fixture: ' + (await frame.locator('#result-status').textContent()) +
      ' / ' + (await frame.locator('#podcast-login-status').textContent()) + '; sync requests: ' + syncs, { cause: error });
  });
  assert.equal(await results.first().locator('.row-title').textContent(), other.title);
  await frame.locator('#collection-sync').click();
  await results.first().filter({ hasText: episodeTitle }).waitFor();
  assert.equal(syncs, 3);
  await page.screenshot({ path: 'artifacts/audio-podcast-cloud-queue.png' });

  const biliSource = switcher.getByRole('button', { name: '哔哩哔哩', exact: true });
  await biliSource.click();
  await frame.getByRole('heading', { name: '收藏夹', exact: true }).waitFor();
  assert.equal(await audio.getAttribute('src'), media.url);
  assert.equal(await audio.evaluate(node => node.paused), false);
  const biliPoll = responseOf('/api/bilibili/login/check');
  await frame.locator('#empty-login').click();
  const biliDialog = frame.getByRole('dialog', { name: '扫码登录哔哩哔哩' });
  await biliDialog.getByRole('img', { name: '哔哩哔哩登录二维码' }).waitFor();
  assert.equal((await (await biliPoll).json()).state, 'waiting');
  await biliDialog.getByRole('button', { name: '取消' }).click();

  const biliToken = 'B'.repeat(43);
  const sampleVideo = { id: 'BV1B7411m7LV', title: '收藏的视频', owner: '测试 UP 主', ownerId: '19',
    published: 1793990000, duration: 590_000,
    url: 'https://www.bilibili.com/video/BV1B7411m7LV/' };
  const biliFixture = {
    'login/start': { token: biliToken, qr: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' },
    'login/check': { state: 'signed-in', profile: { id: '42', name: '测试观众' } },
    'login/clear': { ok: true },
    favorites: { items: [{ id: '23', title: '我的视频收藏', count: 1 }], next: null },
    'watch-later': { items: [{ ...sampleVideo, title: '稍后再看的视频' }], next: null },
    creator: { items: [{ ...sampleVideo, title: '关注的 UP 主投稿' }], next: null },
    'video-relation': { liked: false, favorite: true },
  };
  const author = { id: '19', title: '测试 UP 主', url: 'https://space.bilibili.com/19/video' };
  const oldUpdate = { ...sampleVideo, title: '已有投稿', updateId: '1159999999999999999' };
  const newUpdate = { ...sampleVideo, title: '新的关注投稿', updateId: '1160000000000000000' };
  let newerUpload = false;
  let updateChecks = 0;
  let isFollowing = true;
  const folderPages = [];
  await page.route(url => url.pathname.includes('/api/bilibili/'), route => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.split('/api/bilibili/')[1];
    if (endpoint !== 'login/start' && endpoint !== 'login/clear') assert.equal(route.request().headers()['x-bilibili-session'], biliToken);
    if (endpoint === 'playback') {
      return route.fulfill({ status: 503, json: { error: '模拟账号播放器暂不可用。' } });
    }
    if (endpoint === 'folder') {
      const offset = url.searchParams.get('offset');
      folderPages.push(offset);
      if (url.searchParams.get('id') !== '23' || !['1', '2'].includes(offset)) {
        return route.fulfill({ status: 400, json: { error: '无效的哔哩哔哩收藏夹或页码。' } });
      }
      return route.fulfill({ json: {
        playlist: { title: '我的视频收藏' },
        items: [offset === '1' ? sampleVideo : { ...sampleVideo, id: 'av170001', title: '下一页的视频' }],
        next: offset === '1' ? 2 : null,
      } });
    }
    if (endpoint === 'updates') {
      updateChecks++;
      return route.fulfill({ json: { items: newerUpload ? [newUpdate, oldUpdate] : [oldUpdate], next: null } });
    }
    if (endpoint === 'creator-relation' || endpoint === 'follow') {
      assert.equal(url.searchParams.get('id'), '19');
      if (endpoint === 'follow') {
        assert.equal(route.request().method(), 'POST');
        isFollowing = url.searchParams.get('enabled') === '1';
      }
      return route.fulfill({ json: { following: isFollowing } });
    }
    if (endpoint === 'following') {
      const page = url.searchParams.get('offset');
      return route.fulfill({ json: {
        items: [page === '1' ? author : { id: '20', title: '下一页的 UP 主' }], next: page === '1' ? 2 : null,
      } });
    }
    if (endpoint === 'search') {
      const items = url.searchParams.get('kind') === 'playlist' ? [author] : [{ ...sampleVideo, title: '搜索到的视频' }];
      return route.fulfill({ json: { items, next: null } });
    }
    return route.fulfill({ json: biliFixture[endpoint] });
  });
  await frame.locator('#empty-login').click();
  await frame.getByRole('button', { name: /我的视频收藏/ }).click();
  const video = frame.getByRole('link', { name: '收藏的视频 · 在插件中播放' });
  await video.waitFor();
  await frame.locator('#more').click();
  await frame.getByRole('link', { name: '下一页的视频 · 在插件中播放' }).waitFor();
  assert.deepEqual(folderPages, ['1', '2']);
  assert.equal(await frame.locator('#more').isVisible(), false);
  await video.click();
  const embeddedPlayer = frame.locator('#video-stage iframe');
  assert.match(await embeddedPlayer.getAttribute('src'), /^https:\/\/player\.bilibili\.com\/player\.html\?.*bvid=BV1B7411m7LV/);
  assert.equal(await frame.locator('#player').isVisible(), false);
  assert.equal(await frame.locator('#video-official').getAttribute('href'), sampleVideo.url);
  assert.equal(await audio.evaluate(node => node.paused), true);
  const embed = frame.frameLocator('#video-stage iframe');
  const embedPlay = embed.locator('[aria-label="播放/暂停"]');
  await embedPlay.waitFor({ state: 'attached', timeout: 20_000 });
  await embeddedPlayer.hover();
  await embedPlay.click({ timeout: 10_000 });
  await embed.locator('video').evaluate(node => new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!node.paused && node.currentTime > 0.3) {
        clearInterval(timer);
        clearTimeout(deadline);
        resolve();
      }
    }, 100);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Embedded video did not start')); }, 18_000);
  }));
  await frame.locator('#video-close').click();
  assert.equal(await embeddedPlayer.count(), 0);
  assert.equal(await frame.locator('#player').isVisible(), true);
  await video.waitFor();
  await frame.locator('#bilibili-watch-later').click();
  const laterVideo = frame.getByRole('link', { name: '稍后再看的视频 · 在插件中播放' });
  await laterVideo.click();
  await embeddedPlayer.waitFor();
  await frame.locator('#video-close').click();
  await laterVideo.waitFor();
  await page.screenshot({ path: 'artifacts/audio-bilibili-watch-later.png' });

  await frame.locator('#bilibili-following').click();
  await frame.getByRole('button', { name: '测试 UP 主', exact: true }).waitFor();
  await frame.locator('#more').click();
  await frame.getByRole('button', { name: '下一页的 UP 主', exact: true }).waitFor();
  await frame.getByRole('button', { name: '测试 UP 主', exact: true }).click();
  await frame.getByRole('link', { name: '关注的 UP 主投稿 · 在插件中播放' }).waitFor();
  await frame.locator('#creator-follow[aria-pressed="true"]').click();
  await frame.locator('#creator-follow[aria-pressed="false"]').click();
  await frame.locator('#creator-follow[aria-pressed="true"]').waitFor();
  await input.fill('钢琴');
  await input.press('Enter');
  await frame.getByRole('link', { name: '搜索到的视频 · 在插件中播放' }).waitFor();
  await frame.getByRole('button', { name: 'UP 主', exact: true }).click();
  await frame.getByRole('button', { name: '测试 UP 主', exact: true }).waitFor();

  await page.clock.install();
  await frame.locator('body').evaluate(() => {
    window.testNotices = [];
    window.Notification = class {
      static permission = 'granted';
      constructor(title, options) { window.testNotices.push([title, options.body]); }
      close() {}
    };
  });
  await frame.locator('#bilibili-updates').click();
  await frame.getByRole('link', { name: '已有投稿 · 在插件中播放' }).waitFor();
  const baselineRequest = responseOf('/api/bilibili/updates');
  await frame.locator('#bilibili-update-toggle').click();
  await baselineRequest;
  assert.equal(await frame.locator('#bilibili-update-count').isVisible(), false);
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.locator('iframe[title="deepsounds"]').waitFor({ state: 'hidden' });
  newerUpload = true;
  const nextUpdate = responseOf('/api/bilibili/updates');
  await page.clock.fastForward(5 * 60_000 + 1000);
  await nextUpdate;
  await sidebar.first().click();
  await frame.locator('#bilibili-update-count').waitFor();
  assert.equal(await frame.locator('#bilibili-update-count').textContent(), '1');
  assert.deepEqual(await frame.locator('body').evaluate(() => window.testNotices), [['测试 UP 主', '新的关注投稿']]);
  const beforeRefresh = updateChecks;
  await frame.locator('#collection-sync').click();
  await frame.getByRole('link', { name: '新的关注投稿 · 在插件中播放' }).waitFor();
  assert.equal(updateChecks, beforeRefresh + 1);
  assert.equal(await frame.locator('.video-new:not([hidden])').count(), 1);
  assert.equal(await frame.locator('body').evaluate(() => window.testNotices.length), 1);
  await frame.locator('#bilibili-update-read').click();
  assert.equal(await frame.locator('#bilibili-update-count').isVisible(), false);
  await page.screenshot({ path: 'artifacts/audio-bilibili-following-updates.png' });
  await frame.locator('#bilibili-account-action').click();
  await frame.locator('#empty-login').waitFor();
  await podcastSource.click();
  assert.equal(await frame.locator('#podcast-account-action').textContent(), '退出登录');

  const standalone = await browser.newPage({ viewport: { width: 320, height: 760 }, colorScheme: 'dark' });
  await standalone.goto(new URL('/deepsounds/', address).href);
  const mobileMenu = standalone.getByRole('button', { name: '打开内容导航' });
  const mobileDrawer = standalone.getByRole('dialog', { name: '内容导航' });
  await mobileMenu.click();
  await mobileDrawer.getByRole('button', { name: '小宇宙', exact: true }).click();
  await mobileDrawer.waitFor({ state: 'hidden' });
  await standalone.getByRole('searchbox').fill('https://www.xiaoyuzhoufm.com/podcast/5e7cc741418a84a046b0c2bd');
  await standalone.getByRole('searchbox').press('Enter');
  await standalone.locator('.result-row').first().waitFor();
  await standalone.locator('#collection-cover img').evaluate(img => img.decode());
  const queuedTitle = await standalone.locator('.result-row:not(:disabled) .row-title').first().textContent();
  await standalone.locator('.queue-add:not(:disabled)').first().click();
  await standalone.reload();
  await standalone.locator('#queue-toggle').click();
  await standalone.locator('#results .row-title').filter({ hasText: queuedTitle }).waitFor();
  await standalone.getByRole('button', { name: '从本机队列移除' }).click();
  assert.equal(await standalone.locator('#results .result-row').count(), 0);
  await standalone.getByRole('searchbox').fill('https://www.xiaoyuzhoufm.com/podcast/5e7cc741418a84a046b0c2bd');
  await standalone.getByRole('searchbox').press('Enter');
  await standalone.locator('.result-row').first().waitFor();
  assert.equal(await standalone.evaluate(() => document.documentElement.scrollWidth), 320);
  assert.equal(await standalone.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark');
  await standalone.screenshot({ path: 'artifacts/audio-podcast-mobile.png' });
  await mobileMenu.click();
  const cloudNav = await mobileDrawer.locator('#podcast-playback-list').boundingBox();
  assert.ok(cloudNav && cloudNav.x + cloudNav.width < 320, 'the cloud playlist shortcut is visible in the drawer at 320px');
  await mobileDrawer.getByRole('button', { name: '哔哩哔哩', exact: true }).click();
  await mobileDrawer.waitFor({ state: 'hidden' });
  await standalone.locator('#empty-login').waitFor();
  assert.ok((await standalone.locator('#collection').boundingBox()).height > 500, 'the Bilibili library fills the mobile workspace');
  assert.equal(await standalone.evaluate(() => document.documentElement.scrollWidth), 320);
  console.log('DSH Web: live embedded Bilibili playback, three sources, audio, QR waiting, queues, and 320px layout passed.');
} finally {
  try { await browser?.close(); } finally { host.kill(); }
}
