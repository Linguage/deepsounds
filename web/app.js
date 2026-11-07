import { activeLine, mergeLyrics } from './lyrics.js';
import { accountPanel, request } from './account.js';
import { bilibiliPlayerUrl, parseShare } from './links.js';
import { monitorBilibiliUpdates } from './bilibili-updates.js';

const get = id => document.getElementById(id);
const form = get('search-form');
const query = get('query');
const filters = [...document.querySelectorAll('[data-kind]')];
const sources = [...document.querySelectorAll('[data-source]')];
const results = get('results');
const resultMeta = get('result-meta');
const resultStatus = get('result-status');
const more = get('more');
const back = get('back');
const myPlaylists = get('my-playlists');
const podcastFavorites = get('podcast-favorites');
const trackFavorites = get('track-favorites');
const cloudQueue = get('podcast-playback-list');
const watchLater = get('bilibili-watch-later');
const biliFollowing = get('bilibili-following');
const biliUpdates = get('bilibili-updates');
const updateToggle = get('bilibili-update-toggle');
const updateRead = get('bilibili-update-read');
const updateHint = get('bilibili-update-hint');
const updateToast = get('bilibili-update-toast');
const queueToggle = get('queue-toggle');
const collectionSync = get('collection-sync');
const home = get('home');
const collectionView = get('collection');
const audio = get('audio');
const player = get('player');
const playerHome = player.parentNode;
const previous = get('previous');
const next = get('next');
const playToggle = get('play-toggle');
const seek = get('seek');
const volume = get('volume');
const mute = get('mute');
const retry = get('retry');
const official = get('official');
const playerStatus = get('player-status');
const lyricScroll = get('lyric-scroll');
const lyricStatus = get('lyric-status');
const lyricLines = get('lyric-lines');
const lyricsPanel = get('lyrics-panel');
const lyricsToggle = get('lyrics-toggle');
const videoPanel = get('video-panel');
const videoFrame = get('video-frame');
const videoStage = get('video-stage');
const videoClose = get('video-close');
const videoSettings = get('video-settings');
const videoModes = get('video-modes');
const defaultSize = get('video-default');
const theater = get('video-theater');
const fullscreen = get('video-fullscreen');
const videoLike = get('video-like');
const videoSave = get('video-save');
const videoFollow = get('video-follow');
const videoActionsRetry = get('video-actions-retry');
const videoActionStatus = get('video-action-status');
const saveDialog = get('video-save-dialog');
const saveFolders = get('video-save-folders');
const saveStatus = get('video-save-status');
const saveApply = get('video-save-apply');
const creatorFollow = get('creator-follow');
const creatorActionStatus = get('creator-action-status');

const sourceViews = new Map();
const homeCollections = new Map();
const sourcePreference = 'dsh-audio-source';
const favoritesKey = 'dsh-audio-podcast-favorites';
const trackFavoritesKey = 'dsh-audio-track-favorites';
const pendingKey = 'dsh-audio-pending-queue';
let source = readLocal(sourcePreference);
if (!sources.some(button => button.dataset.source === source)) source = 'netease';
let kind = source === 'xiaoyuzhou' ? 'playlist' : 'song';
let collection;
let previousCollection;
let listing;
let listening;
let queue = readTracks(pendingKey).map(item => ({ ...item, manual: true }));
let queueIndex = -1;
let queueSource;
let queueReturn;
let lyrics = [];
let lyricNodes = [];
let highlighted = -1;
let selectedButton;
let audioStatus = '';
let audioRetry = false;
let videoTrigger;
let activeVideo;
let biliProfileId;
let updateToastTimer;
let desktopNotice;
const biliPrivateViews = new Set(['watch-later', 'following', 'updates']);
const videoUpdates = monitorBilibiliUpdates({
  load: (signal, offset) => api('bilibili/updates', offset ? { offset } : {}, signal, true),
  read: readLocal, write: writeLocal, onChange: renderUpdateState, onNew: announceUpdates,
});
const account = accountPanel({
  onLogin() {
    if (source === 'netease') openLibrary();
  },
  onLogout: resetAfterLogout,
});
const podcastAccount = accountPanel({
  scope: 'podcast',
  onLogin() {
    if (source === 'xiaoyuzhou') {
      syncSource();
      if (collection?.type === 'cloud-queue') openCloudQueue();
      else openLibrary();
    }
  },
  onLogout(expired) {
    sourceViews.delete('xiaoyuzhou');
    if (queueReturn?.model?.source === 'xiaoyuzhou') queueReturn = null;
    if (source === 'xiaoyuzhou') {
      syncSource();
      resetCollection(expired ? '小宇宙登录已失效，请重新扫码。' : '已退出小宇宙。');
    }
  },
});
const biliAccount = accountPanel({
  scope: 'bilibili',
  onLogin(profile) {
    biliProfileId = profile.id;
    videoUpdates.connect(profile.id);
    if (source === 'bilibili') {
      if (biliPrivateViews.has(collection?.type)) openBiliList(collection.type);
      else if (!collection || collection.type === 'library') openLibrary();
      else {
        if (collection.type === 'creator-videos') loadCreatorFollow(collection);
        if (activeVideo) loadVideoActions(activeVideo);
      }
    }
  },
  onLogout(expired) {
    biliProfileId = null;
    videoUpdates.disconnect();
    updateToast.hidden = true;
    desktopNotice?.close();
    sourceViews.delete('bilibili');
    if (queueReturn?.model?.source === 'bilibili') queueReturn = null;
    if (source !== 'bilibili' || collection?.type === 'queue') return;
    if (biliPrivateViews.has(collection?.type)) openBiliList(collection.type);
    else openLibrary();
    resultStatus.textContent = expired ? '哔哩哔哩登录已失效，请重新扫码。' : '已退出哔哩哔哩。';
  },
});
const accountFor = provider => provider === 'xiaoyuzhou' ? podcastAccount : provider === 'bilibili' ? biliAccount : account;

function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function favorites() {
  try {
    const saved = JSON.parse(readLocal(favoritesKey));
    return Array.isArray(saved) ? saved.filter(item => /^[a-f0-9]{24}$/.test(item?.id) && typeof item.title === 'string') : [];
  } catch { return []; }
}

function readTracks(key) {
  try {
    const saved = JSON.parse(readLocal(key));
    return Array.isArray(saved) ? saved.filter(item => typeof item?.title === 'string' &&
      (item.source === 'xiaoyuzhou' ? /^[a-f0-9]{24}$/.test(item.id) :
        item.source === 'netease' && /^\d+$/.test(item.id))) : [];
  } catch { return []; }
}

function trackKey(item, provider = item?.source) {
  return item ? provider + ':' + item.id : '';
}

function storedTrack(item, provider) {
  const { id, title, artists, album, duration, cover, url, missing } = item;
  return { id, title, artists, album, duration, cover, url, missing, source: provider };
}

function persistQueue() {
  writeLocal(pendingKey, JSON.stringify(queue.slice(queueIndex + 1).filter(item => item.manual)));
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
}

function cover(node, url, eager = true) {
  node.replaceChildren();
  if (!url) return;
  const img = el('img');
  img.alt = '';
  img.loading = eager ? 'eager' : 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = url;
  node.append(img);
}

async function api(path, params, signal, authenticated = false, method = 'GET') {
  const session = path.startsWith('podcast/') ? podcastAccount : path.startsWith('bilibili/') ? biliAccount : account;
  const token = authenticated ? session.token : undefined;
  try {
    return await request(path, params, { signal, token, method });
  } catch (error) {
    if (error.status === 401 && token && session.token === token) session.expire();
    throw error;
  }
}

function selectKind(value) {
  kind = value;
  if (source === 'bilibili') {
    query.placeholder = kind === 'playlist' ? '搜索 UP 主' : '搜索 B 站视频';
    return;
  }
  query.placeholder = source === 'xiaoyuzhou' ? (kind === 'song' ? '搜索单集或粘贴分享链接' : '搜索节目或粘贴分享链接') :
    kind === 'song' ? '搜索歌曲、歌手或粘贴歌单链接' : '搜索歌单或粘贴歌单链接';
}

