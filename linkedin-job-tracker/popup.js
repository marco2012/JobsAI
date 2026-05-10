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
function loadSyncSettings() {
  return new Promise(r => chrome.storage.sync.get(['openrouterKey', 'selectedModel', 'candidateProfile'], d => r(d)));
}
function saveSyncSettings(obj) {
  return new Promise(r => chrome.storage.sync.set(obj, r));
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
  document.getElementById('scoreAllBtn').disabled = jobs.length === 0;

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

    let scoreBadge;
    const score = job.fit_score;
    if (score == null || score === undefined) {
      scoreBadge = `<span class="score-badge score-grey">–</span>`;
    } else if (score >= 75) {
      scoreBadge = `<span class="score-badge score-green">${score}</span>`;
    } else if (score >= 50) {
      scoreBadge = `<span class="score-badge score-yellow">${score}</span>`;
    } else {
      scoreBadge = `<span class="score-badge score-red">${score}</span>`;
    }

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
        ${scoreBadge}
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

  const filename  = 'jobs.xlsx';
  const buf       = await buildXlsxBuffer();

  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => URL.revokeObjectURL(url));
}

// ── PDF helpers ──────────────────────────────────────────────────────────────

function extractPdfText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const arrayBuffer = e.target.result;
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pageTexts = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pageTexts.push(content.items.filter(item => item.str.trim()).map(item => item.str).join(' '));
        }
        resolve(pageTexts.join('\n\n'));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

async function generateCandidateProfile(resumeText, apiKey, model) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: `You are a resume parser. From the resume text provided, extract a concise candidate profile:
- Top 10 technical and soft skills
- Total years of professional experience
- Role types the candidate has held (e.g. "Senior Software Engineer", "Product Manager")
- Full tech stack mentioned
Output ONLY a plain-text summary. Maximum 200 words. No bullet symbols, no markdown.
Label it internally as CANDIDATE_PROFILE.

Resume:
${resumeText}`,
      }],
      max_tokens: 300,
    }),
  });

  if (response.status === 401) throw new Error('Invalid API key (401)');
  if (response.status === 429) throw new Error('Rate limited (429) — try again later');
  if (!response.ok) throw new Error(`OpenRouter error ${response.status}`);

  const data = await response.json();
  if (!data.choices?.length) throw new Error('No response from model');
  return data.choices[0].message.content.trim();
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function loadSettingsUI() {
  const sync = await loadSyncSettings();
  document.getElementById('openrouterKey').value = sync.openrouterKey || '';
  document.getElementById('modelSelect').value = sync.selectedModel || 'deepseek/deepseek-r1-0528-qwen3-8b:free';
  document.getElementById('candidateProfileArea').value = sync.candidateProfile || '';
}

async function saveSettingsUI() {
  const openrouterKey = document.getElementById('openrouterKey').value.trim();
  const selectedModel = document.getElementById('modelSelect').value;
  const profile = document.getElementById('candidateProfileArea').value.trim();
  await saveSyncSettings({ openrouterKey, selectedModel, candidateProfile: profile });
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

// ── Score job ────────────────────────────────────────────────────────────────

async function scoreJob(job, candidateProfile, apiKey, model) {
  const prompt = `You are a job-fit evaluator. Score how well this candidate fits this job.

CANDIDATE PROFILE:
${candidateProfile}

JOB DESCRIPTION:
${job.description || 'No description available.'}

Respond with ONLY a single integer between 1 and 100.
Score based on: skills match (40%), experience alignment (30%), role type fit (20%), domain relevance (10%).
No explanation. No punctuation. Just the number.`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
    }),
  });

  if (response.status === 401) throw new Error('Invalid API key (401)');
  if (response.status === 429) throw new Error('Rate limited — try again later');
  if (!response.ok) throw new Error(`OpenRouter error ${response.status}`);

  const data = await response.json();
  if (!data.choices?.length) return null;

  const result = parseInt(data.choices[0].message.content.trim(), 10);
  if (isNaN(result) || result < 1 || result > 100) return null;
  return result;
}

