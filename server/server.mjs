import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseProgressLine,
  publicInfo,
  safeDownloadName,
  validateMediaUrl,
} from './lib.mjs';
import {
  ensureManagedYtDlp,
  updateManagedYtDlp,
  ytDlpVersion,
} from './ytdlp-update.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const DATA_ROOT = resolve(process.env.DATA_DIR || resolve(tmpdir(), 'the-hand-windows'));
const PORTABLE_MODE = process.env.PORTABLE_MODE === '1';
const HOST = PORTABLE_MODE ? '127.0.0.1' : (process.env.HOST || '127.0.0.1');
const PORT = Number(process.env.PORT ?? 8787);
const MAX_ACTIVE = Math.max(1, Number(process.env.MAX_ACTIVE_JOBS || 2));
const MAX_BYTES = Math.max(50 * 1024 * 1024, Number(process.env.MAX_DOWNLOAD_BYTES || 4 * 1024 ** 3));
const INFO_TTL = 10 * 60_000;
const JOB_TTL = Math.max(5 * 60_000, Number(process.env.JOB_RETENTION_MS || 60 * 60_000));
const BODY_LIMIT = 16 * 1024;
const lookups = new Map();
const jobs = new Map();
const queue = [];
const requests = new Map();
let activeJobs = 0;
let activeLookups = 0;
let activeTransfers = 0;
let lastActivity = Date.now();
let ytdlpPath = process.env.YTDLP_PATH ? resolve(process.env.YTDLP_PATH) : 'yt-dlp';
const bundledYtDlpPath = process.env.BUNDLED_YTDLP_PATH
  ? resolve(process.env.BUNDLED_YTDLP_PATH)
  : null;
let ytdlpUpdatesAvailable = PORTABLE_MODE && Boolean(bundledYtDlpPath) && ytdlpPath !== bundledYtDlpPath;
let ytdlpInstalledVersion = '';
let ytdlpUpdateState = 'idle';
let ytdlpUpdateMessage = '';

async function commandFor(args) {
  if (ytdlpPath === 'yt-dlp') return { command: ytdlpPath, args };
  try {
    await access(ytdlpPath, constants.X_OK);
    return { command: ytdlpPath, args };
  } catch {
    return { command: 'python3', args: [ytdlpPath, ...args] };
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function json(res, status, body) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unexpected server error.';
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Invalid JSON request.');
  }
}

function rateLimited(req, bucket, limit) {
  const key = `${req.socket.remoteAddress || 'unknown'}:${bucket}`;
  const now = Date.now();
  const recent = (requests.get(key) || []).filter((time) => now - time < 60_000);
  recent.push(now);
  requests.set(key, recent);
  return recent.length > limit;
}