function syncSource() {
  const podcast = source === 'xiaoyuzhou';
  const bili = source === 'bilibili';
  if (podcast && !podcastAccount.token) kind = 'playlist';
  document.documentElement.dataset.provider = source;
  for (const button of sources) button.setAttribute('aria-pressed', String(button.dataset.source === source));
  for (const button of filters) button.hidden = podcast && !podcastAccount.token && button.dataset.kind === 'song';
  get('song-nav-label').textContent = bili ? '视频' : podcast ? '单集' : '歌曲';
  get('collection-nav-label').textContent = bili ? 'UP 主' : podcast ? '节目' : '歌单';
  get('library-nav-label').textContent = bili ? '收藏夹' : podcast ? '我的订阅' : '我的歌单';
  get('track-favorites-label').textContent = podcast ? '收藏单集' : '收藏歌曲';
  podcastFavorites.hidden = !podcast;
  cloudQueue.hidden = !podcast;
  watchLater.hidden = biliFollowing.hidden = biliUpdates.hidden = !bili;
  trackFavorites.hidden = bili;
  get('browse-nav').hidden = bili;
  get('netease-account').hidden = source !== 'netease';
  get('podcast-account').hidden = !podcast;
  get('bilibili-account').hidden = !bili;
  get('section-heading').textContent = podcast ? '热门播客' : '推荐歌单';
  get('item-heading').textContent = podcast ? '单集' : '名称';
  get('album-heading').textContent = podcast ? '发布日期' : '专辑';
  if (queueIndex < 0) {
    setTextMode(podcast);
    clearLyrics(podcast ? '播放单集后，这里会显示简介。' : '播放歌曲后，这里会显示歌词。');
  }
  selectKind(kind);
}

function switchSource(value, restore = true) {
  if (source === value) return;
  sourceViews.set(source, {
    collection, previousCollection, kind, query: query.value, scroll: collectionView.scrollTop,
  });
  const saved = sourceViews.get(value);
  source = value;
  writeLocal(sourcePreference, source);
  kind = saved?.kind ?? (source === 'xiaoyuzhou' ? 'playlist' : 'song');
  query.value = saved?.query ?? '';
  syncSource();
  if (!restore) return;
  if (saved?.collection) {
    previousCollection = saved.previousCollection;
    const model = saved.collection;
    if (model.type === 'favorites') model.items = favorites();
    if (model.type === 'track-favorites') model.items = savedTracks(value);
    if (model.type === 'queue') model.items = queue;
    if (model.type === 'library' && model.locked && accountFor(source).token) return openLibrary();
    if (model.type === 'cloud-queue' && model.locked && podcastAccount.token) return openCloudQueue();
    if (biliPrivateViews.has(model.type) && model.locked && biliAccount.token) return openBiliList(model.type);
    show(model, model.next === null || model.items.length > 0);
    collectionView.scrollTop = saved.scroll;
  } else if (saved) {
    resetCollection();
  } else {
    openHome();
  }
}

function syncFilters(area = kind) {
  for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.kind === area));
  myPlaylists.setAttribute('aria-pressed', String(area === 'library'));
  podcastFavorites.setAttribute('aria-pressed', String(area === 'favorites'));
  trackFavorites.setAttribute('aria-pressed', String(area === 'track-favorites'));
  cloudQueue.setAttribute('aria-pressed', String(area === 'cloud-queue'));
  watchLater.setAttribute('aria-pressed', String(area === 'watch-later'));
  biliFollowing.setAttribute('aria-pressed', String(area === 'following'));
  biliUpdates.setAttribute('aria-pressed', String(area === 'updates'));
  queueToggle.setAttribute('aria-pressed', String(area === 'queue'));
  home.setAttribute('aria-pressed', String(area === 'home'));
  get('view-label').textContent = {
    home: '浏览', library: '资料库', favorites: '资料库', 'track-favorites': '资料库',
    'cloud-queue': '小宇宙', queue: '播放器', 'watch-later': '资料库', following: '资料库', updates: '资料库',
    song: source === 'bilibili' ? '搜索视频' : source === 'xiaoyuzhou' ? '搜索单集' : '搜索歌曲',
    playlist: source === 'bilibili' ? '搜索 UP 主' : source === 'xiaoyuzhou' ? '搜索节目' : '搜索歌单',
  }[area];
}

function startSearch(text) {
  const link = parseShare(text);
  if (link) {
    switchSource(link.source, false);
    return openDetail(link.id ?? link.code, null, link.type === 'podcast' ? 'playlist' : link.type);
  }
  if (/https?:\/\//i.test(text)) {
    setLyricsVisible(false);
    resultStatus.textContent = source === 'bilibili' ? '请输入视频或 UP 主的关键词。' :
      '请粘贴网易云歌单或小宇宙节目、单集的分享链接，或输入关键词。';
    return;
  }
  if (!text) return;
  previousCollection = null;
  show({ type: 'search', kind, query: text, items: [], next: 0 });
}

function openDetail(id, prior, type = 'playlist', playlist) {
  previousCollection = prior;
  show({ type, id, playlist, items: [], next: 0 });
}

function openLibrary() {
  previousCollection = null;
  const session = accountFor(source);
  if (!session.token) return show({ type: 'library', items: [], next: null, locked: true }, true);
  show({ type: 'library', items: [], next: 0 });
}

function openBiliList(type) {
  previousCollection = null;
  if (!biliAccount.token) return show({ type, items: [], next: null, locked: true }, true);
  show({ type, items: [], next: 0 });
}

function openBiliUpdates() {
  switchSource('bilibili', false);
  updateToast.hidden = true;
  openBiliList('updates');
}

function renderUpdateState(state) {
  const unread = new Set(state.unread);
  const count = unread.size;
  const badge = get('bilibili-update-count');
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  get('bilibili-update-dot').hidden = count === 0;
  updateToggle.setAttribute('aria-pressed', String(state.enabled));
  updateToggle.textContent = state.enabled ? '关闭提醒' : '开启提醒';
  const visible = collection?.type === 'updates' && !collection.locked;
  updateRead.hidden = !visible || !count;
  updateHint.hidden = !visible;
  updateHint.textContent = state.enabled
    ? window.Notification?.permission === 'granted' ? '约每 5 分钟检查一次新投稿。' : '约每 5 分钟检查一次新投稿，未读数会显示在侧栏。'
    : '开启后，DSH 运行期间会检查新投稿。';
  for (const marker of results.querySelectorAll('.video-new')) marker.hidden = !unread.has(marker.dataset.updateId);
}

function announceUpdates(items) {
  const title = items.length === 1 ? items[0].owner || 'B 站关注更新' : 'B 站关注更新';
  const message = items.length === 1 ? items[0].title : items.length + ' 个新视频';
  updateToast.textContent = title + ' · ' + message;
  updateToast.hidden = false;
  clearTimeout(updateToastTimer);
  updateToastTimer = setTimeout(() => { updateToast.hidden = true; }, 8000);
  if (window.Notification?.permission === 'granted') {
    try {
      desktopNotice?.close();
      desktopNotice = new Notification(title, { body: message });
      desktopNotice.onclick = () => { window.focus(); openBiliUpdates(); desktopNotice?.close(); };
    } catch { /* The in-app reminder is available when system notifications are blocked. */ }
  }
}

function openFavorites() {
  previousCollection = null;
  show({ type: 'favorites', items: favorites(), next: null }, true);
}

function savedTracks(provider = source) {
  return readTracks(trackFavoritesKey).filter(item => item.source === provider);
}

function openTrackFavorites() {
  previousCollection = null;
  show({ type: 'track-favorites', items: savedTracks(), next: null }, true);
}

function openCloudQueue() {
  previousCollection = null;
  if (!podcastAccount.token) return show({ type: 'cloud-queue', items: [], next: null, locked: true }, true);
  show({ type: 'cloud-queue', items: [], next: 0 });
}

function toggleQueue() {
  if (collection?.type === 'queue') {
    if (!queueReturn || queueReturn.model?.source !== source) return openHome();
    const { model, prior, scroll } = queueReturn;
    queueReturn = null;
    previousCollection = prior;
    show(model, model.items.length > 0 || model.next === null);
    collectionView.scrollTop = scroll;
    return;
  }
  queueReturn = { model: collection, prior: previousCollection, scroll: collectionView.scrollTop };
  previousCollection = null;
  show({ type: 'queue', items: queue, next: null }, true);
}

function openHome() {
  if (source === 'bilibili') return openLibrary();
  previousCollection = null;
  if (!homeCollections.has(source)) homeCollections.set(source, { type: 'home', items: [], next: 0 });
  const model = homeCollections.get(source);
  show(model, model.next === null);
}

function describeCollection({ empty = false, coverUrl = null, kicker = '', description = '', play = false, login = false } = {}) {
  collectionView.dataset.empty = String(empty);
  get('empty-icon').toggleAttribute('hidden', !empty);
  const art = get('collection-cover');
  art.hidden = !coverUrl;
  cover(art, coverUrl);
  const label = get('collection-kicker');
  label.hidden = !kicker;
  label.textContent = kicker;
  const detail = get('collection-description');
  detail.hidden = !description;
  detail.textContent = description;
  get('collection-play').hidden = !play;
  get('empty-login').hidden = !login;
  get('collection-save').hidden = get('collection-official').hidden = true;
  creatorFollow.hidden = creatorActionStatus.hidden = true;
  collectionSync.hidden = true;
  updateToggle.hidden = updateRead.hidden = updateHint.hidden = true;
}