// ── Score All Jobs ────────────────────────────────────────────────────────────

let abortScoring = false;

function initScoreAll() {
  const scoreAllBtn = document.getElementById('scoreAllBtn');
  const stopBtn     = document.getElementById('stopBtn');
  const progressText = document.getElementById('progressText');
  const progressFill = document.getElementById('progressFill');

  stopBtn.addEventListener('click', () => {
    abortScoring = true;
  });

  scoreAllBtn.addEventListener('click', async () => {
    const sync = await loadSyncSettings();

    if (!sync.candidateProfile || !sync.candidateProfile.trim()) {
      setProgressVisible(true);
      progressText.textContent = 'Please upload your resume in Settings first.';
      setTimeout(() => setProgressVisible(false), 3000);
      return;
    }

    if (!sync.openrouterKey || !sync.openrouterKey.trim()) {
      setProgressVisible(true);
      progressText.textContent = 'Please set your OpenRouter API key in Settings.';
      setTimeout(() => setProgressVisible(false), 3000);
      return;
    }

    const apiKey   = sync.openrouterKey;
    const model    = sync.selectedModel || 'deepseek/deepseek-r1-0528-qwen3-8b:free';
    const candidateProfile = sync.candidateProfile;

    const allJobs   = await loadJobs();
    const unscored  = allJobs.filter(j => j.fit_score == null || j.fit_score === undefined);

    if (unscored.length === 0) {
      setProgressVisible(true);
      progressText.textContent = 'All jobs already scored.';
      setTimeout(() => setProgressVisible(false), 3000);
      return;
    }

    abortScoring = false;
    setProgressVisible(true);
    scoreAllBtn.disabled = true;
    progressFill.style.width = '0%';
    progressText.textContent = 'Starting scoring…';

    const total = unscored.length;

    for (let i = 0; i < total; i++) {
      if (abortScoring) break;

      const job = unscored[i];
      progressText.textContent = `Scoring job ${i + 1} of ${total}…`;
      progressFill.style.width = `${(i / total) * 100}%`;

      try {
        const score = await scoreJob(job, candidateProfile, apiKey, model);
        job.fit_score = score;

        // Persist: load fresh, update by URL match, save
        const stored = await loadJobs();
        const idx = stored.findIndex(j => j.url === job.url);
        if (idx !== -1) {
          stored[idx].fit_score = score;
          await saveJobs(stored);
        }
      } catch (err) {
        progressText.textContent = err.message;
        setTimeout(() => setProgressVisible(false), 3000);
        scoreAllBtn.disabled = false;
        render();
        return;
      }

      render();
    }

    progressFill.style.width = '100%';
    progressText.textContent = abortScoring ? 'Scoring stopped.' : 'Scoring complete.';
    setTimeout(() => {
      setProgressVisible(false);
      render();
    }, 3000);
    scoreAllBtn.disabled = false;
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

  initSettingsToggle();
  initTrackAll();
  initScoreAll();
  await render();
  await loadSettingsUI();

  document.getElementById('exportBtn').addEventListener('click', exportXlsx);
  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Remove all tracked jobs?')) return;
    await saveJobs([]);
    render();
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsUI);

  document.getElementById('resumeUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('uploadStatus');
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      statusEl.textContent = 'Please upload a PDF file.';
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    const settings = await loadSyncSettings();
    if (!settings.openrouterKey) {
      statusEl.textContent = 'Please set your OpenRouter API key first.';
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    statusEl.style.color = 'var(--muted-fg)';
    statusEl.textContent = 'Extracting PDF text…';
    try {
      const text = await extractPdfText(file);
      statusEl.textContent = 'Generating candidate profile…';
      const profile = await generateCandidateProfile(text, settings.openrouterKey, settings.selectedModel || 'deepseek/deepseek-r1-0528-qwen3-8b:free');
      document.getElementById('candidateProfileArea').value = profile;
      await saveSyncSettings({ candidateProfile: profile });
      statusEl.textContent = '✓ Profile generated and saved.';
      statusEl.style.color = 'var(--success)';
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = 'var(--destructive)';
    }
  });
});