async function runCapture(args, timeoutMs = 60_000) {
  const command = await commandFor(args);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      killProcess(child, 'SIGKILL');
      finish(new Error('Media lookup timed out.'));
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };

    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > 20 * 1024 * 1024) {
        killProcess(child, 'SIGKILL');
        finish(new Error('The media response was unexpectedly large.'));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.on('error', (error) => finish(new Error(`Unable to start yt-dlp: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null, Buffer.concat(stdout).toString('utf8'));
      else {
        const detail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-4).join('\n');
        finish(new Error(detail || `yt-dlp exited with code ${code}.`));
      }
    });
  });
}

function killProcess(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
    // yt-dlp may have ffmpeg children. Node signals only the immediate process on
    // Windows, so terminate the full process tree instead of orphaning a tool.
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    });
    killer.unref();
  } catch {
    // Process already exited.
  }
}

async function lookup(url) {
  activeLookups += 1;
  try {
    const safeUrl = await validateMediaUrl(url);
    const output = await runCapture([
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--no-cache-dir',
      '--socket-timeout', '15',
      '--retries', '3',
      '--', safeUrl,
    ]);
    let info;
    try {
      info = JSON.parse(output);
    } catch {
      throw new Error('yt-dlp returned invalid media information.');
    }
    const lookupId = randomUUID();
    const result = publicInfo(info, lookupId);
    if (!result.options.some((option) => option.kind === 'video')) {
      throw new Error('No downloadable video formats were found.');
    }
    lookups.set(lookupId, {
      createdAt: Date.now(),
      url: safeUrl,
      title: result.title,
      options: result.options,
    });
    return result;
  } finally {
    activeLookups -= 1;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    optionLabel: job.option.label,
    status: job.status,
    percent: job.percent,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/file` : null,
  };
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

function appendOutput(job, chunk) {
  job.lineBuffer += chunk.toString('utf8');
  const lines = job.lineBuffer.split(/\r?\n/);
  job.lineBuffer = lines.pop() || '';
  for (const line of lines) {
    const progress = parseProgressLine(line);
    if (progress) {
      job.percent = Math.max(job.percent, progress.percent);
      job.downloadedBytes = Math.max(job.downloadedBytes, progress.downloadedBytes);
      job.totalBytes = Math.max(job.totalBytes, progress.totalBytes);
      job.speed = progress.speed;
      job.eta = progress.eta;
    }
    const cleaned = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (cleaned) job.output.push(cleaned);
  }
  if (job.output.length > 30) job.output.splice(0, job.output.length - 30);
}

async function findOutputFile(jobDir) {
  const candidates = [];
  for (const entry of await readdir(jobDir, { withFileTypes: true })) {
    if (!entry.isFile() || /\.(part|ytdl|temp)$/i.test(entry.name)) continue;
    const filePath = resolve(jobDir, entry.name);
    candidates.push({ path: filePath, name: entry.name, size: (await stat(filePath)).size });
  }
  return candidates.sort((a, b) => b.size - a.size)[0] || null;
}

async function startJob(job) {
  activeJobs += 1;
  job.status = 'running';
  job.updatedAt = Date.now();
  try {
    await mkdir(job.dir, { recursive: true });
    const args = [
      '--no-playlist',
      '--no-cache-dir',
      '--newline',
      '--socket-timeout', '15',
      '--retries', '10',
      '--fragment-retries', '10',
      '--concurrent-fragments', '4',
      '--max-filesize', String(MAX_BYTES),
      '--progress-template', 'download:THPROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--paths', job.dir,
      '--output', '%(title).180B [%(id)s].%(ext)s',
      '-f', job.option.formatSpec,
    ];
    if (job.option.kind === 'audio') args.push('--extract-audio', '--audio-format', 'mp3');
    args.push('--', job.url);

    const command = await commandFor(args);
    const child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    job.child = child;
    child.stdout.on('data', (chunk) => appendOutput(job, chunk));
    child.stderr.on('data', (chunk) => appendOutput(job, chunk));
    child.on('error', (error) => {
      job.spawnError = error;
    });

    const sizeTimer = setInterval(async () => {
      try {
        if (await directorySize(job.dir) > MAX_BYTES) {
          job.error = 'Download exceeded the server size limit.';
          killProcess(child, 'SIGTERM');
        }
      } catch {
        // Directory may disappear during cancellation.
      }
    }, 1500);
    const timeout = setTimeout(() => {
      job.error = 'Download exceeded the server time limit.';
      killProcess(child, 'SIGTERM');
    }, 2 * 60 * 60_000);

    const code = await new Promise((resolveCode) => child.on('close', resolveCode));
    clearInterval(sizeTimer);
    clearTimeout(timeout);
    job.child = null;
    if (job.status === 'cancelled') return;
    if (code !== 0 || job.spawnError) {
      const detail = job.output.slice(-6).join('\n');
      throw new Error(job.error || detail || job.spawnError?.message || `yt-dlp exited with code ${code}.`);
    }
    const file = await findOutputFile(job.dir);
    if (!file) throw new Error('The download completed without producing a media file.');
    job.filePath = file.path;
    job.fileName = safeDownloadName(file.name);
    job.downloadedBytes = file.size;
    job.totalBytes = file.size;
    job.percent = 100;
    job.status = 'done';
  } catch (error) {
    if (job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = errorMessage(error).slice(-1200);
    }
  } finally {
    job.updatedAt = Date.now();
    if (job.status === 'cancelled') await removeJobDirectory(job.dir);
    activeJobs -= 1;
    pumpQueue();
  }
}

function pumpQueue() {
  while (activeJobs < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    if (job.status === 'queued') void startJob(job);
  }
}

async function createJob(lookupId, optionId) {
  const lookupEntry = lookups.get(lookupId);
  if (!lookupEntry || Date.now() - lookupEntry.createdAt > INFO_TTL) {
    throw new Error('That media lookup expired. Please look up the URL again.');
  }
  const option = lookupEntry.options.find((entry) => entry.id === optionId);
  if (!option) throw new Error('Select a valid download format.');
  const id = randomUUID();
  const job = {
    id,
    title: lookupEntry.title,
    url: lookupEntry.url,
    option,
    dir: resolve(DATA_ROOT, id),
    status: 'queued',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: option.bytes || 0,
    speed: '',
    eta: '',
    error: '',
    output: [],
    lineBuffer: '',
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(job);
  pumpQueue();
  return publicJob(job);
}

async function removeJobDirectory(path) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 7) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
}

async function cancelAndRemove(job) {
  const child = job.child;
  if (child) {
    killProcess(child, 'SIGTERM');
    setTimeout(() => killProcess(child, 'SIGKILL'), 3000).unref();
  }
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
  await removeJobDirectory(job.dir);
}

async function serveFile(res, job) {
  if (job.status !== 'done' || !job.filePath) return json(res, 409, { error: 'Download is not ready.' });
  let file;
  try {
    file = await stat(job.filePath);
  } catch {
    return json(res, 410, { error: 'The temporary download has expired.' });
  }
  job.updatedAt = Date.now();
  securityHeaders(res);
  const encoded = encodeURIComponent(job.fileName).replace(/['()]/g, escape);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': file.size,
    'Content-Disposition': `attachment; filename="${job.fileName.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, no-store',
  });
  activeTransfers += 1;
  let transferFinished = false;
  const finishTransfer = () => {
    if (transferFinished) return;
    transferFinished = true;
    activeTransfers -= 1;
    lastActivity = Date.now();
  };
  res.on('close', finishTransfer);
  const stream = createReadStream(job.filePath);
  stream.on('error', () => {
    finishTransfer();
    res.destroy();
  });
  stream.pipe(res);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(pathname, res, headOnly = false) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(WEB_ROOT, relative);
  if (filePath !== WEB_ROOT && !filePath.startsWith(`${WEB_ROOT}${sep}`)) return false;
  try {
    const file = await stat(filePath);
    if (!file.isFile()) return false;
    securityHeaders(res);
    res.writeHead(200, {
      'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
      'Content-Length': file.size,
      'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (headOnly) res.end();
    else createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function publicYtDlpStatus() {
  return {
    available: ytdlpUpdatesAvailable,
    version: ytdlpInstalledVersion,
    state: ytdlpUpdateState,
    message: ytdlpUpdateMessage,
  };
}

async function updateYtDlp() {
  if (!ytdlpUpdatesAvailable) throw new Error('yt-dlp updates are managed by this installation.');
  if (ytdlpUpdateState === 'updating') throw new Error('A yt-dlp update is already running.');
  if (activeJobs > 0 || queue.length > 0 || activeLookups > 0) {
    throw new Error('Wait for current lookups and downloads to finish before updating yt-dlp.');
  }

  ytdlpUpdateState = 'updating';
  ytdlpUpdateMessage = '';
  try {
    const result = await updateManagedYtDlp({
      managedPath: ytdlpPath,
      currentVersion: ytdlpInstalledVersion,
    });
    ytdlpInstalledVersion = result.version;
    ytdlpUpdateMessage = result.status === 'updated'
      ? `Updated yt-dlp to ${result.version}.`
      : `yt-dlp ${result.version} is already current.`;
    return { ...publicYtDlpStatus(), state: 'idle', result: result.status };
  } catch (error) {
    ytdlpUpdateMessage = errorMessage(error);
    throw error;
  } finally {
    ytdlpUpdateState = 'idle';
  }
}

function requestOriginAllowed(req) {
  const authority = String(req.headers.host || '');
  let host;
  try {
    host = new URL(`http://${authority}`).hostname;
  } catch {
    return false;
  }
  if (PORTABLE_MODE && !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host)) return false;
  if (['GET', 'HEAD'].includes(req.method || '')) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // Native clients and local command-line diagnostics.
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === authority;
  } catch {
    return false;
  }
}

async function route(req, res) {
  lastActivity = Date.now();
  if (!requestOriginAllowed(req)) {
    return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
  }
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  if (rateLimited(req, 'all', 240)) {
    return json(res, 429, { error: 'Too many requests. Try again shortly.' });
  }
  if (req.method === 'POST' && ['/api/info', '/api/jobs'].includes(pathname) &&
      rateLimited(req, 'expensive', 12)) {
    return json(res, 429, { error: 'Too many download requests. Try again shortly.' });
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      activeJobs,
      queuedJobs: queue.length,
      ytdlpUpdating: ytdlpUpdateState === 'updating',
    });
  }
  if (req.method === 'GET' && pathname === '/api/ytdlp') {
    return json(res, 200, publicYtDlpStatus());
  }
  if (req.method === 'POST' && pathname === '/api/ytdlp/update') {
    try {
      return json(res, 200, await updateYtDlp());
    } catch (error) {
      const busy = ytdlpUpdateState === 'updating' || activeJobs > 0 || queue.length > 0 || activeLookups > 0;
      return json(res, busy ? 409 : 500, { error: errorMessage(error), ...publicYtDlpStatus() });
    }
  }
  if (req.method === 'POST' && pathname === '/api/info') {
    if (ytdlpUpdateState === 'updating') {
      return json(res, 409, { error: 'Wait for the yt-dlp update to finish.' });
    }
    try {
      const body = await readJson(req);
      return json(res, 200, await lookup(body.url));
    } catch (error) {
      return json(res, 400, { error: errorMessage(error) });
    }
  }
  if (req.method === 'POST' && pathname === '/api/jobs') {
    if (ytdlpUpdateState === 'updating') {
      return json(res, 409, { error: 'Wait for the yt-dlp update to finish.' });
    }
    try {
      const body = await readJson(req);
      return json(res, 202, await createJob(body.lookupId, body.optionId));
    } catch (error) {
      return json(res, 400, { error: errorMessage(error) });
    }
  }

  const match = pathname.match(/^\/api\/jobs\/([0-9a-f-]+)(\/file)?$/i);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return json(res, 404, { error: 'Download job not found.' });
    if (req.method === 'GET' && match[2]) return serveFile(res, job);
    if (req.method === 'GET' && !match[2]) return json(res, 200, publicJob(job));
    if (req.method === 'DELETE' && !match[2]) {
      await cancelAndRemove(job);
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (await serveStatic(pathname, res, req.method === 'HEAD')) return;
  }
  return json(res, 404, { error: 'Not found.' });
}