function resetCollection(message) {
  closeVideo();
  listing?.abort();
  listing = collection = previousCollection = null;
  selectedButton = null;
  back.hidden = more.hidden = true;
  results.replaceChildren();
  results.className = '';
  get('list-heading').hidden = get('section-heading').hidden = get('podcast-index-credit').hidden = true;
  describeCollection({ empty: true });
  const podcast = source === 'xiaoyuzhou';
  const bili = source === 'bilibili';
  resultMeta.textContent = podcast ? (kind === 'song' ? '按名称搜索单集，或粘贴小宇宙分享链接。' : '按名称搜索播客，或粘贴小宇宙分享链接。') :
    bili ? '输入关键词，搜索 B 站视频或 UP 主。' :
      kind === 'song' ? '搜索歌曲和歌手，或粘贴网易云公开歌单链接。' : '搜索歌单名称，或粘贴网易云公开歌单链接。';
  get('results-title').textContent = podcast ? (kind === 'song' ? '搜索单集' : '搜索节目') :
    bili ? (kind === 'song' ? '搜索视频' : '搜索 UP 主') : kind === 'song' ? '搜索音乐' : '搜索歌单';
  resultStatus.textContent = message ?? '';
  setLyricsVisible(false);
  syncFilters();
}

function resetAfterLogout(expired) {
  sourceViews.delete('netease');
  if (source === 'netease') resetCollection(expired ? '登录已失效，请重新扫码。' : '已退出网易云音乐。');
  if (queue[queueIndex]?.source !== 'netease' || expired) return;
  listening?.abort();
  listening = queueSource = null;
  queue = queue.slice(queueIndex + 1).filter(item => item.manual);
  queueIndex = -1;
  renderQueueControls();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  syncPlayer();
  if (collection?.type === 'queue') refreshQueueView();
  setAudioStatus('');
  renderPlayerTrack();
  setLyricTrack();
  setTextMode(source === 'xiaoyuzhou');
  clearLyrics(source === 'xiaoyuzhou' ? '播放单集后，这里会显示简介。' : '播放歌曲后，这里会显示歌词。');
}

function show(model, restored = false) {
  closeVideo();
  listing?.abort();
  listing = null;
  model.source ??= source;
  if (model.needsRefresh) {
    model.needsRefresh = false;
    model.items = [];
    model.next = 0;
    restored = false;
  }
  collection = model;
  collectionView.scrollTop = 0;
  setLyricsVisible(false);
  resultStatus.textContent = '';
  renderCollection();
  if (model.type === 'creator-videos') loadCreatorFollow(model);
  if (!restored) loadPage();
}

async function loadPage() {
  const current = collection;
  if (!current || listing || current.next === null) return;
  const request = new AbortController();
  listing = request;
  const initial = current.items.length === 0;
  more.disabled = true;
  const hasRefresh = current.type === 'cloud-queue' || current.type === 'updates';
  if (hasRefresh) collectionSync.disabled = true;
  resultStatus.textContent = initial ? '正在加载…' : '正在加载更多…';
  try {
    let payload;
    if (current.source === 'bilibili') {
      const path = { library: 'favorites', 'watch-later': 'watch-later', 'video-folder': 'folder',
        following: 'following', updates: 'updates', 'creator-videos': 'creator', search: 'search' }[current.type];
      const params = {};
      if (current.id) params.id = current.id;
      if (current.next !== 0) params.offset = current.next;
      else if (['video-folder', 'following', 'search'].includes(current.type)) params.offset = 1;
      if (current.type === 'search') Object.assign(params, { q: current.query, kind: current.kind });
      payload = await api('bilibili/' + path, params, request.signal, true);
    } else if (current.source === 'xiaoyuzhou') {
      if (current.type === 'short') {
        const link = await api('podcast/link', { code: current.id }, request.signal);
        if (listing === request) openDetail(link.id, null, link.type === 'episode' ? 'episode' : 'playlist');
        return;
      }
      const path = { home: 'recommendations', playlist: 'show', episode: 'episode', search: 'search',
        library: 'subscriptions', 'cloud-queue': 'playback-list' }[current.type];
      const params = current.type === 'search' ? { q: current.query, kind: current.kind, offset: current.next } :
        { id: current.id ?? '', offset: current.next };
      payload = await api('podcast/' + path, params, request.signal, ['search', 'playlist', 'library', 'cloud-queue'].includes(current.type));
    } else if (current.type === 'home') {
      payload = await api('recommendations', {}, request.signal);
    } else if (current.type === 'playlist') {
      payload = await api('playlist', { id: current.id, offset: current.next }, request.signal, true);
    } else if (current.type === 'library') {
      payload = await api('my-playlists', { offset: current.next }, request.signal, true);
    } else {
      payload = await api('search', { q: current.query, kind: current.kind, offset: current.next }, request.signal);
    }
    if (listing !== request) return;
    if (current.type === 'updates' && current.next === 0) videoUpdates.refresh(payload);
    if (payload.playlist) current.playlist = payload.playlist;
    current.items.push(...payload.items);
    current.next = payload.next;
    if (queueSource === current) {
      const existing = new Set(queue.map(item => trackKey(item)));
      queue.push(...payload.items.filter(item => !item.missing && !existing.has(trackKey(item, current.source)))
        .map(item => storedTrack(item, current.source)));
      renderQueueControls();
    }
    resultStatus.textContent = '';
    renderCollection();
  } catch (error) {
    if (listing !== request) return;
    more.hidden = hasRefresh;
    more.textContent = '重新加载';
    resultStatus.textContent = error instanceof SyntaxError ? '暂时无法加载，请重试。' : error.message;
  } finally {
    if (listing === request) {
      listing = null;
      more.disabled = false;
      collectionSync.disabled = false;
    }
  }
}

const playable = model => model.items.filter(item => !item.missing);

