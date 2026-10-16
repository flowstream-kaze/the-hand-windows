import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^224\./,
  /^2(?:2[4-9]|3\d)\./,
];

function isPrivateIpv4(address) {
  if (PRIVATE_V4.some((pattern) => pattern.test(address))) return true;
  const parts = address.split('.').map(Number);
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (!net.isIPv6(address)) return true;
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (net.isIPv4(mapped)) return isPrivateIpv4(mapped);
    const words = mapped.split(':');
    if (words.length === 2) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
  }
  return value === '::1' || value === '::' || value.startsWith('fc') ||
    value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
    value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff');
}

export async function validateMediaUrl(input, resolver = dns.lookup) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new Error('Enter a valid media URL.');
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a valid media URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP and HTTPS URLs are supported.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('URLs with custom ports are not supported.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Local and private network URLs are not supported.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error('Local and private network URLs are not supported.');
    }
  } else {
    let addresses;
    try {
      addresses = await resolver(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('The URL hostname could not be resolved.');
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('Local and private network URLs are not supported.');
    }
  }

  return url.toString();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function codecName(codec = '') {
  const value = String(codec || '').toLowerCase();
  if (value.startsWith('avc1') || value.startsWith('h264')) return 'H.264';
  if (value.startsWith('vp9') || value.startsWith('vp09')) return 'VP9';
  if (value.startsWith('av01') || value.startsWith('av1')) return 'AV1';
  if (value.startsWith('hevc') || value.startsWith('h265')) return 'H.265';
  return codec && codec !== 'none' ? codec.split('.')[0].toUpperCase() : 'video';
}

function betterFormat(candidate, current) {
  const candidateCombined = candidate.acodec && candidate.acodec !== 'none';
  const currentCombined = current.acodec && current.acodec !== 'none';
  if (candidateCombined !== currentCombined) return candidateCombined;
  const candidateExact = number(candidate.filesize) > 0;
  const currentExact = number(current.filesize) > 0;
  if (candidateExact !== currentExact) return candidateExact;
  return number(candidate.tbr) > number(current.tbr);
}

export function curateFormats(info, limit = 4) {
  const groups = new Map();
  const videoExtensions = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', '3gp']);
  for (const format of info?.formats ?? []) {
    const height = number(format.height);
    const fps = Math.round(number(format.fps));
    const hasVideo = (format.vcodec && format.vcodec !== 'none') ||
      (!format.vcodec && videoExtensions.has(String(format.ext).toLowerCase()));
    if (!format.format_id || !hasVideo) continue;
    const key = height ? `${Math.round(height)}:${fps}` : 'original';
    const current = groups.get(key);
    if (!current || betterFormat(format, current)) groups.set(key, format);
  }

  const videos = [...groups.values()]
    .sort((a, b) => number(b.height) - number(a.height) || number(b.fps) - number(a.fps))
    .slice(0, limit)
    .map((format, index) => {
      const exactSize = number(format.filesize);
      const approximateSize = number(format.filesize_approx);
      const hasAudio = format.acodec !== 'none' && Boolean(format.acodec || !format.vcodec);
      return {
        id: `video:${format.format_id}`,
        kind: 'video',
        formatId: String(format.format_id),
        formatSpec: hasAudio ? String(format.format_id) : `${format.format_id}+bestaudio/best`,
        label: `${number(format.height) ? `${Math.round(number(format.height))}p` : 'Original quality'}${number(format.fps) ? ` · ${Math.round(number(format.fps))} fps` : ''} · ${codecName(format.vcodec)}`,
        bytes: exactSize || approximateSize,
        approximate: !exactSize && !!approximateSize,
        recommended: index === 0,
      };
    });

  videos.push({
    id: 'audio:mp3',
    kind: 'audio',
    formatId: 'bestaudio',
    formatSpec: 'bestaudio/best',
    label: 'Audio · MP3 · best quality',
    bytes: 0,
    approximate: false,
    recommended: false,
  });
  return videos;
}

export function publicInfo(info, lookupId) {
  return {
    lookupId,
    title: String(info.title || 'Untitled media'),
    creator: String(info.uploader || info.channel || ''),
    duration: number(info.duration),
    thumbnail: typeof info.thumbnail === 'string' ? info.thumbnail : '',
    options: curateFormats(info),
  };
}

export function parseProgressLine(line) {
  const marker = 'THPROGRESS|';
  const index = line.indexOf(marker);
  if (index < 0) return null;
  const [downloaded, total, estimate, percent, speed, eta] = line
    .slice(index + marker.length)
    .split('|');
  const downloadedBytes = number(downloaded);
  const totalBytes = number(total) || number(estimate);
  const numericPercent = Number.parseFloat(String(percent).replace('%', '').trim());
  const derivedPercent = totalBytes ? (downloadedBytes / totalBytes) * 100 : 0;
  return {
    downloadedBytes,
    totalBytes,
    percent: Math.max(0, Math.min(99.9, Number.isFinite(numericPercent) ? numericPercent : derivedPercent)),
    speed: speed && speed !== 'NA' ? speed.trim() : '',
    eta: eta && eta !== 'NA' ? eta.trim() : '',
  };
}

export function safeDownloadName(name) {
  return String(name || 'download')
    .replace(/[\r\n\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 180) || 'download';
}
