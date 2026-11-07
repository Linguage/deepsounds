export function parseLrc(text) {
  const offset = Number(text.match(/\[offset:\s*([+-]?\d+)\s*\]/i)?.[1] ?? 0);
  const lines = [];
  for (const row of text.split(/\r?\n/)) {
    const matches = [...row.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    const content = row.slice((matches.at(-1)?.index ?? row.length) + (matches.at(-1)?.[0].length ?? 0)).trim();
    if (!content) continue;
    for (const [, minute, second, fraction] of matches) {
      const time = (Number(minute) * 60 + Number(second)) * 1000 + Number((fraction ?? '').padEnd(3, '0')) + offset;
      if (Number.isFinite(time)) lines.push({ time: Math.max(0, time), text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function activeLine(lines, time) {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function mergeLyrics(original, translation) {
  const lines = parseLrc(original);
  const translated = parseLrc(translation);
  if (!lines.length) return translated;
  return lines.map(line => {
    const index = activeLine(translated, line.time);
    const candidates = [translated[index], translated[index + 1]].filter(Boolean);
    candidates.sort((a, b) => Math.abs(a.time - line.time) - Math.abs(b.time - line.time));
    const nearest = candidates[0];
    return nearest && Math.abs(nearest.time - line.time) <= 350 && nearest.text !== line.text ?
      { ...line, translation: nearest.text } : line;
  });
}