function renderCollection() {
  const model = collection;
  const podcast = model.source === 'xiaoyuzhou';
  const bili = model.source === 'bilibili';
  const library = model.type === 'library';
  const videoFolder = model.type === 'video-folder';
  const watchList = model.type === 'watch-later';
  const following = model.type === 'following';
  const updates = model.type === 'updates';
  const creatorVideos = model.type === 'creator-videos';
  const biliSearch = bili && model.type === 'search';
  const creators = following || (biliSearch && model.kind === 'playlist');
  const videos = videoFolder || watchList || updates || creatorVideos || (biliSearch && model.kind === 'song');
  const savedPodcasts = model.type === 'favorites';
  const savedItems = model.type === 'track-favorites';
  const mobileQueue = model.type === 'cloud-queue';
  const localQueue = model.type === 'queue';
  const discover = model.type === 'home';
  const detail = videoFolder || creatorVideos || ['playlist', 'episode', 'short'].includes(model.type);
  const playlists = videos || creators || discover || library || savedPodcasts || (model.type === 'search' && model.kind === 'playlist');
  const title = get('results-title');
  const area = detail ? (previousCollection?.kind ?? previousCollection?.type ?? kind) : (model.kind ?? model.type);
  syncFilters(area);
  get('section-heading').hidden = !discover || !model.items.length;
  get('podcast-index-credit').hidden = !podcast || !(discover || (model.type === 'search' && !podcastAccount.token));
  get('list-heading').hidden = playlists || !model.items.length;
  get('item-heading').textContent = localQueue ? '名称' : podcast ? '单集' : '名称';
  get('album-heading').textContent = localQueue ? '来源' : podcast ? '发布日期' : '专辑';
  results.className = discover ? 'cover-grid home-grid' : videos ? 'cover-grid video-grid' :
    creators ? 'cover-grid creator-grid' : playlists ? 'cover-grid' : '';
  if (bili && (library || videos || creators)) {
    const label = { library: '收藏夹', 'watch-later': '稍后再看', updates: '关注更新', following: '关注的 UP 主' }[model.type];
    title.textContent = label ?? model.query ?? model.playlist?.title ?? '投稿视频';
    resultMeta.textContent = model.locked ? (updates ? '扫码登录后，查看你关注的 UP 主的新投稿。' :
      '用哔哩哔哩 App 扫码，查看账号里的' + title.textContent + '。') :
      [model.playlist?.owner, model.items.length ? model.items.length + (library ? ' 个收藏夹' : creators ? ' 位 UP 主' : ' 个视频') : '',
        videos && model.items.length ? '点击封面播放' : ''].filter(Boolean).join(' · ');
    describeCollection({
      empty: model.next === null && !model.items.length, login: model.locked,
      coverUrl: model.playlist?.cover, kicker: creatorVideos ? '投稿视频' : videoFolder ? '哔哩哔哩收藏夹' : biliSearch ? '搜索结果' : '',
      description: model.playlist?.description,
    });
    if (creatorVideos && model.playlist?.url) {
      const open = get('collection-official');
      open.href = model.playlist.url;
      open.textContent = '在哔哩哔哩看全部投稿 ↗';
      open.hidden = false;
    }
    if (creatorVideos) renderCreatorFollow(model);
    if (updates && !model.locked) {
      get('collection-sync-label').textContent = '刷新更新';
      collectionSync.hidden = updateToggle.hidden = false;
      collectionSync.disabled = !!listing;
    }
  } else if (detail) {
    const playlist = model.playlist;
    const episode = model.type === 'episode';
    const unit = podcast ? ' 集' : ' 首';
    title.textContent = playlist?.title ?? (podcast ? (episode ? '单集' : '小宇宙节目') : '歌单');
    resultMeta.textContent = playlist ? [playlist.owner, playlist.count !== undefined ? playlist.count + unit : ''].filter(Boolean).join(' · ') : '';
    describeCollection({
      coverUrl: playlist?.cover, kicker: podcast ? (episode ? '播客单集' : '播客节目') : '播放列表', description: playlist?.description,
      play: model.items.some(item => !item.missing),
    });
    if (podcast && playlist) {
      const open = get('collection-official');
      open.href = playlist.url;
      open.textContent = '在小宇宙打开 ↗';
      open.hidden = false;
      if (!episode) {
        const save = get('collection-save');
        const saved = favorites().some(item => item.id === playlist.id);
        save.hidden = false;
        save.textContent = saved ? '已收藏' : '收藏节目';
        save.setAttribute('aria-pressed', String(saved));
        if (!podcastAccount.token && playlist.count > model.items.length && model.items.length) {
          resultStatus.textContent = '小宇宙公开页提供最近 ' + model.items.length + ' 集。';
        }
      } else if (model.items[0]?.missing) {
        resultStatus.textContent = '小宇宙未提供这集的公开音频，可以在原页收听。';
      }
    }
  } else if (savedPodcasts) {
    title.textContent = '收藏节目';
    resultMeta.textContent = model.items.length ? model.items.length + ' 个节目 · 仅保存在本机' : '打开节目后，点击「收藏节目」。';
    describeCollection({ empty: !model.items.length });
  } else if (savedItems) {
    title.textContent = podcast ? '收藏单集' : '收藏歌曲';
    resultMeta.textContent = model.items.length ? model.items.length + (podcast ? ' 集' : ' 首') + ' · 仅保存在本机' :
      '点击' + (podcast ? '单集' : '歌曲') + '旁的心形按钮，即可收藏到本机。';
    describeCollection({ empty: !model.items.length, play: playable(model).length > 0 });
  } else if (mobileQueue) {
    title.textContent = '小宇宙播放列表';
    resultMeta.textContent = model.locked ? '扫码登录后，读取手机 App 播放器里的播放列表。' :
      model.items.length ? model.items.length + ' 集 · 按手机 App 的列表顺序显示' : '来自手机 App 播放器';
    describeCollection({ empty: model.next === null && !model.items.length, play: playable(model).length > 0, login: model.locked });
    get('collection-sync-label').textContent = '重新同步';
    collectionSync.hidden = model.locked;
    collectionSync.disabled = !!listing;
  } else if (localQueue) {
    title.textContent = '本机队列';
    resultMeta.textContent = model.items.length ? model.items.length + ' 项 · 歌曲和播客可以一起播放' :
      '点击歌曲或单集旁的加入按钮，即可加入本机队列。';
    describeCollection({ empty: !model.items.length, play: model.items.length > 0 });
  } else if (library) {
    title.textContent = podcast ? '我的订阅' : '我的歌单';
    resultMeta.textContent = podcast ? (model.locked ? '扫码登录后，查看你在小宇宙订阅的节目。' :
      model.items.length ? '已加载 ' + model.items.length + ' 个订阅' : '') :
      model.locked ? '扫码登录后，查看你创建和收藏的歌单。' :
      model.items.length ? '已加载 ' + model.items.length + ' 张歌单' : '';
    describeCollection({ empty: !model.items.length, login: model.locked });
  } else if (discover) {
    title.textContent = '主页';
    resultMeta.textContent = '';
    describeCollection();
  } else {
    title.textContent = model.query;
    resultMeta.textContent = '';
    describeCollection({ empty: model.next === null && !model.items.length, kicker: '搜索结果' });
  }
  back.hidden = !detail || !previousCollection;
  get('back-label').textContent = { library: bili ? '收藏夹' : podcast ? '我的订阅' : '我的歌单',
    favorites: '收藏节目', home: '主页', search: '搜索结果', following: '关注的 UP 主' }[previousCollection?.type] ?? '返回';
  more.hidden = model.next === null || (!model.items.length && model.next === 0);
  more.disabled = false;
  more.textContent = '加载更多';
  if (model.next === null && !model.items.length && !model.locked && !savedPodcasts && !savedItems && !localQueue) {
    resultStatus.textContent = bili ? (biliSearch ? '没有找到匹配结果。' : following ? '账号还没有关注的 UP 主。' :
      library ? '账号还没有收藏夹。' : '这个列表里还没有可显示的视频。') :
      library ? (podcast ? '小宇宙没有返回任何订阅。' : '网易云没有返回任何歌单。') :
      mobileQueue ? '手机 App 的播放列表为空。' :
      detail ? (podcast ? '公开页暂无可显示的单集。' : '这张歌单没有可显示的歌曲。') :
        discover ? (podcast ? '播客目录暂无热门节目。' : '暂时没有推荐歌单。') : '没有找到匹配结果。';
  }
  results.setAttribute('aria-label', title.textContent || '列表');

  selectedButton = null;
  const saved = new Set(playlists ? [] : readTracks(trackFavoritesKey).map(item => trackKey(item)));
  const pending = new Set(queue.slice(queueIndex + 1).filter(item => item.manual).map(item => trackKey(item)));
  const rows = model.items.map((item, index) => {
    const li = el('li', playlists ? '' : 'track-entry');
    const provider = localQueue ? item.source : model.source;
    const itemKey = trackKey(item, provider);
    const isPodcast = provider === 'xiaoyuzhou';
    const button = el(videos ? 'a' : 'button', playlists ? 'playlist-card' : 'result-row');
    if (videos) {
      button.href = item.url;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
      const playerUrl = bilibiliPlayerUrl(item.id);
      if (playerUrl) {
        button.setAttribute('aria-label', item.title + ' · 在插件中播放');
        button.addEventListener('click', event => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openVideo(item, playerUrl, button);
        });
      }
    } else {
      button.type = 'button';
      button.disabled = !!item.missing;
    }
    button.title = item.title;
    const art = el('span', 'cover');
    art.setAttribute('aria-hidden', 'true');
    cover(art, item.cover, index < 12);
    if (videos && item.duration) art.append(el('span', 'video-time', formatTime(item.duration / 1000)));
    if (updates && item.updateId) {
      const marker = el('span', 'video-new', '新');
      marker.dataset.updateId = item.updateId;
      art.append(marker);
    }
    if (playlists) {
      const summary = el('span', 'card-copy');
      const meta = el('span', 'card-meta');
      if (videos) {
        meta.classList.add('video-card-meta');
        if (item.owner) meta.append(el('span', 'card-meta', item.owner));
        const date = videoDate(item.published);
        if (date) meta.append(date);
      } else {
        meta.textContent = [creators ? item.description : item.owner,
          item.count ? item.count + (bili ? ' 项' : podcast ? ' 集' : ' 首') : ''].filter(Boolean).join(' · ');
      }
      summary.append(el('span', 'card-title', item.title), meta);
      button.append(art, summary);
    } else {
      const summary = el('span', 'row-summary');
      summary.append(el('span', 'row-title', item.title),
        el('span', 'row-meta', item.missing && isPodcast ? '请在小宇宙查看' : item.artists || (item.missing ? '暂无曲目信息' : '')));
      const leading = el('span', 'row-main');
      leading.append(art, summary);
      button.append(leading, el('span', 'row-album', localQueue ? (isPodcast ? '小宇宙' : '网易云音乐') : item.album || '—'),
        el('span', 'row-end', item.duration ? formatTime(item.duration / 1000) : '—'));
    }
    if (!playlists) button.dataset.track = itemKey;
    if (!playlists && trackKey(queue[queueIndex]) === itemKey) {
      button.setAttribute('aria-current', 'true');
      selectedButton = button;
    }
    if (!videos) button.addEventListener('click', () => {
      if (creators) return openDetail(item.id, model, 'creator-videos', item);
      if (playlists) return openDetail(item.id, model, bili ? 'video-folder' : 'playlist');
      if (localQueue) return playAt(queue.findIndex(entry => trackKey(entry) === itemKey));
      playFrom(model, item);
    });
    li.append(button);
    if (!playlists) {
      const actions = el('div', 'row-actions');
      const favorite = iconAction('heart', '', 'track-favorite');
      labelFavorite(favorite, isPodcast, saved.has(itemKey));
      favorite.addEventListener('click', () => toggleTrackFavorite(item, provider, favorite, index));
      actions.append(favorite);
      if (localQueue) {
        const remove = iconAction('close', '从本机队列移除', 'queue-remove');
        remove.disabled = trackKey(queue[queueIndex]) === itemKey;
        remove.addEventListener('click', () => removeQueued(itemKey, index));
        actions.append(remove);
      } else {
        const add = iconAction('add-queue', '', 'queue-add');
        labelQueueAction(add, item.missing, pending.has(itemKey), button.hasAttribute('aria-current'));
        add.addEventListener('click', () => {
          enqueue(item, provider);
          labelQueueAction(add, false, true, false);
          button.focus({ preventScroll: true });
          resultStatus.textContent = '已加入本机队列：' + item.title;
        });
        actions.append(add);
      }
      li.append(actions);
    }
    return li;
  });
  results.replaceChildren(...rows);
  if (updates) renderUpdateState(videoUpdates.state);
}

