import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function versionParts(version) {
  const value = String(version || '').trim();
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/.test(value)) return null;
  return value.split('.').map(Number);
}

export function compareYtDlpVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return String(left).localeCompare(String(right), 'en', { numeric: true });
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export async function ytDlpVersion(path) {
  const { stdout } = await execFileAsync(path, ['--version'], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const version = String(stdout).trim().split(/\r?\n/)[0];
  if (!versionParts(version)) throw new Error('yt-dlp returned an invalid version.');
  return version;
}

export async function runOfficialYtDlpUpdate(path) {
  try {
    return await execFileAsync(path, ['--update-to', 'stable'], {
      timeout: 2 * 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').trim();
    throw new Error(detail ? `yt-dlp update failed: ${detail.slice(-1000)}` : 'yt-dlp update failed.');
  }
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function installFile(source, destination, versionReader) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.new-${randomUUID()}`;
  const backup = `${destination}.old-${randomUUID()}`;
  let movedExisting = false;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    const version = await versionReader(temporary);
    if (await exists(destination)) {
      await rename(destination, backup);
      movedExisting = true;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (movedExisting) await rename(backup, destination).catch(() => {});
      throw error;
    }
    if (movedExisting) await rm(backup, { force: true });
    return version;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (movedExisting && await exists(backup) && !await exists(destination)) {
      await rename(backup, destination).catch(() => {});
    }
    await rm(backup, { force: true }).catch(() => {});
  }
}

export async function ensureManagedYtDlp({ bundledPath, managedPath, versionReader = ytDlpVersion }) {
  const bundledVersion = await versionReader(bundledPath);
  let managedVersion = null;
  try {
    managedVersion = await versionReader(managedPath);
  } catch {
    // Missing or damaged managed copy: restore the known-good bundled binary.
  }
  if (!managedVersion || compareYtDlpVersions(bundledVersion, managedVersion) > 0) {
    managedVersion = await installFile(bundledPath, managedPath, versionReader);
  }
  return { version: managedVersion, bundledVersion };
}

export async function updateManagedYtDlp({
  managedPath,
  currentVersion,
  versionReader = ytDlpVersion,
  updateRunner = runOfficialYtDlpUpdate,
}) {
  // Update a disposable candidate first. yt-dlp verifies the downloaded executable
  // against the release SHA2-256SUMS before replacing this candidate. The active
  // binary is touched only after the candidate starts and reports a valid version.
  await mkdir(dirname(managedPath), { recursive: true });
  const candidate = `${managedPath}.update-${randomUUID()}.exe`;
  try {
    await copyFile(managedPath, candidate);
    await chmod(candidate, 0o755);
    await updateRunner(candidate);
    const candidateVersion = await versionReader(candidate);
    if (compareYtDlpVersions(candidateVersion, currentVersion) <= 0) {
      return { status: 'current', version: currentVersion, latestVersion: candidateVersion };
    }
    const installedVersion = await installFile(candidate, managedPath, versionReader);
    return { status: 'updated', version: installedVersion, latestVersion: candidateVersion };
  } finally {
    await rm(candidate, { force: true }).catch(() => {});
    await rm(`${candidate}.old`, { force: true }).catch(() => {});
  }
}
