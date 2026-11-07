export function parseShare(text) {
  const candidate = String(text ?? '').match(/https?:\/\/[^\s<>"，。]+/i)?.[0];
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) return null;
    if (url.hostname === 'xyzfm.link' && /^\/[A-Za-z0-9_-]{1,100}\/?$/.test(url.pathname)) {
      return { source: 'xiaoyuzhou', type: 'short', code: url.pathname.replaceAll('/', '') };
    }
    if (['www.xiaoyuzhoufm.com', 'xiaoyuzhoufm.com', 'ask.xiaoyuzhoufm.com'].includes(url.hostname)) {
      const route = /^\/(podcast|episode)\/([a-f0-9]{24})\/?$/i.exec(url.pathname);
      return route ? { source: 'xiaoyuzhou', type: route[1].toLowerCase(), id: route[2].toLowerCase() } : null;
    }
    if (!['music.163.com', 'y.music.163.com'].includes(url.hostname)) return null;
    const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
    const id = route.searchParams.get('id');
    if (!/^\/(?:m\/)?playlist\/?$/.test(route.pathname) || !/^[1-9][0-9]{0,15}$/.test(id ?? '')) return null;
    return { source: 'netease', type: 'playlist', id };
  } catch {
    return null;
  }
}

export function bilibiliPlayerUrl(id) {
  const params = new URLSearchParams({ autoplay: '0', danmaku: '0' });
  if (/^BV[a-zA-Z0-9]{10}$/.test(id)) params.set('bvid', id);
  else if (/^av[1-9][0-9]{0,17}$/.test(id)) params.set('aid', id.slice(2));
  else return null;
  return 'https://player.bilibili.com/player.html?' + params;
}
