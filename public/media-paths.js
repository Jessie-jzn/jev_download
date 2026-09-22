// Pure path rules shared by the browser preview and server-owned move planning.
export function sanitizeSegment(value, fallback) {
  return cleanSegment(value) ?? cleanSegment(fallback) ?? '未知';
}

function cleanSegment(value) {
  if (typeof value !== 'string') return null;
  const pieces = value.normalize('NFC').trim()
    .split(/[\\/]/)
    .filter(piece => piece !== '.' && piece !== '..')
    .map(piece => piece.replace(/[:\u0000-\u001F\u007F-\u009F]/g, '_'));
  const normalized = pieces.join('_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') return null;
  return [...normalized].slice(0, 80).join('') || null;
}

export function validateMediaOverrides(input) {
  const overrides = {};
  for (const key of ['year', 'month', 'country', 'city', 'mediaType']) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error('媒体选择无效。');
    const trimmed = value.trim();
    const blankPlace = trimmed === '' && ['country', 'city'].includes(key);
    if (!blankPlace && (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/\0]/.test(trimmed))) {
      throw new Error('路径段无效。');
    }
    overrides[key] = value;
  }
  return overrides;
}

export function buildMediaSegments(facts = {}, overrides = {}) {
  const year = overrides.year ?? facts.year;
  const month = overrides.month ?? facts.month;
  if (!(year === '未知日期' || /^\d{4}$/.test(year))) throw new Error('invalid year');
  if (!(month === '未知月份' || /^(0[1-9]|1[0-2])$/.test(month))) throw new Error('invalid month');

  const mediaType = overrides.mediaType ?? facts.mediaType;
  const mediaDirectory = overrides.mediaDirectory
    ?? facts.mediaDirectory
    ?? (mediaType === 'photo' || mediaType === 'live-photo' ? '照片' : mediaType === 'video' ? '视频' : null);
  if (mediaDirectory !== '照片' && mediaDirectory !== '视频') throw new Error('invalid media type');

  return [year, month,
    sanitizeSegment(overrides.country ?? facts.country, '未知国家'),
    sanitizeSegment(overrides.city ?? facts.city, '未知城市'), mediaDirectory];
}
