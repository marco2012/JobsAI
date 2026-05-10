// ── chrome.storage helpers ───────────────────────────────────────────────────

function loadJobs() {
  return new Promise(r => chrome.storage.local.get('trackedJobs', d => r(d.trackedJobs || [])));
}
function saveJobs(jobs) {
  return new Promise(r => chrome.storage.local.set({ trackedJobs: jobs }, r));
}
function loadSettings() {
  return new Promise(r => chrome.storage.local.get('settings', d => r(d.settings || {})));
}
function saveSettings(s) {
  return new Promise(r => chrome.storage.local.set({ settings: s }, r));
}

// ── Utilities ────────────────────────────────────────────────────────────────

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str || ''));
  return d.innerHTML;
}

function fmt(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return ''; }
}

// ── Render job list (with pagination) ───────────────────────────────────────

const PAGE_SIZE = 5;
let currentPage = 0;

async function render(page) {
  if (page !== undefined) currentPage = page;

  const jobs      = await loadJobs();
  const subtitle  = document.getElementById('subtitle');
  const list      = document.getElementById('jobList');
  const exportBtn = document.getElementById('exportBtn');

  subtitle.textContent = `${jobs.length} job${jobs.length !== 1 ? 's' : ''} tracked`;
  exportBtn.disabled   = jobs.length === 0;

  if (jobs.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No jobs tracked yet</div>
        <div class="empty-desc">Browse LinkedIn jobs and click <strong>+ Track</strong> in the job detail panel.</div>
      </div>`;
    return;
  }

  // Newest first
  jobs.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));

  const totalPages = Math.ceil(jobs.length / PAGE_SIZE);
  // Clamp currentPage after a removal may reduce total pages
  if (currentPage >= totalPages) currentPage = totalPages - 1;

  const start    = currentPage * PAGE_SIZE;
  const pageJobs = jobs.slice(start, start + PAGE_SIZE);

  const pagerEl = document.getElementById('pager');
  pagerEl.innerHTML = `
    <div class="pager">
      <button class="pager-btn" id="prevBtn" ${currentPage === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="pager-info">${currentPage + 1} / ${totalPages}</span>
      <button class="pager-btn" id="nextBtn" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
    </div>`;

  list.innerHTML = pageJobs.map((job, i) => {
    const chips = [job.location, job.postedDate].filter(Boolean)
      .map(c => `<span class="chip">${esc(c)}</span>`).join('');
    const hasDesc = job.description && job.description.trim().length > 30;
    const descBadge = hasDesc
      ? `<span class="desc-ok" title="Description saved">✓</span>`
      : `<span class="desc-missing" title="No description">–</span>`;
    return `
    <div class="job-item">
      <div class="job-info">
        <div class="job-title">
          ${descBadge}
          <span class="job-title-text" title="${esc(job.title)}">${esc(job.title)}</span>
        </div>
        <div class="job-meta">
          <span class="job-company">${esc(job.company)}</span>
          <span class="job-sep"></span>
          <span class="job-date">${fmt(job.dateAdded)}</span>
        </div>
        ${chips ? `<div class="job-chips">${chips}</div>` : ''}
      </div>
      <button class="job-remove" data-idx="${start + i}" title="Remove">✕</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.job-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobs = await loadJobs();
      jobs.splice(+btn.dataset.idx, 1);
      await saveJobs(jobs);
      render();
    });
  });

  document.getElementById('prevBtn')?.addEventListener('click', () => render(currentPage - 1));
  document.getElementById('nextBtn')?.addEventListener('click', () => render(currentPage + 1));
}

// ── Build XLSX buffer ────────────────────────────────────────────────────────