function videoDate(seconds) {
  const date = new Date(seconds * 1000);
  if (!(seconds > 0) || !Number.isFinite(date.getTime())) return null;
  const node = el('time', '', date.toLocaleDateString('zh-CN'));
  node.dateTime = date.toISOString();
  node.title = '发布于 ' + date.toLocaleString('zh-CN');
  return node;
}

function renderCreatorFollow(model) {
  const state = model.follow;
  creatorFollow.hidden = model.id === biliProfileId || !!state?.self;
  creatorFollow.disabled = !!state?.busy;
  creatorFollow.textContent = state?.error && state.following === undefined ? '重试读取关注状态' :
    state?.following ? '已关注' : '关注 UP 主';
  creatorFollow.setAttribute('aria-pressed', String(state?.following === true));
  creatorActionStatus.hidden = creatorFollow.hidden || !state?.error;
  creatorActionStatus.textContent = state?.error ?? '';
}

async function loadCreatorFollow(model) {
  const token = biliAccount.token;
  if (!token || model.id === biliProfileId || model.follow?.busy) return;
  const state = model.follow = { busy: true };
  renderCreatorFollow(model);
  try {
    Object.assign(state, await api('bilibili/creator-relation', { id: model.id }, undefined, true));
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    if (collection === model && model.follow === state && biliAccount.token === token) renderCreatorFollow(model);
  }
}

function invalidateBiliLists(types, id) {
  const saved = sourceViews.get('bilibili');
  for (const model of [collection, previousCollection, saved?.collection, saved?.previousCollection,
    queueReturn?.model, queueReturn?.prior]) {
    if (model?.source === 'bilibili' && types.includes(model.type) &&
        (model.type !== 'video-folder' || id?.includes(model.id))) model.needsRefresh = true;
  }
  if (!activeVideo && collection?.needsRefresh) show(collection);
}

async function toggleCreatorFollow() {
  const model = collection;
  if (model?.type !== 'creator-videos') return;
  const token = biliAccount.token;
  if (!token) return biliAccount.start();
  const state = model.follow;
  if (state?.busy || state?.self) return;
  if (state?.following === undefined) return loadCreatorFollow(model);
  state.busy = true;
  state.error = '';
  renderCreatorFollow(model);
  try {
    Object.assign(state, await api('bilibili/follow', { id: model.id, enabled: Number(!state.following) }, undefined, true, 'POST'));
    if (biliAccount.token === token) invalidateBiliLists(['following']);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    if (collection === model && model.follow === state && biliAccount.token === token) renderCreatorFollow(model);
  }
}

const videoActionId = item => item.aid ? 'av' + item.aid : item.id;

function renderVideoActions(current) {
  const { item, relation, favorite, relationError, actionError, busy, loadingActions } = current;
  videoLike.setAttribute('aria-pressed', String(relation?.liked === true));
  videoLike.textContent = relation?.liked ? '已点赞' : '点赞';
  videoLike.disabled = !!(busy || loadingActions) || (!!biliAccount.token && relation?.liked === undefined);
  videoFollow.hidden = !item.ownerId || item.ownerId === biliProfileId;
  videoFollow.setAttribute('aria-pressed', String(relation?.following === true));
  videoFollow.textContent = relation?.following ? '已关注' : '关注 UP 主';
  videoFollow.disabled = !!(busy || loadingActions) || (!!biliAccount.token && relation?.following === undefined);
  videoSave.dataset.saved = String(favorite === true);
  videoSave.textContent = favorite ? '已收藏' : '收藏';
  videoActionsRetry.hidden = !relationError;
  videoActionsRetry.disabled = !!busy;
  videoActionStatus.textContent = actionError || relationError || '';
}

async function loadVideoActions(current) {
  if (current.loadingActions || current.busy) return;
  const token = biliAccount.token;
  current.loadingActions = !!token;
  current.relationError = current.actionError = '';
  renderVideoActions(current);
  if (!token) return;
  const { item } = current;
  const [video, creator] = await Promise.allSettled([
    api('bilibili/video-relation', { id: videoActionId(item) }, undefined, true),
    item.ownerId && item.ownerId !== biliProfileId ? api('bilibili/creator-relation', { id: item.ownerId }, undefined, true) : null,
  ]);
  current.loadingActions = false;
  if (activeVideo !== current || biliAccount.token !== token) return;
  current.relation = { ...video.value, ...creator.value };
  current.favorite ??= video.value?.favorite;
  current.relationError = video.reason?.message || creator.reason?.message || '';
  renderVideoActions(current);
}

async function toggleVideoAction(action, field, id) {
  const current = activeVideo;
  if (!current) return;
  const token = biliAccount.token;
  if (!token) return biliAccount.start();
  if (current.relation?.[field] === undefined || current.busy || !id) return;
  current.busy = true;
  current.actionError = '';
  renderVideoActions(current);
  try {
    const result = await api('bilibili/' + action, { id, enabled: Number(!current.relation[field]) }, undefined, true, 'POST');
    current.relation[field] = result[field];
    if (action === 'follow' && biliAccount.token === token) {
      if (collection?.type === 'creator-videos' && collection.id === id && collection.follow) {
        collection.follow.following = result.following;
        renderCreatorFollow(collection);
      }
      invalidateBiliLists(['following']);
    }
  } catch (error) {
    current.actionError = error.message;
  } finally {
    current.busy = false;
    if (activeVideo === current && biliAccount.token === token) renderVideoActions(current);
  }
}

let saveSelection;

function closeVideoSave() {
  saveSelection = null;
  if (saveDialog.open) saveDialog.close();
}

async function openVideoSave() {
  const current = activeVideo;
  if (!current || saveDialog.open) return;
  const token = biliAccount.token;
  if (!token) return biliAccount.start();
  const selection = saveSelection = { current, token };
  saveFolders.replaceChildren();
  saveApply.disabled = true;
  get('video-save-close').disabled = false;
  saveStatus.textContent = '正在读取收藏夹…';
  saveDialog.showModal();
  try {
    const { aid, items } = await api('bilibili/video-folders', { id: videoActionId(current.item) }, undefined, true);
    if (saveSelection !== selection || biliAccount.token !== token) return;
    selection.id = 'av' + aid;
    selection.folders = items.map(folder => {
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = folder.selected;
      const label = el('label');
      label.append(checkbox, folder.title);
      saveFolders.append(label);
      return { ...folder, checkbox };
    });
    current.favorite = items.some(folder => folder.selected);
    renderVideoActions(current);
    saveStatus.textContent = items.length ? '' : 'B 站账号里暂无可用收藏夹。';
  } catch (error) {
    if (saveSelection === selection) saveStatus.textContent = error.message;
  }
}

async function applyVideoSave() {
  const selection = saveSelection;
  if (!selection?.folders || selection.busy) return;
  const { current, token, id, folders } = selection;
  if (token !== biliAccount.token) return closeVideoSave();
  const changed = folders.filter(folder => folder.selected !== folder.checkbox.checked);
  if (!changed.length) return;
  selection.busy = saveApply.disabled = get('video-save-close').disabled = true;
  for (const { checkbox } of folders) checkbox.disabled = true;
  saveStatus.textContent = '正在保存…';
  try {
    await api('bilibili/save', { id, add: changed.filter(folder => folder.checkbox.checked).map(folder => folder.id).join(','),
      remove: changed.filter(folder => !folder.checkbox.checked).map(folder => folder.id).join(',') }, undefined, true, 'POST');
    if (token !== biliAccount.token) return;
    if (saveSelection === selection) closeVideoSave();
    current.favorite = folders.some(folder => folder.checkbox.checked);
    if (current === activeVideo) renderVideoActions(current);
    invalidateBiliLists(['library', 'video-folder'], changed.map(folder => folder.id));
  } catch (error) {
    if (saveSelection !== selection) return;
    saveStatus.textContent = error.message;
    selection.busy = saveApply.disabled = get('video-save-close').disabled = false;
    for (const { checkbox } of folders) checkbox.disabled = false;
  }
}

