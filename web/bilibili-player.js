import { MediaPlayer } from './dash.mediaplayer.min.js';

function watchedSeconds(video) {
  let seconds = 0;
  for (let index = 0; index < video.played.length; index++) {
    seconds += video.played.end(index) - video.played.start(index);
  }
  return Math.floor(seconds);
}

export function playBilibili({ video, quality, history, settings, playback, report, signal, onError, onHistory }) {
  const player = MediaPlayer().create();
  let sent = '';
  let lastSentAt = -Infinity;
  let reporting = Promise.resolve();
  let initialized = false;

  function sync(event = 0) {
    if (!playback.history || !history.checked || video.seeking) return;
    const watched = watchedSeconds(video);
    if (watched < 1) return;
    const position = video.ended ? -1 : Math.floor(video.currentTime);
    const key = String(position);
    if (key === sent || (event === 0 && Date.now() - lastSentAt < 15_000)) return;
    const kind = video.ended ? 4 : sent ? event : 1;
    sent = key;
    lastSentAt = Date.now();
    reporting = reporting.then(async () => {
      if (!history.checked) return;
      try {
        await report({ position, watched, event: kind });
        if (!signal.aborted) onHistory('');
      } catch (error) {
        if (sent === key) sent = '';
        if (!signal.aborted) onHistory(error.message || '观看进度暂时无法同步');
      }
    });
  }

  history.addEventListener('change', () => {
    settings(history.checked);
    onHistory('');
    if (history.checked) sync(2);
  }, { signal });
  video.addEventListener('timeupdate', () => {
    if (!video.paused) sync();
  }, { signal });
  video.addEventListener('pause', () => sync(2), { signal });
  video.addEventListener('ended', () => sync(4), { signal });
  window.addEventListener('pagehide', () => sync(4), { signal });

  quality.addEventListener('change', () => {
    const automatic = quality.value === 'auto';
    player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: automatic } } } });
    if (!automatic) player.setRepresentationForTypeById('video', quality.value);
  }, { signal });

  player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
    if (signal.aborted || initialized) return;
    initialized = true;
    const available = new Set(player.getRepresentationsByType('video').map(track => track.id));
    const choices = playback.qualities.filter(option => available.has(option.id));
    quality.replaceChildren(new Option('自动', 'auto'), ...choices.map(option => new Option(option.label, option.id)));
    quality.disabled = choices.length === 0;
  });
  player.on(MediaPlayer.events.ERROR, () => {
    if (!signal.aborted) onError(initialized);
  });
  player.initialize(video, new URL(playback.manifest, location.href).href, false);

  return () => {
    sync(4);
    player.destroy();
  };
}