if (ytdlpUpdatesAvailable) {
  try {
    const versions = await ensureManagedYtDlp({
      bundledPath: bundledYtDlpPath,
      managedPath: ytdlpPath,
    });
    ytdlpInstalledVersion = versions.version;
  } catch (error) {
    console.error(`Unable to initialize persistent yt-dlp updates: ${errorMessage(error)}`);
    ytdlpPath = bundledYtDlpPath;
    ytdlpUpdatesAvailable = false;
    ytdlpUpdateMessage = 'Persistent yt-dlp updates are unavailable; using the bundled version.';
    ytdlpInstalledVersion = await ytDlpVersion(ytdlpPath).catch(() => '');
  }
} else {
  ytdlpInstalledVersion = await ytDlpVersion(ytdlpPath).catch(() => '');
}

await mkdir(DATA_ROOT, { recursive: true });
// Jobs are intentionally temporary. Remove only UUID-shaped job directories left
// by a previous unclean shutdown; never sweep arbitrary files from DATA_ROOT.
for (const entry of await readdir(DATA_ROOT, { withFileTypes: true })) {
  if (entry.isDirectory() && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.name)) {
    await rm(resolve(DATA_ROOT, entry.name), { recursive: true, force: true });
  }
}
const server = createServer((req, res) => {
  route(req, res).catch((error) => json(res, 500, { error: errorMessage(error) }));
});

const cleanup = setInterval(async () => {
  const now = Date.now();
  if (PORTABLE_MODE && activeJobs === 0 && activeTransfers === 0 &&
      ytdlpUpdateState !== 'updating' && now - lastActivity > 15 * 60_000) {
    shutdown();
    return;
  }
  for (const [id, lookupEntry] of lookups) {
    if (now - lookupEntry.createdAt > INFO_TTL) lookups.delete(id);
  }
  for (const [id, job] of jobs) {
    if (['running', 'queued'].includes(job.status)) continue;
    if (now - job.updatedAt > JOB_TTL) {
      await rm(job.dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
  for (const [address, times] of requests) {
    const current = times.filter((time) => now - time < 60_000);
    if (current.length) requests.set(address, current);
    else requests.delete(address);
  }
}, 60_000);
cleanup.unref();

function shutdown() {
  clearInterval(cleanup);
  for (const job of jobs.values()) if (job.child) killProcess(job.child, 'SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  const url = `http://${HOST}:${actualPort}`;
  console.log(`The Hand web is listening on ${url}`);
  if (PORTABLE_MODE && process.platform === 'win32') {
    const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    opener.on('error', (error) => console.error(`Unable to open the browser: ${error.message}`));
    opener.unref();
  }
});