async function openVideo(item, playerUrl, trigger) {
  closeVideo();
  setLyricsVisible(false);
  videoTrigger = trigger;
  videoPanel.dataset.size = 'default';
  videoFrame.dataset.controls = 'hidden';
  videoPanel.hidden = false;
  collectionView.inert = true;
  audio.pause();
  get('video-title').textContent = item.title;
  const owner = get('video-owner');
  owner.textContent = item.owner ?? '';
  const published = videoDate(item.published);
  if (published) owner.append(item.owner ? ' · ' : '', published);
  get('video-official').href = item.url;
  videoPanel.scrollTop = 0;
  videoClose.focus();

  const current = { controller: new AbortController(), item, seekPreview: null };
  activeVideo = current;
  loadVideoActions(current);
  player.hidden = true;
  const { signal } = current.controller;
  const status = get('video-status');
  const historyStatus = get('video-history-status');
  const token = biliAccount.token;

  function embed(message = '') {
    current.controller.abort();
    current.dispose?.();
    current.dispose = null;
    current.media = null;
    player.hidden = true;
    videoSettings.open = false;
    status.textContent = message;
    const frame = el('iframe');
    frame.title = '哔哩哔哩播放器';
    frame.src = playerUrl;
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    videoStage.replaceChildren(frame);
  }

  if (!token) {
    embed('扫码登录后可使用账号画质，并可开启观看记录同步。');
    return;
  }
  status.textContent = '正在读取账号可用画质…';
  try {
    const [playback, { playBilibili }] = await Promise.all([
      api('bilibili/playback', { id: item.id }, signal, true),
      import('./bilibili-player.js'),
    ]);
    if (signal.aborted) return;
    const video = el('video');
    video.playsInline = true;
    video.volume = audio.volume;
    video.muted = audio.muted;
    video.setAttribute('aria-label', item.title);
    videoStage.replaceChildren(video);
    current.media = video;
    player.dataset.mode = 'video';
    player.setAttribute('aria-label', '视频播放器');
    videoFrame.append(player);
    player.hidden = false;
    videoSettings.hidden = videoModes.hidden = false;
    fullscreen.hidden = !document.fullscreenEnabled || !videoFrame.requestFullscreen;
    syncVideoMode();
    bindVideoControls(signal);
    renderPlayerTrack();
    syncPlayer();
    syncVolume();
    for (const event of ['loadedmetadata', 'canplay', 'timeupdate', 'durationchange', 'play', 'pause', 'ended', 'seeked', 'error', 'emptied']) {
      video.addEventListener(event, syncPlayer, { signal });
    }
    video.addEventListener('volumechange', syncVolume, { signal });
    video.addEventListener('click', () => playToggle.click(), { signal });
    const quality = get('video-quality');
    quality.replaceChildren(new Option('自动', 'auto'));
    quality.disabled = true;
    const history = get('video-history');
    const settingsKey = 'dsh-bilibili-history:' + biliProfileId;
    history.checked = playback.history && readLocal(settingsKey) === 'on';
    get('video-history-label').hidden = !playback.history;
    historyStatus.textContent = playback.history ? '' : '重新扫码后可开启观看记录同步。';
    status.textContent = '';
    const dispose = playBilibili({
      video, quality, history, playback, signal,
      settings: enabled => writeLocal(settingsKey, enabled ? 'on' : 'off'),
      report: params => request('bilibili/history', { id: playback.id, ...params }, { method: 'POST', token, keepalive: true }),
      onHistory: text => { historyStatus.textContent = text; },
      onError(initialized) {
        if (!initialized) embed('账号播放器加载失败，已切换到外链播放器。');
        else status.textContent = '视频暂时无法继续播放，可以打开哔哩哔哩原页。';
      },
    });
    if (signal.aborted) dispose();
    else current.dispose = dispose;
  } catch (error) {
    if (!signal.aborted) embed((error instanceof SyntaxError ? '暂时无法载入账号画质。' : error.message) + ' 已切换到外链播放器。');
  }
}

function closeVideo(restoreFocus = false) {
  if (videoPanel.hidden) return;
  closeVideoSave();
  activeVideo?.controller.abort();
  activeVideo?.dispose?.();
  activeVideo = null;
  if (document.fullscreenElement === videoFrame) void document.exitFullscreen().catch(() => {});
  playerHome.append(player);
  delete player.dataset.mode;
  player.setAttribute('aria-label', '播放器');
  videoSettings.open = false;
  videoSettings.hidden = videoModes.hidden = true;
  player.hidden = false;
  renderPlayerTrack();
  syncPlayer();
  syncVolume();
  get('video-status').textContent = '';
  videoStage.replaceChildren();
  videoPanel.hidden = true;
  collectionView.inert = false;
  if (restoreFocus) {
    if (collection?.needsRefresh) show(collection);
    const fallback = { 'watch-later': watchLater, updates: biliUpdates, 'creator-videos': biliFollowing }[collection?.type] ?? myPlaylists;
    (videoTrigger?.isConnected ? videoTrigger : fallback).focus({ preventScroll: true });
  }
  videoTrigger = null;
}

function bindVideoControls(signal) {
  let timeout;
  let pressed = false;
  const hide = () => {
    if (!pressed && !videoSettings.open && !player.querySelector(':focus-visible')) videoFrame.dataset.controls = 'hidden';
  };
  const show = () => {
    videoFrame.dataset.controls = 'shown';
    clearTimeout(timeout);
    timeout = setTimeout(hide, 2800);
  };
  for (const event of ['pointerenter', 'pointermove', 'focusin', 'focusout']) {
    videoFrame.addEventListener(event, show, { signal });
  }
  videoFrame.addEventListener('pointerleave', hide, { signal });
  player.addEventListener('pointerdown', () => { pressed = true; show(); }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'blur']) {
    window.addEventListener(event, () => {
      if (pressed) { pressed = false; show(); }
    }, { signal });
  }
  document.addEventListener('pointerdown', event => {
    if (videoSettings.open && !videoSettings.contains(event.target)) videoSettings.open = false;
  }, { signal });
  videoSettings.addEventListener('toggle', show, { signal });
  signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
}

function syncVideoMode() {
  const expanded = document.fullscreenElement === videoFrame;
  const wide = videoPanel.dataset.size === 'theater';
  defaultSize.setAttribute('aria-pressed', String(!expanded && !wide));
  theater.setAttribute('aria-pressed', String(!expanded && wide));
  fullscreen.setAttribute('aria-pressed', String(expanded));
  actionLabel(fullscreen, expanded ? '退出全屏' : '全屏');
  get('fullscreen-icon').setAttribute('href', expanded ? '#i-exit-fullscreen' : '#i-fullscreen');
}

function setVideoSize(size) {
  videoPanel.dataset.size = size;
  if (document.fullscreenElement === videoFrame) void document.exitFullscreen().catch(() => {});
  syncVideoMode();
}

function actionLabel(button, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function iconAction(icon, label, className = '') {
  const button = el('button', 'icon-button ' + className);
  button.type = 'button';
  actionLabel(button, label);
  const ns = 'http://www.w3.org/2000/svg';
  const glyph = document.createElementNS(ns, 'svg');
  glyph.setAttribute('class', 'icon');
  glyph.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + icon);
  glyph.append(use);
  button.append(glyph);
  return button;
}

function labelFavorite(button, podcast, saved) {
  button.setAttribute('aria-pressed', String(saved));
  actionLabel(button, (saved ? '取消收藏' : '收藏') + (podcast ? '单集' : '歌曲'));
}

function labelQueueAction(button, missing, added, active) {
  actionLabel(button, active ? '当前播放项' : added ? '已加入本机队列' : '加入本机队列');
  button.setAttribute('aria-pressed', String(added));
  button.disabled = !!missing || added || active;
}

function toggleTrackFavorite(item, provider, button, index) {
  const entries = readTracks(trackFavoritesKey);
  const key = trackKey(item, provider);
  const saved = entries.some(entry => trackKey(entry) === key);
  const updated = saved ? entries.filter(entry => trackKey(entry) !== key) : [storedTrack(item, provider), ...entries];
  if (!writeLocal(trackFavoritesKey, JSON.stringify(updated))) {
    resultStatus.textContent = '本机无法保存收藏。';
    return;
  }
  labelFavorite(button, provider === 'xiaoyuzhou', !saved);
  if (collection.type === 'track-favorites') {
    collection.items = savedTracks(provider);
    renderCollection();
    (results.children[Math.min(index, results.children.length - 1)]?.querySelector('.track-favorite') ?? trackFavorites).focus();
  }
}

function refreshQueueView() {
  if (collection?.type !== 'queue') return;
  collection.items = queue;
  renderCollection();
}

