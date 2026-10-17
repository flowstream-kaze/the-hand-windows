const $ = (selector) => document.querySelector(selector);

const lookupForm = $('#lookup-form');
const urlInput = $('#url-input');
const lookupButton = $('#lookup-button');
const pasteButton = $('#paste-button');
const globalError = $('#global-error');
const results = $('#results');
const formatList = $('#format-list');
const startButton = $('#start-button');
const newLinkButton = $('#new-link-button');
const jobPanel = $('#job-panel');
const cancelButton = $('#cancel-button');
const retryButton = $('#retry-button');
const downloadButton = $('#download-button');

let lookupResult = null;
let selectedOption = null;
let currentJobId = null;
let pollTimer = null;

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.label) button.dataset.label = button.querySelector('span')?.textContent || button.textContent;
  button.disabled = busy;
  const label = button.querySelector('span') || button;
  label.textContent = busy ? busyLabel : button.dataset.label;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function icon(kind) {
  return kind === 'audio'
    ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v10.6a3.5 3.5 0 1 0 2 3.2V8h5V3h-7Zm-3.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>'
    : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5h12v14H4V5Zm2 2v10h8V7H6Zm12 1 3-2v12l-3-2V8Z"/></svg>';
}

function selectFormat(option, button) {
  selectedOption = option;
  for (const item of formatList.querySelectorAll('.format-option')) {
    const selected = item === button;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-checked', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  startButton.disabled = false;
}

function renderInfo(info) {
  lookupResult = info;
  selectedOption = null;
  $('#media-title').textContent = info.title;
  $('#media-creator').textContent = info.creator || 'Unknown creator';
  $('#media-duration').textContent = formatDuration(info.duration);
  $('#media-duration').hidden = !info.duration;
  const thumbnail = $('#media-thumbnail');
  thumbnail.src = info.thumbnail || '/icon-192.png';
  thumbnail.alt = info.thumbnail ? `Thumbnail for ${info.title}` : '';
  formatList.replaceChildren();

  info.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'format-option';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.tabIndex = index === 0 ? 0 : -1;

    const iconBox = document.createElement('span');
    iconBox.className = 'format-icon';
    iconBox.innerHTML = icon(option.kind);
    const copy = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'format-title';
    title.textContent = option.label;
    const detail = document.createElement('span');
    detail.className = 'format-detail';
    detail.textContent = option.bytes
      ? `${option.approximate ? 'Approximately ' : ''}${formatBytes(option.bytes)}`
      : option.kind === 'audio' ? 'Converted with ffmpeg' : 'Size unavailable';
    copy.append(title, detail);
    const trailing = document.createElement('span');
    trailing.className = option.recommended ? 'recommended' : 'radio-dot';
    trailing.textContent = option.recommended ? 'RECOMMENDED' : '';
    if (option.recommended) {
      const dot = document.createElement('span');
      dot.className = 'radio-dot';
      trailing.append(' ', dot);
    }
    button.append(iconBox, copy, trailing);
    button.addEventListener('click', () => selectFormat(option, button));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return;
      event.preventDefault();
      const items = [...formatList.querySelectorAll('.format-option')];
      const direction = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
      const next = items[(items.indexOf(button) + direction + items.length) % items.length];
      next.focus();
      next.click();
    });
    formatList.append(button);
    if (option.recommended) selectFormat(option, button);
  });
  if (!selectedOption && info.options.length) selectFormat(info.options[0], formatList.firstElementChild);

  results.hidden = false;
  jobPanel.hidden = true;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

lookupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(globalError);
  results.hidden = true;
  jobPanel.hidden = true;
  setBusy(lookupButton, true, 'Looking up…');
  try {
    renderInfo(await api('/api/info', {
      method: 'POST',
      body: JSON.stringify({ url: urlInput.value.trim() }),
    }));
  } catch (error) {
    showError(globalError, error.message);
  } finally {
    setBusy(lookupButton, false, 'Looking up…');
  }
});

pasteButton.addEventListener('click', async () => {
  showError(globalError);
  try {
    urlInput.value = await navigator.clipboard.readText();
    urlInput.focus();
  } catch {
    showError(globalError, 'Clipboard access was blocked. Paste the URL into the field manually.');
  }
});

newLinkButton.addEventListener('click', () => {
  results.hidden = true;
  jobPanel.hidden = true;
  urlInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

startButton.addEventListener('click', async () => {
  if (!lookupResult || !selectedOption) return;
  startButton.disabled = true;
  showError($('#job-error'));
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ lookupId: lookupResult.lookupId, optionId: selectedOption.id }),
    });
    currentJobId = job.id;
    results.hidden = true;
    jobPanel.hidden = false;
    cancelButton.hidden = false;
    retryButton.hidden = true;
    downloadButton.hidden = true;
    renderJob(job);
    jobPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    schedulePoll();
  } catch (error) {
    showError(globalError, error.message);
    startButton.disabled = false;
  }
});

function renderJob(job) {
  const statusLabels = { queued: 'Queued', running: 'Downloading', done: 'Ready', failed: 'Failed', cancelled: 'Cancelled' };
  $('#job-heading').textContent = job.status === 'done' ? 'Your download is ready' : 'Preparing download';
  $('#job-title').textContent = job.title;
  $('#job-option').textContent = job.optionLabel;
  const status = $('#job-status');
  status.textContent = statusLabels[job.status] || job.status;
  status.dataset.status = job.status;
  const percent = Math.round(job.percent || 0);
  $('#job-percent').textContent = `${percent}%`;
  $('#progress-bar').style.width = `${percent}%`;
  $('.progress-track').setAttribute('aria-valuenow', String(percent));
  const downloaded = formatBytes(job.downloadedBytes);
  const total = formatBytes(job.totalBytes);
  $('#job-bytes').textContent = downloaded ? `${downloaded}${total ? ` / ${total}` : ''}` : 'Waiting for data';
  $('#job-speed').textContent = [job.speed, job.eta ? `ETA ${job.eta}` : ''].filter(Boolean).join(' · ');
  showError($('#job-error'), job.status === 'failed' ? job.error : '');

  if (job.status === 'done') {
    cancelButton.hidden = true;
    downloadButton.href = job.downloadUrl;
    downloadButton.hidden = false;
    retryButton.hidden = true;
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    cancelButton.hidden = true;
    downloadButton.hidden = true;
    retryButton.hidden = false;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollJob, 700);
}

async function pollJob() {
  if (!currentJobId) return;
  try {
    const job = await api(`/api/jobs/${currentJobId}`);
    renderJob(job);
    if (job.status === 'queued' || job.status === 'running') schedulePoll();
  } catch (error) {
    showError($('#job-error'), error.message);
    schedulePoll();
  }
}

cancelButton.addEventListener('click', async () => {
  if (!currentJobId) return;
  cancelButton.disabled = true;
  clearTimeout(pollTimer);
  try {
    await api(`/api/jobs/${currentJobId}`, { method: 'DELETE' });
    renderJob({
      id: currentJobId,
      title: $('#job-title').textContent,
      optionLabel: $('#job-option').textContent,
      status: 'cancelled', percent: 0, downloadedBytes: 0, totalBytes: 0,
      speed: '', eta: '', error: '',
    });
  } catch (error) {
    showError($('#job-error'), error.message);
  } finally {
    cancelButton.disabled = false;
  }
});

retryButton.addEventListener('click', () => {
  jobPanel.hidden = true;
  results.hidden = false;
  startButton.disabled = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Keeps the hidden portable server alive only while this page remains open.
setInterval(() => {
  fetch('/api/health', { cache: 'no-store' }).catch(() => {});
}, 60_000);
