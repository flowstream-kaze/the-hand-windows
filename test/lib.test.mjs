import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  curateFormats,
  isPrivateAddress,
  parseProgressLine,
  safeDownloadName,
  validateMediaUrl,
} from '../server/lib.mjs';
import {
  compareYtDlpVersions,
  ensureManagedYtDlp,
  updateManagedYtDlp,
} from '../server/ytdlp-update.mjs';

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

test('compares yt-dlp calendar versions numerically', () => {
  assert.equal(compareYtDlpVersions('2026.10.2', '2026.9.30'), 1);
  assert.equal(compareYtDlpVersions('2026.10.21', '2026.10.21'), 0);
  assert.equal(compareYtDlpVersions('2026.8.19', '2026.10.1'), -1);
});

test('restores or upgrades the managed yt-dlp copy from the bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'the-hand-ytdlp-'));
  const bundledPath = join(directory, 'bundled.exe');
  const managedPath = join(directory, 'managed', 'yt-dlp.exe');
  const versionReader = async (path) => (await readFile(path, 'utf8')).trim();
  try {
    await writeFile(bundledPath, '2026.08.19');
    let status = await ensureManagedYtDlp({ bundledPath, managedPath, versionReader });
    assert.equal(status.version, '2026.08.19');
    assert.equal(await readFile(managedPath, 'utf8'), '2026.08.19');

    await writeFile(bundledPath, '2026.10.21');
    status = await ensureManagedYtDlp({ bundledPath, managedPath, versionReader });
    assert.equal(status.version, '2026.10.21');
    assert.equal(await readFile(managedPath, 'utf8'), '2026.10.21');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('updates a disposable candidate before replacing managed yt-dlp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'the-hand-ytdlp-update-'));
  const managedPath = join(directory, 'yt-dlp.exe');
  const versionReader = async (path) => (await readFile(path, 'utf8')).trim();
  const updateRunner = async (path) => writeFile(path, '2026.10.21');
  try {
    await writeFile(managedPath, '2026.08.19');
    const result = await updateManagedYtDlp({
      managedPath,
      currentVersion: '2026.08.19',
      versionReader,
      updateRunner,
    });
    assert.equal(result.status, 'updated');
    assert.equal(result.version, '2026.10.21');
    assert.equal(await readFile(managedPath, 'utf8'), '2026.10.21');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed candidate update leaves the installed yt-dlp untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'the-hand-ytdlp-failed-'));
  const managedPath = join(directory, 'yt-dlp.exe');
  try {
    await writeFile(managedPath, '2026.08.19');
    await assert.rejects(() => updateManagedYtDlp({
      managedPath,
      currentVersion: '2026.08.19',
      versionReader: async (path) => (await readFile(path, 'utf8')).trim(),
      updateRunner: async (path) => {
        await writeFile(path, 'damaged download');
        throw new Error('official checksum verification failed');
      },
    }), /checksum/);
    assert.equal(await readFile(managedPath, 'utf8'), '2026.08.19');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