function enqueue(item, provider) {
  const key = trackKey(item, provider);
  const index = queue.findIndex(entry => trackKey(entry) === key);
  const entry = { ...storedTrack(item, provider), manual: true };
  if (index > queueIndex) queue[index] = entry;
  else if (index !== queueIndex || queueIndex < 0) {
    if (index >= 0) {
      queue.splice(index, 1);
      queueIndex--;
    }
    queue.push(entry);
  }
  persistQueue();
  renderQueueControls();
  syncPlayer();
}

function removeQueued(key, row) {
  const index = queue.findIndex(item => trackKey(item) === key);
  if (index < 0 || index === queueIndex) return;
  queue.splice(index, 1);
  if (index < queueIndex) queueIndex--;
  persistQueue();
  renderQueueControls();
  syncPlayer();
  refreshQueueView();
  (results.children[Math.min(row, results.children.length - 1)]?.querySelector('.result-row') ?? queueToggle).focus();
}

function playFrom(model, item) {
  const tracks = playable(model).map(entry => storedTrack(entry, model.source));
  if (!tracks.length) return;
  const start = trackKey(item, model.source) || trackKey(tracks[0]);
  const pending = new Map(queue.slice(queueIndex + 1).filter(entry => entry.manual).map(entry => [trackKey(entry), entry]));
  const position = tracks.findIndex(entry => trackKey(entry) === start);
  queue = tracks.flatMap((entry, index) => {
    const key = trackKey(entry);
    if (!pending.has(key)) return [entry];
    if (index < position) return [];
    pending.delete(key);
    return [{ ...entry, manual: true }];
  }).concat([...pending.values()]);
  queueSource = model;
  playAt(queue.findIndex(entry => trackKey(entry) === start));
}

