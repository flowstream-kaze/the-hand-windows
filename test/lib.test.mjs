import test from 'node:test';
import assert from 'node:assert/strict';
import {
  curateFormats,
  isPrivateAddress,
  parseProgressLine,
  safeDownloadName,
  validateMediaUrl,
} from '../server/lib.mjs';

test('rejects private network URLs', async () => {
  await assert.rejects(() => validateMediaUrl('http://127.0.0.1/video'), /private network/);
  await assert.rejects(() => validateMediaUrl('http://192.168.1.10/video'), /private network/);
  await assert.rejects(() => validateMediaUrl('file:///etc/passwd'), /HTTP and HTTPS/);
  await assert.rejects(() => validateMediaUrl('https://user:pass@example.com/video'), /HTTP and HTTPS/);
});

test('rejects hostnames resolving to private addresses', async () => {
  const resolver = async () => [{ address: '10.0.0.4', family: 4 }];
  await assert.rejects(() => validateMediaUrl('https://example.test/video', resolver), /private network/);
});

test('accepts a public HTTPS URL', async () => {
  const resolver = async () => [{ address: '142.250.72.206', family: 4 }];
  assert.equal(
    await validateMediaUrl('https://www.youtube.com/watch?v=abc', resolver),
    'https://www.youtube.com/watch?v=abc'
  );
});

test('recognizes private IPv4 and IPv6 ranges', () => {
  assert.equal(isPrivateAddress('172.16.4.2'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('172.32.0.1'), false);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('::ffff:c0a8:101'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('2607:f8b0:4009:80b::200e'), false);
});

test('curates one preferred format per quality tier', () => {
  const formats = curateFormats({ formats: [
    { format_id: '137', height: 1080, fps: 30, vcodec: 'avc1.640028', acodec: 'none', filesize: 80_000_000, tbr: 3000 },
    { format_id: '270', height: 1080, fps: 30, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', filesize_approx: 90_000_000, tbr: 2800 },
    { format_id: '247', height: 720, fps: 30, vcodec: 'vp9', acodec: 'none', filesize: 30_000_000, tbr: 1300 },
    { format_id: '18', height: 360, fps: 30, vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', filesize: 10_000_000, tbr: 600 },
    { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 2_000_000 },
  ] });

  assert.equal(formats[0].formatId, '270');
  assert.equal(formats[0].formatSpec, '270');
  assert.equal(formats[0].recommended, true);
  assert.equal(formats[1].formatSpec, '247+bestaudio/best');
  assert.equal(formats.at(-1).id, 'audio:mp3');
});

test('keeps direct media with unknown resolution', () => {
  const formats = curateFormats({ formats: [
    { format_id: 'https', ext: 'mp4', vcodec: null, acodec: null, filesize: 1024 },
  ] });
  assert.equal(formats[0].formatId, 'https');
  assert.equal(formats[0].formatSpec, 'https');
  assert.match(formats[0].label, /^Original quality/);
});

test('parses machine-readable progress', () => {
  assert.deepEqual(
    parseProgressLine('[download] THPROGRESS|500|1000|NA|50.0%|2.1MiB/s|00:03'),
    { downloadedBytes: 500, totalBytes: 1000, percent: 50, speed: '2.1MiB/s', eta: '00:03' }
  );
  assert.equal(parseProgressLine('[download] Destination: file.mp4'), null);
});

test('sanitizes response filenames', () => {
  assert.equal(safeDownloadName('bad\r\n:name?.mp4'), 'bad_name_.mp4');
  assert.equal(safeDownloadName(''), 'download');
});
