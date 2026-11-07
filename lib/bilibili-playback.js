import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MusicError } from './netease.js';

const MEDIA_ROOT = 'api/bilibili/media/';
const LEASE_MS = 90 * 60_000;
const MAX_RANGE = 32 * 1024 * 1024;
const CDN = /^(?:[a-z0-9-]+\.)+bilivideo\.(?:com|cn|net)$|^upos-[a-z0-9-]+\.akamaized\.net$/i;
const QUALITY = { 16: '360P', 32: '480P', 64: '720P', 74: '720P 60 帧', 80: '1080P',
  112: '1080P+', 116: '1080P 60 帧', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K' };

function cdnUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !CDN.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function track(item, kind) {
  if (!item || !Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.bandwidth) || item.bandwidth <= 0) return null;
  const video = kind === 'video';
  const codec = item.codecs;
  if (!(video ? /^avc1\.[a-f0-9]{6}$/i : /^mp4a\.40\.2$/).test(codec)) return null;
  if (video && (![item.width, item.height].every(Number.isSafeInteger) || item.width <= 0 || item.height <= 0)) return null;
  const segment = item.SegmentBase ?? item.segment_base;
  const init = segment?.Initialization ?? segment?.initialization;
  const index = segment?.indexRange ?? segment?.index_range;
  const range = /^\d{1,12}-\d{1,12}$/;
  if (!range.test(init) || !range.test(index)) return null;
  const backups = item.backupUrl ?? item.backup_url;
  const urls = [item.baseUrl ?? item.base_url, ...(Array.isArray(backups) ? backups.slice(0, 3) : [])].map(cdnUrl).filter(Boolean);
  if (!urls.length) return null;
  return {
    id: kind + '-' + item.id, quality: item.id, kind, codec, urls, init, index,
    bandwidth: item.bandwidth, width: item.width, height: item.height,
    frameRate: /^\d{1,7}(?:\/\d{1,7})?$/.test(item.frameRate) ? item.frameRate : '',
  };
}

function representation(item) {
  const dimensions = item.kind === 'video'
    ? ` width="${item.width}" height="${item.height}"${item.frameRate ? ` frameRate="${item.frameRate}"` : ''}` : '';
  return `<Representation id="${item.id}" bandwidth="${item.bandwidth}" codecs="${item.codec}"${dimensions}>
<BaseURL>${item.id}.m4s</BaseURL><SegmentBase indexRange="${item.index}"><Initialization range="${item.init}"/></SegmentBase>
</Representation>`;
}