function formatTime(seconds) {
  seconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function setAudioStatus(text, canRetry = false) {
  audioStatus = text;
  audioRetry = canRetry;
  if (!activeVideo) {
    playerStatus.textContent = text;
    retry.hidden = !canRetry;
  }
}

function renderPlayerTrack() {
  const item = activeVideo?.item ?? queue[queueIndex];
  cover(get('player-cover'), item?.cover);
  get('player-title').textContent = item?.title ?? '暂无播放';
  get('player-artist').textContent = item?.artists ?? item?.owner ?? '';
  if (activeVideo || !item) official.hidden = true;
  else {
    const podcast = item.source === 'xiaoyuzhou';
    official.href = podcast ? item.url : 'https://music.163.com/#/song?id=' + item.id;
    actionLabel(official, podcast ? '在小宇宙打开' : '在网易云打开');
    official.hidden = false;
  }
  playerStatus.textContent = activeVideo ? '' : audioStatus;
  retry.hidden = Boolean(activeVideo) || !audioRetry;
}

function syncPlayer() {
  if (activeVideo && !activeVideo.media) return;
  const media = activeVideo?.media ?? audio;
  const hasMedia = !media.error && (media.hasAttribute('src') || Boolean(media.srcObject));
  const canSeek = hasMedia && Number.isFinite(media.duration) && media.duration > 0;
  const playing = hasMedia && !media.paused && !media.ended;
  playToggle.disabled = !hasMedia && (Boolean(activeVideo) || queueIndex >= 0 || !queue.length);
  const label = playing ? '暂停' : '播放';
  playToggle.setAttribute('aria-label', label);
  playToggle.title = label;
  get('play-icon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  seek.disabled = !canSeek;
  const position = activeVideo?.seekPreview ?? media.currentTime;
  seek.value = canSeek ? String(Math.round(position / media.duration * 1000)) : '0';
  seek.style.setProperty('--range-progress', Number(seek.value) / 10 + '%');
  const elapsed = formatTime(position);
  const total = formatTime(canSeek ? media.duration : (activeVideo?.item ?? queue[queueIndex])?.duration / 1000);
  get('elapsed').textContent = elapsed;
  get('duration').textContent = total;
  seek.setAttribute('aria-valuetext', elapsed + ' / ' + total);
}

function syncVolume() {
  const media = activeVideo?.media ?? audio;
  const silent = media.muted || media.volume === 0;
  const label = silent ? '取消静音' : '静音';
  mute.title = label;
  mute.setAttribute('aria-label', label);
  get('volume-icon').setAttribute('href', silent ? '#i-mute' : '#i-volume');
  volume.value = String(silent ? 0 : Math.round(media.volume * 100));
  volume.style.setProperty('--range-progress', volume.value + '%');
}

function setLyricTrack(item) {
  get('lyric-track').textContent = item?.title ?? '暂无播放';
  get('lyric-artist').textContent = item?.artists ?? '';
  cover(get('lyric-cover'), item?.cover);
  cover(get('lyric-ambient'), item?.cover);
}

function setLyricsVisible(visible) {
  lyricsPanel.hidden = !visible;
  lyricsToggle.setAttribute('aria-pressed', String(visible));
  if (visible) scrollToCurrentLyric();
}

function setTextMode(podcast) {
  const label = podcast ? '单集简介' : '歌词';
  lyricsToggle.title = label;
  lyricsToggle.setAttribute('aria-label', label);
  lyricScroll.setAttribute('aria-label', label);
}

function renderQueueControls() {
  previous.disabled = queueIndex <= 0;
  next.disabled = queueIndex >= queue.length - 1;
}

function clearLyrics(text) {
  lyrics = [];
  lyricNodes = [];
  highlighted = -1;
  lyricLines.replaceChildren();
  get('episode-notes').hidden = true;
  get('notes-copy').textContent = '';
  lyricStatus.textContent = text;
  lyricStatus.hidden = false;
  lyricScroll.scrollTop = 0;
}

function refreshLyrics() {
  const current = activeLine(lyrics, audio.currentTime * 1000);
  if (current === highlighted) return;
  lyricNodes[highlighted]?.removeAttribute('aria-current');
  highlighted = current;
  const row = lyricNodes[current];
  if (!row) { lyricScroll.scrollTop = 0; return; }
  row.setAttribute('aria-current', 'true');
  scrollToCurrentLyric();
}

function scrollToCurrentLyric() {
  const row = lyricNodes[highlighted];
  if (row && !lyricsPanel.hidden) lyricScroll.scrollTop = row.offsetTop - (lyricScroll.clientHeight - row.offsetHeight) / 2;
}

function showLyrics(payload) {
  lyrics = mergeLyrics(payload.original, payload.translation);
  if (!lyrics.length) return clearLyrics('这首歌没有可用的同步歌词。');
  lyricStatus.hidden = true;
  lyricNodes = lyrics.map(({ text, translation }) => {
    const line = el('p', 'lyric-line');
    line.append(el('span', '', text));
    if (translation) line.append(el('span', 'translation', translation));
    return line;
  });
  lyricLines.replaceChildren(...lyricNodes);
  refreshLyrics();
}

async function playAt(index, automatic = false) {
  if (index < 0 || index >= queue.length) return;
  closeVideo();
  listening?.abort();
  const request = new AbortController();
  listening = request;
  queueIndex = index;
  const item = queue[index];
  const podcast = item.source === 'xiaoyuzhou';
  const itemKey = trackKey(item);
  const pending = new Set(queue.slice(queueIndex + 1).filter(entry => entry.manual).map(entry => trackKey(entry)));
  selectedButton?.removeAttribute('aria-current');
  selectedButton = null;
  for (const row of results.querySelectorAll('.result-row')) {
    const active = row.dataset.track === itemKey;
    if (active) {
      row.setAttribute('aria-current', 'true');
      selectedButton = row;
    }
    const add = row.nextElementSibling.querySelector('.queue-add');
    if (add) labelQueueAction(add, row.disabled, pending.has(row.dataset.track), active);
    const remove = row.nextElementSibling.querySelector('.queue-remove');
    if (remove) remove.disabled = active;
  }
  persistQueue();
  renderQueueControls();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  syncPlayer();
  setAudioStatus('正在加载音频…');
  renderPlayerTrack();
  setLyricTrack(item);
  setTextMode(podcast);
  clearLyrics(podcast ? '正在加载单集简介…' : '正在加载歌词…');

  if (!podcast) {
    api('lyrics', { id: item.id }, request.signal).then(payload => {
      if (listening === request) showLyrics(payload);
    }).catch(() => {
      if (listening === request) clearLyrics('暂时无法加载歌词。');
    });
  }

  try {
    const { url, notes } = await api(podcast ? 'podcast/stream' : 'stream', { id: item.id }, request.signal, !podcast);
    if (listening !== request) return;
    if (podcast) {
      lyricStatus.hidden = !!notes;
      lyricStatus.textContent = '这集暂无可显示的简介。';
      get('episode-notes').hidden = !notes;
      get('notes-copy').textContent = notes ?? '';
    }
    audio.src = url;
    syncPlayer();
    setAudioStatus('');
    if (videoPanel.hidden) await audio.play();
  } catch (error) {
    if (listening !== request) return;
    if (!videoPanel.hidden && error.name === 'AbortError') return;
    if (error.name === 'NotAllowedError') {
      setAudioStatus('点击播放键开始收听。');
      return;
    }
    const text = error instanceof SyntaxError || audio.hasAttribute('src') ? '音频暂时无法播放。' : error.message;
    if (podcast && get('episode-notes').hidden) clearLyrics('可在小宇宙原页查看这集的简介。');
    // Automatic playback stops if the next track is unavailable. The user can skip or retry.
    setAudioStatus(text + (automatic && !next.disabled ? ' 可手动切到下一首。' : ''), true);
  }
}

for (const button of sources) button.addEventListener('click', () => switchSource(button.dataset.source));
for (const button of filters) button.addEventListener('click', () => {
  if (button.getAttribute('aria-pressed') === 'true') { query.focus(); return; }
  selectKind(button.dataset.kind);
  const text = query.value.trim();
  if (text && !/https?:\/\//i.test(text)) startSearch(text);
  else {
    resetCollection();
    query.focus();
  }
});
form.addEventListener('submit', event => {
  event.preventDefault();
  startSearch(query.value.trim());
});
more.addEventListener('click', loadPage);
home.addEventListener('click', openHome);
myPlaylists.addEventListener('click', openLibrary);
podcastFavorites.addEventListener('click', openFavorites);
trackFavorites.addEventListener('click', openTrackFavorites);
cloudQueue.addEventListener('click', openCloudQueue);
watchLater.addEventListener('click', () => openBiliList('watch-later'));
biliFollowing.addEventListener('click', () => openBiliList('following'));
biliUpdates.addEventListener('click', openBiliUpdates);
updateToast.addEventListener('click', openBiliUpdates);
updateRead.addEventListener('click', () => videoUpdates.markRead());
updateToggle.addEventListener('click', () => {
  const enabled = !videoUpdates.state.enabled;
  if (enabled && window.Notification?.permission === 'default' && typeof Notification.requestPermission === 'function') {
    void Notification.requestPermission().then(() => renderUpdateState(videoUpdates.state)).catch(() => {});
  }
  videoUpdates.enable(enabled);
});
queueToggle.addEventListener('click', toggleQueue);
collectionSync.addEventListener('click', () => collection?.type === 'updates' ? openBiliUpdates() : openCloudQueue());
get('empty-login').addEventListener('click', () => accountFor(source).start());
get('collection-play').addEventListener('click', () => {
  if (collection?.type === 'queue') return playAt(queueIndex < 0 ? 0 : queueIndex);
  if (collection && ['playlist', 'episode', 'cloud-queue', 'track-favorites'].includes(collection.type)) playFrom(collection);
});
get('collection-save').addEventListener('click', () => {
  const item = collection?.playlist;
  if (!item || collection.source !== 'xiaoyuzhou' || collection.type !== 'playlist') return;
  const entries = favorites();
  const isSaved = entries.some(saved => saved.id === item.id);
  const next = isSaved ? entries.filter(saved => saved.id !== item.id) : [item, ...entries];
  if (writeLocal(favoritesKey, JSON.stringify(next))) renderCollection();
  else resultStatus.textContent = '本机无法保存收藏。';
});
back.addEventListener('click', () => {
  const model = previousCollection;
  if (model) {
    if (model.type === 'search') {
      selectKind(model.kind);
      query.value = model.query;
    }
    if (model.type === 'favorites') model.items = favorites();
    previousCollection = null;
    show(model, true);
    if (model.type === 'search') query.focus();
  }
});
previous.addEventListener('click', () => playAt(queueIndex - 1));
next.addEventListener('click', () => playAt(queueIndex + 1));
retry.addEventListener('click', () => playAt(queueIndex));
playToggle.addEventListener('click', () => {
  if (activeVideo) {
    const video = activeVideo.media;
    if (!video) return;
    if (!video.paused && !video.ended) return video.pause();
    void video.play().catch(error => {
      if (activeVideo?.media === video && error.name !== 'AbortError') get('video-status').textContent = '视频暂时无法播放。';
    });
    return;
  }
  if (queueIndex < 0 && queue.length) return playAt(0);
  if (!audio.paused && !audio.ended) return audio.pause();
  void audio.play().catch(() => {
    if (videoPanel.hidden && audio.hasAttribute('src')) setAudioStatus('音频暂时无法播放。', true);
  });
});
seek.addEventListener('input', () => {
  if (seek.disabled) return;
  const video = activeVideo?.media;
  if (video) {
    activeVideo.seekPreview = Number(seek.value) * video.duration / 1000;
    syncPlayer();
  } else audio.currentTime = Number(seek.value) * audio.duration / 1000;
});
seek.addEventListener('change', () => {
  if (!activeVideo?.media || activeVideo.seekPreview === null) return;
  const { media, seekPreview } = activeVideo;
  activeVideo.seekPreview = null;
  media.currentTime = seekPreview;
  syncPlayer();
});
seek.addEventListener('pointercancel', () => {
  if (!activeVideo) return;
  activeVideo.seekPreview = null;
  syncPlayer();
});
volume.addEventListener('input', () => {
  audio.volume = Number(volume.value) / 100;
  audio.muted = false;
  if (activeVideo?.media) {
    activeVideo.media.volume = audio.volume;
    activeVideo.media.muted = false;
  }
});
mute.addEventListener('click', () => {
  const media = activeVideo?.media ?? audio;
  if (media.volume === 0) {
    audio.volume = media.volume = 0.6;
    audio.muted = media.muted = false;
  } else audio.muted = media.muted = !media.muted;
});
fullscreen.addEventListener('click', () => {
  if (!activeVideo?.media) return;
  const operation = document.fullscreenElement === videoFrame ? document.exitFullscreen() : videoFrame.requestFullscreen();
  void operation.catch(() => { if (activeVideo?.media) get('video-status').textContent = '当前窗口无法进入全屏。'; });
});
defaultSize.addEventListener('click', () => setVideoSize('default'));
theater.addEventListener('click', () => setVideoSize('theater'));
document.addEventListener('fullscreenchange', syncVideoMode);
lyricsToggle.addEventListener('click', () => {
  closeVideo();
  setLyricsVisible(lyricsPanel.hidden);
});
videoClose.addEventListener('click', () => closeVideo(true));
creatorFollow.addEventListener('click', toggleCreatorFollow);
videoLike.addEventListener('click', () => { if (activeVideo) toggleVideoAction('like', 'liked', videoActionId(activeVideo.item)); });
videoFollow.addEventListener('click', () => toggleVideoAction('follow', 'following', activeVideo?.item.ownerId));
videoActionsRetry.addEventListener('click', () => { if (activeVideo) loadVideoActions(activeVideo); });
videoSave.addEventListener('click', openVideoSave);
saveFolders.addEventListener('change', () => {
  saveApply.disabled = !saveSelection?.folders.some(folder => folder.selected !== folder.checkbox.checked);
});
saveApply.addEventListener('click', applyVideoSave);
get('video-save-close').addEventListener('click', closeVideoSave);
saveDialog.addEventListener('cancel', event => {
  event.preventDefault();
  if (!saveSelection?.busy) closeVideoSave();
});
get('lyrics-close').addEventListener('click', () => {
  setLyricsVisible(false);
  lyricsToggle.focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (videoSettings.open) {
    videoSettings.open = false;
    videoSettings.querySelector('summary').focus();
    event.preventDefault();
    return;
  }
  if (document.fullscreenElement) return;
  if (!videoPanel.hidden) closeVideo(true);
  else if (!lyricsPanel.hidden) {
    setLyricsVisible(false);
    lyricsToggle.focus();
  }
});
audio.addEventListener('ended', () => {
  syncPlayer();
  if (videoPanel.hidden && queueIndex + 1 < queue.length) playAt(queueIndex + 1, true);
});
audio.addEventListener('playing', () => setAudioStatus(''));
audio.addEventListener('error', () => {
  if (!audio.hasAttribute('src')) return;
  syncPlayer();
  setAudioStatus('音频暂时无法播放。', true);
});
audio.addEventListener('timeupdate', refreshLyrics);
audio.addEventListener('seeked', refreshLyrics);
for (const event of ['timeupdate', 'durationchange', 'play', 'pause', 'emptied']) audio.addEventListener(event, syncPlayer);
audio.addEventListener('volumechange', syncVolume);
renderQueueControls();
syncPlayer();
syncSource();
openHome();
void account.restore();
void podcastAccount.restore();
void biliAccount.restore();

try {
  const host = window.parent === window ? null : window.parent.document.body;
  if (host) {
    const updateTheme = () => {
      document.documentElement.dataset.theme = host.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light';
    };
    updateTheme();
    new MutationObserver(updateTheme).observe(host, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
  }
} catch { /* A standalone preview follows the system appearance. */ }