async function buildXlsxBuffer() {
  const jobs = await loadJobs();
  const rows = jobs.map(j => ({
    'Role':        j.title       || '',
    'Company':     j.company     || '',
    'Location':    j.location    || '',
    'Posted':      j.postedDate  || '',
    'Applicants':  j.applicants  || '',
    'Saved':       j.dateAdded ? new Date(j.dateAdded).toISOString().slice(0, 19).replace('T', ' ') : '',
    'Job Link':    j.url         || '',
    'Description': j.description || '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { header: ['Role', 'Company', 'Location', 'Posted', 'Applicants', 'Saved', 'Job Link', 'Description'] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Jobs');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

// ── Export ───────────────────────────────────────────────────────────────────

async function exportXlsx() {
  const jobs = await loadJobs();
  if (!jobs.length) return;

  const settings  = await loadSettings();
  const filename  = (settings.filename || 'jobs.xlsx').trim() || 'jobs.xlsx';
  const buf       = await buildXlsxBuffer();

  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => URL.revokeObjectURL(url));
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function loadSettingsUI() {
  const settings = await loadSettings();
  document.getElementById('filename').value = settings.filename || 'jobs.xlsx';
}

async function saveSettingsUI() {
  const filename = document.getElementById('filename').value.trim() || 'jobs.xlsx';
  await saveSettings({ filename });
  flashSaved();
}

function flashSaved() {
  const el = document.getElementById('saveOk');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Settings toggle ──────────────────────────────────────────────────────────

function initSettingsToggle() {
  const btn      = document.getElementById('settingsBtn');
  const viewJobs = document.getElementById('view-jobs');
  const viewSett = document.getElementById('view-settings');

  btn.addEventListener('click', () => {
    const open = viewSett.style.display !== 'none';
    viewSett.style.display = open ? 'none' : '';
    viewJobs.style.display = open ? ''     : 'none';
    btn.classList.toggle('active', !open);
  });
}

// ── Track All Visible ────────────────────────────────────────────────────────

function setProgressVisible(on) {
  document.getElementById('progressSection').style.display = on ? '' : 'none';
}

function updateProgress(done, total, skipped, failed) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progressFill').style.width = `${pct}%`;
  const newCount = done - skipped - failed;
  const parts = [`${newCount} tracked`];
  if (skipped) parts.push(`${skipped} already tracked`);
  if (failed)  parts.push(`${failed} failed`);
  document.getElementById('progressText').textContent =
    `${done} / ${total} — ${parts.join(', ')}`;
}

function initTrackAll() {
  const btn     = document.getElementById('trackAllBtn');
  const stopBtn = document.getElementById('stopBtn');
  let activePort = null;

  // Enable button only when on a LinkedIn jobs page
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs[0]?.url || '';
    const onJobsPage = /linkedin\.com\/jobs\/(search|collections)/.test(url);
    btn.disabled = !onJobsPage;
    if (!onJobsPage) btn.title = 'Open a LinkedIn jobs search page first';
  });

  stopBtn.addEventListener('click', () => {
    if (activePort) {
      activePort.postMessage({ action: 'stop' });
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
    }
  });

  btn.addEventListener('click', () => {
    btn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    setProgressVisible(true);
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = 'Starting…';

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const port = chrome.tabs.connect(tabs[0].id, { name: 'ljt-track-all' });
      activePort = port;

      function finish() {
        btn.disabled = false;
        stopBtn.disabled = true;
        activePort = null;
        render();
      }

      port.onMessage.addListener(msg => {
        if (msg.type === 'progress') {
          updateProgress(msg.done, msg.total, msg.skipped, msg.failed);
          render();
        } else if (msg.type === 'done') {
          updateProgress(msg.total, msg.total, msg.skipped, msg.failed);
          document.getElementById('progressText').textContent =
            `Done! ${msg.done} new, ${msg.skipped} already tracked${msg.failed ? `, ${msg.failed} failed` : ''}`;
          finish();
        } else if (msg.type === 'stopped') {
          document.getElementById('progressFill').style.width = '100%';
          document.getElementById('progressText').textContent =
            `Stopped — ${msg.done} new, ${msg.skipped} already tracked${msg.failed ? `, ${msg.failed} failed` : ''}`;
          finish();
        } else if (msg.type === 'error') {
          document.getElementById('progressText').textContent = `Error: ${msg.message}`;
          finish();
        }
      });

      port.onDisconnect.addListener(() => {
        activePort = null;
        btn.disabled = false;
        stopBtn.disabled = true;
      });

      port.postMessage({ action: 'trackAllVisible' });
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initSettingsToggle();
  initTrackAll();
  await render();
  await loadSettingsUI();

  document.getElementById('exportBtn').addEventListener('click', exportXlsx);
  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Remove all tracked jobs?')) return;
    await saveJobs([]);
    render();
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsUI);
});