function manifest(duration, videos, audio) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT2S" mediaPresentationDuration="PT${duration}S">
<Period start="PT0S">
<AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">${videos.map(representation).join('')}</AdaptationSet>
<AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true">${representation(audio)}</AdaptationSet>
</Period></MPD>`;
}

export function createBilibiliPlayback(service, accounts, fetcher = globalThis.fetch) {
  const leases = new Map();

  function getLease(id) {
    const lease = leases.get(id);
    if (lease && lease.expires > Date.now()) return lease;
    leases.delete(id);
    throw new MusicError(404, '视频播放地址已失效，请重新打开视频。');
  }

  return {
    async open(id, token) {
      return accounts.use(token, async account => {
        const { aid, cid, referer, dash } = await service.playback(id, account);
        const duration = dash.duration;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) {
          throw new MusicError(502, '哔哩哔哩未返回有效的视频时长。');
        }
        const candidates = Array.isArray(dash.video) ? dash.video.map(item => track(item, 'video')).filter(Boolean) : [];
        const videos = [...new Map(candidates.map(item => [item.id, item])).values()].sort((a, b) => b.quality - a.quality);
        const audio = (Array.isArray(dash.audio) ? dash.audio : []).map(item => track(item, 'audio')).filter(Boolean)
          .sort((a, b) => b.bandwidth - a.bandwidth)[0];
        if (!videos.length || !audio) throw new MusicError(404, '当前视频没有可用的网页画质。');
        for (const [id, lease] of leases) if (lease.expires <= Date.now()) leases.delete(id);
        while (leases.size >= 32) leases.delete(leases.keys().next().value);
        const leaseId = randomUUID().replaceAll('-', '');
        leases.set(leaseId, {
          token, aid, cid, referer, duration, expires: Date.now() + LEASE_MS,
          tracks: new Map([...videos, audio].map(item => [item.id + '.m4s', item])),
          manifest: manifest(duration, videos, audio),
        });
        return {
          id: leaseId, manifest: './' + MEDIA_ROOT + leaseId + '/manifest.mpd',
          qualities: videos.map(item => ({ id: item.id, label: QUALITY[item.quality] ?? item.height + 'P' })),
          vip: account.credentials.vip === true, history: Boolean(account.credentials.csrf),
        };
      }, true);
    },

    async history(params, token) {
      const lease = getLease(params.get('id'));
      if (!token || lease.token !== token) throw new MusicError(401, '播放会话已失效。');
      const position = Number(params.get('position') ?? NaN);
      const watched = Number(params.get('watched') ?? NaN);
      const event = Number(params.get('event') ?? NaN);
      if (!Number.isSafeInteger(position) || position < -1 || position > Math.ceil(lease.duration) ||
          !Number.isSafeInteger(watched) || watched < 1 || watched > Math.ceil(lease.duration) ||
          ![0, 1, 2, 4].includes(event) || (position === -1 && event !== 4)) {
        throw new MusicError(400, '无效的观看进度。');
      }
      lease.start ??= Math.floor(Date.now() / 1000) - watched;
      return accounts.use(token, account => service.reportHistory(lease, { position, watched, event }, account), true);
    },

    async serve(id, file, req, res) {
      const lease = getLease(id);
      await accounts.use(lease.token, () => null, true);
      const headers = {
        'cache-control': 'private, no-store', 'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff',
      };
      if (file === 'manifest.mpd') {
        res.writeHead(200, { ...headers, 'content-type': 'application/dash+xml' });
        return res.end(req.method === 'HEAD' ? undefined : lease.manifest);
      }
      const item = lease.tracks.get(file);
      if (!item) throw new MusicError(404, '找不到此视频轨道。');
      const match = /^bytes=(\d{1,12})-(\d{1,12})$/.exec(req.headers?.range ?? '');
      const start = Number(match?.[1]);
      const end = Number(match?.[2]);
      if (!match || end < start || end - start + 1 > MAX_RANGE) throw new MusicError(416, '无效的视频分段范围。');
      const controller = new AbortController();
      const stop = () => controller.abort();
      res.once('close', stop);
      try {
        for (const url of item.urls) {
          if (controller.signal.aborted) return;
          let response;
          try {
            response = await fetcher(url, {
              method: req.method, redirect: 'error',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              headers: { range: match[0], referer: lease.referer, 'accept-encoding': 'identity' },
            });
          } catch { continue; }
          const contentRange = response.headers.get('content-range');
          const actual = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
          if (response.status !== 206 || !actual || Number(actual[1]) !== start || Number(actual[2]) > end ||
              Number(actual[2]) < start || (req.method === 'GET' && !response.body)) {
            await response.body?.cancel().catch(() => {});
            continue;
          }
          res.writeHead(206, { ...headers, 'content-type': item.kind + '/mp4', 'accept-ranges': 'bytes',
            'content-range': contentRange, 'content-length': Number(actual[2]) - start + 1 });
          if (req.method === 'HEAD') return res.end();
          await pipeline(Readable.fromWeb(response.body), res).catch(() => {});
          return;
        }
        if (!controller.signal.aborted) throw new MusicError(502, '哔哩哔哩的视频分段暂时无法加载。');
      } finally {
        res.off('close', stop);
      }
    },
  };
}
