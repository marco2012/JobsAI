// ── Resume cache + in-progress generation state ───────────────────────────────
const generatedResumes = new Map();
let resumeGenerations = {}; // { [url]: { status: 'pending'|'error', error?, startedAt } }
let progressMode = null; // 'scoring' | 'tracking' | null
let generatingTimer = null;

function loadGeneratedResumes() {
  return new Promise(r => chrome.storage.local.get(['generatedResumes', 'resumeGenerations'], d => {
    const obj = d.generatedResumes || {};
    Object.entries(obj).forEach(([url, content]) => generatedResumes.set(url, content));
    // Drop stale pending entries (> 3 min — background worker was likely killed)
    const gens = d.resumeGenerations || {};
    const now = Date.now();
    Object.keys(gens).forEach(url => {
      if (gens[url].status === 'pending' && now - (gens[url].startedAt || 0) > 180000) delete gens[url];
    });
    resumeGenerations = gens;
    r();
  }));
}

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
function loadLocalResumeData() {
  return new Promise(r => chrome.storage.local.get(['resumeText', 'resumeFormat', 'resumeFilename'], d => r(d)));
}
function saveLocalResumeData(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r));
}
function saveSyncSettings(obj) {
  return new Promise(r => chrome.storage.sync.set(obj, r));
}

function notify(title, message) {
  chrome.runtime.sendMessage({ action: 'notify', title, message });
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

  const [jobs, sync] = await Promise.all([loadJobs(), loadSyncSettings()]);
  const subtitle  = document.getElementById('subtitle');
  const list      = document.getElementById('jobList');
  const exportBtn = document.getElementById('exportBtn');

  const hasProfile = !!(sync.candidateProfile && sync.candidateProfile.trim());
  subtitle.textContent = `${jobs.length} job${jobs.length !== 1 ? 's' : ''} tracked`;
  exportBtn.disabled   = jobs.length === 0;
  const scoreAllBtn = document.getElementById('scoreAllBtn');
  scoreAllBtn.disabled = jobs.length === 0 || !hasProfile;
  scoreAllBtn.title    = !hasProfile ? 'Upload your resume in Settings first' : '';

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
  const hasAnyScore = jobs.some(j => typeof j.fit_score === 'number');
  if (hasAnyScore) {
    jobs.sort((a, b) => {
      const sa = typeof a.fit_score === 'number' ? a.fit_score : -1;
      const sb = typeof b.fit_score === 'number' ? b.fit_score : -1;
      return sb - sa;
    });
  } else {
    jobs.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
  }

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
    const chips = [];
    const hasDesc = job.description && job.description.trim().length > 30;

    const score = job.fit_score;
    const scoreClass = score == null ? 'score-grey'
      : score >= 75 ? 'score-green'
      : score >= 65 ? 'score-yellow'
      : 'score-red';
    const scoreLabel = score != null ? score : '–';

    const canGen = !!(sync.candidateProfile && hasDesc);
    const hasResume = generatedResumes.has(job.url);
    const genState = resumeGenerations[job.url];
    const isGenerating = genState?.status === 'pending';
    const genError = genState?.status === 'error' ? genState.error : null;

    let genBtnClass = 'job-gen-btn';
    let genBtnContent, genBtnTitle, genBtnDisabled;
    if (isGenerating) {
      genBtnContent = '<span class="spinner"></span>';
      genBtnTitle = 'Generating…';
      genBtnDisabled = true;
    } else if (hasResume) {
      genBtnClass += ' job-gen-btn--ready';
      genBtnContent = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
      genBtnTitle = 'Download tailored resume';
      genBtnDisabled = false;
    } else {
      genBtnContent = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      genBtnTitle = genError ? `Last attempt failed: ${genError}` : canGen ? 'Generate tailored resume' : 'No description available';
      genBtnDisabled = !canGen;
    }
    return `
    <div class="job-item">
      <div class="job-score ${scoreClass}">${scoreLabel}</div>
      <div class="job-info">
        <div class="job-title">
          <a class="job-title-text" href="${esc(job.url)}" target="_blank" title="${esc(job.title)}">${esc(job.title)}</a>
        </div>
        <div class="job-meta">
          <span class="job-company">${esc(job.company)}</span>
          ${job.location ? `<span class="job-sep"></span><span class="job-location">${esc(job.location)}</span>` : ''}
        </div>
        ${isGenerating ? `<p class="job-generating"><span class="spinner"></span><span data-started-at="${genState.startedAt || Date.now()}">Generating…</span></p>` : ''}
        ${genError ? `<p class="job-generating" style="color:var(--destructive)">⚠ ${esc(genError)}</p>` : ''}
      </div>
      <button class="${genBtnClass}" data-url="${esc(job.url)}" title="${esc(genBtnTitle)}" ${genBtnDisabled ? 'disabled' : ''}>${genBtnContent}</button>
      <button class="job-remove" data-idx="${start + i}" title="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
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

  list.querySelectorAll('.job-gen-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const job = pageJobs.find(j => j.url === btn.dataset.url);
      if (!job) return;

      // Already generated — download immediately
      if (generatedResumes.has(job.url)) {
        const local = await loadLocalResumeData();
        downloadResume(generatedResumes.get(job.url), job, local.resumeFormat || 'pdf');
        return;
      }

      // Dispatch generation to background service worker
      const [s, local] = await Promise.all([loadSyncSettings(), loadLocalResumeData()]);
      if (!local.resumeText) {
        btn.title = 'Re-upload your resume in Settings to enable this';
        return;
      }
      const format = local.resumeFormat || 'pdf';
      // Optimistically mark as pending so spinner shows immediately
      resumeGenerations[job.url] = { status: 'pending', startedAt: Date.now() };
      const updatedGens = { ...resumeGenerations };
      chrome.storage.local.set({ resumeGenerations: updatedGens });
      chrome.runtime.sendMessage({
        action: 'generateResume',
        jobUrl: job.url,
        job,
        resumeText: local.resumeText,
        apiKey: s.openrouterKey,
        model: s.selectedModel || 'deepseek/deepseek-v4-flash',
        format,
      });
      await render();
    });
  });

  document.getElementById('prevBtn')?.addEventListener('click', () => render(currentPage - 1));
  document.getElementById('nextBtn')?.addEventListener('click', () => render(currentPage + 1));

  // Tick elapsed-time labels for pending generations without re-rendering
  const hasPending = Object.values(resumeGenerations).some(g => g?.status === 'pending');
  if (hasPending && !generatingTimer) {
    generatingTimer = setInterval(() => {
      const now = Date.now();
      document.querySelectorAll('[data-started-at]').forEach(el => {
        const secs = Math.floor((now - +el.dataset.startedAt) / 1000);
        const m = Math.floor(secs / 60);
        el.textContent = `Generating… ${m > 0 ? `${m}m ` : ''}${secs % 60}s`;
      });
    }, 1000);
  } else if (!hasPending && generatingTimer) {
    clearInterval(generatingTimer);
    generatingTimer = null;
  }
}

// ── Build XLSX buffer ────────────────────────────────────────────────────────

async function buildXlsxBuffer() {
  const jobs = await loadJobs();
  jobs.sort((a, b) => {
    const sa = a.fit_score != null ? a.fit_score : -Infinity;
    const sb = b.fit_score != null ? b.fit_score : -Infinity;
    return sb - sa;
  });
  const rows = jobs.map(j => ({
    'Role':        j.title       || '',
    'Company':     j.company     || '',
    'Location':    j.location    || '',
    'Posted':      j.postedDate  || '',
    'Applicants':  j.applicants  || '',
    'Saved':       j.dateAdded ? new Date(j.dateAdded).toISOString().slice(0, 19).replace('T', ' ') : '',
    'Job Link':    j.url         || '',
    'Description': j.description || '',
    'Fit Score':   j.fit_score != null ? j.fit_score : '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows, { header: ['Role', 'Company', 'Location', 'Posted', 'Applicants', 'Saved', 'Job Link', 'Description', 'Fit Score'] });
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

// ── File text extraction ─────────────────────────────────────────────────────

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

async function extractDocxText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function generateCandidateProfile(resumeText, apiKey, model) {
  console.log('[profile] model:', model, '| resume chars:', resumeText.length);

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
Output ONLY a plain-text summary. Maximum 200 words. No bullet symbols, no markdown. Do not include any labels or headings.

Resume:
${resumeText}`,
      }],
      max_tokens: 1000,
    }),
  });

  console.log('[profile] HTTP status:', response.status);
  if (response.status === 401) throw new Error('Invalid API key (401)');
  if (response.status === 429) throw new Error('Rate limited (429) — try again later');
  if (!response.ok) throw new Error(`OpenRouter error ${response.status}`);

  const data = await response.json();
  const choice = data.choices?.[0];
  console.log('[profile] finish_reason:', choice?.finish_reason, '| response:', JSON.stringify(data).slice(0, 500));

  if (!data.choices?.length) throw new Error('No response from model');
  if (choice.finish_reason === 'length') throw new Error('Model hit token limit — try a smaller model or shorter resume');

  // DeepSeek reasoning models return null content and put the answer in msg.reasoning
  const msg = choice.message;
  let content = msg.content ?? msg.reasoning_content ?? msg.reasoning ?? '';
  if (!content.trim()) throw new Error('Model returned empty content');
  content = content.trim().replace(/^CANDIDATE_PROFILE[:\s]*/i, '');
  return content.trim();
}

function buildDocx(markdown) {
  const x = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Render inline bold (**text**) and italic (*text*) as OOXML runs
  function runs(text, sz) {
    const szTag = `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
    return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/).map((part, i) => {
      if (!part) return '';
      if (part.startsWith('**') && part.endsWith('**')) {
        return `<w:r><w:rPr><w:b/>${szTag}</w:rPr><w:t xml:space="preserve">${x(part.slice(2,-2))}</w:t></w:r>`;
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return `<w:r><w:rPr><w:i/>${szTag}</w:rPr><w:t xml:space="preserve">${x(part.slice(1,-1))}</w:t></w:r>`;
      }
      return `<w:r><w:rPr>${szTag}</w:rPr><w:t xml:space="preserve">${x(part)}</w:t></w:r>`;
    }).join('');
  }

  const paras = markdown.split('\n').map(line => {
    const t = line.trim();

    if (t.startsWith('# ')) {
      // Name / H1 — centered, large bold
      return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="60"/></w:pPr>` +
        `<w:r><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr><w:t>${x(t.slice(2))}</w:t></w:r></w:p>`;
    }
    if (t.startsWith('## ')) {
      // Section heading — bold uppercase with bottom border
      return `<w:p><w:pPr><w:spacing w:before="160" w:after="40"/>` +
        `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="000000"/></w:pBdr></w:pPr>` +
        `<w:r><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>${x(t.slice(3).toUpperCase())}</w:t></w:r></w:p>`;
    }
    if (t.startsWith('### ')) {
      // Job / company line — bold
      return `<w:p><w:pPr><w:spacing w:before="80" w:after="0"/></w:pPr>${runs(t.slice(4), '22')}</w:p>`;
    }
    if (t.startsWith('- ') || t.startsWith('* ')) {
      // Bullet point with hanging indent
      return `<w:p><w:pPr><w:spacing w:after="0"/><w:ind w:left="360" w:hanging="180"/></w:pPr>` +
        `<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">• </w:t></w:r>` +
        runs(t.slice(2), '20') + `</w:p>`;
    }
    if (!t) {
      return `<w:p><w:pPr><w:spacing w:after="0" w:before="0"/></w:pPr></w:p>`;
    }
    // Regular paragraph (contact line, summary, etc.)
    return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${runs(t, '20')}</w:p>`;
  }).join('');

  const ct   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels  = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const doc   = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', ct);
  zip.folder('_rels').file('.rels', rels);
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

async function downloadResume(content, job, format) {
  const san = s => (s || '').replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(0, 40);
  const base = `resume_${san(job.company)}_${san(job.title)}`;
  let blob, filename;
  if (format === 'tex') {
    blob = new Blob([content], { type: 'application/octet-stream' });
    filename = base + '.tex';
  } else {
    blob = await buildDocx(content);
    filename = base + '.docx';
  }
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => URL.revokeObjectURL(url));
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function loadSettingsUI() {
  const [sync, local] = await Promise.all([loadSyncSettings(), loadLocalResumeData()]);
  document.getElementById('openrouterKey').value = sync.openrouterKey || '';
  document.getElementById('modelSelect').value = sync.selectedModel || 'deepseek/deepseek-v4-flash';
  document.getElementById('candidateProfileArea').value = sync.candidateProfile || '';
  if (local.resumeFilename) {
    document.getElementById('fileInputText').textContent = local.resumeFilename;
  }
  document.getElementById('genProfileBtn').disabled = !local.resumeText;
}

async function saveSettingsUI() {
  const openrouterKey = document.getElementById('openrouterKey').value.trim();
  const selectedModel = document.getElementById('modelSelect').value;
  const profile = document.getElementById('candidateProfileArea').value.trim();
  await saveSyncSettings({ openrouterKey, selectedModel, candidateProfile: profile });
  flashSaved();
  render();
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

// ── Theme ─────────────────────────────────────────────────────────────────────

const MOON_SVG = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
const SUN_SVG  = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;

function applyTheme(scheme) {
  document.documentElement.setAttribute('data-theme', scheme);
  const icon = document.getElementById('themeIcon');
  icon.innerHTML = scheme === 'dark' ? SUN_SVG : MOON_SVG;
  document.getElementById('themeBtn').title = scheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

function initTheme() {
  chrome.storage.local.get('colorScheme', ({ colorScheme }) => {
    const scheme = colorScheme ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(scheme);
  });

  document.getElementById('themeBtn').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.local.set({ colorScheme: next });
  });
}

// ── Track All / Score All progress UI ────────────────────────────────────────

function setProgressVisible(on) {
  document.getElementById('progressSection').style.display = on ? '' : 'none';
}

function initStopBtn() {
  document.getElementById('stopBtn').addEventListener('click', () => {
    const stopBtn = document.getElementById('stopBtn');
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
    if (progressMode === 'tracking') chrome.runtime.sendMessage({ action: 'stopTracking' });
    else if (progressMode === 'scoring') chrome.runtime.sendMessage({ action: 'stopScoring' });
  });
}

function applyScoringState(state) {
  const scoreAllBtn  = document.getElementById('scoreAllBtn');
  const stopBtn      = document.getElementById('stopBtn');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  if (state.status === 'running') {
    progressMode = 'scoring';
    setProgressVisible(true);
    scoreAllBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    const pct = state.total > 0 ? ((state.current - 1) / state.total) * 100 : 0;
    progressFill.style.width = `${pct}%`;
    progressText.textContent = state.message;
  } else if (progressMode === 'scoring') {
    progressFill.style.width = '100%';
    progressText.textContent = state.message;
    scoreAllBtn.disabled = false;
    stopBtn.disabled = true;
    progressMode = null;
    render();
    setTimeout(() => setProgressVisible(false), 3000);
  }
}

function applyTrackingState(state) {
  const trackAllBtn  = document.getElementById('trackAllBtn');
  const stopBtn      = document.getElementById('stopBtn');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  if (state.status === 'running') {
    progressMode = 'tracking';
    setProgressVisible(true);
    trackAllBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    if (state.total > 0) {
      const pct = Math.round((state.done / state.total) * 100);
      progressFill.style.width = `${pct}%`;
      const newCount = state.done - (state.skipped || 0) - (state.failed || 0);
      const parts = [`${newCount} tracked`];
      if (state.skipped) parts.push(`${state.skipped} already tracked`);
      if (state.failed)  parts.push(`${state.failed} failed`);
      progressText.textContent = `${state.done} / ${state.total} — ${parts.join(', ')}`;
    } else {
      progressText.textContent = state.message || 'Starting…';
    }
    render();
  } else if (progressMode === 'tracking') {
    progressFill.style.width = '100%';
    progressText.textContent = state.message;
    trackAllBtn.disabled = false;
    stopBtn.disabled = true;
    progressMode = null;
    render();
    setTimeout(() => setProgressVisible(false), 3000);
  }
}

function initTrackAll() {
  const btn = document.getElementById('trackAllBtn');

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const url = tabs[0]?.url || '';
    const onJobsPage = /linkedin\.com\/jobs\/(search|collections)/.test(url);
    btn.disabled = !onJobsPage;
    if (!onJobsPage) btn.title = 'Open a LinkedIn jobs search page first';
  });

  btn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id;
      if (!tabId) return;
      progressMode = 'tracking';
      btn.disabled = true;
      const stopBtn = document.getElementById('stopBtn');
      stopBtn.disabled = false;
      stopBtn.textContent = 'Stop';
      setProgressVisible(true);
      document.getElementById('progressFill').style.width = '0%';
      document.getElementById('progressText').textContent = 'Starting…';
      chrome.runtime.sendMessage({ action: 'trackAll', tabId });
    });
  });
}

function initScoreAll() {
  const scoreAllBtn = document.getElementById('scoreAllBtn');

  scoreAllBtn.addEventListener('click', async () => {
    const sync = await loadSyncSettings();

    if (!sync.candidateProfile?.trim()) {
      setProgressVisible(true);
      document.getElementById('progressText').textContent = 'Please upload your resume in Settings first.';
      setTimeout(() => setProgressVisible(false), 3000);
      return;
    }

    if (!sync.openrouterKey?.trim()) {
      setProgressVisible(true);
      document.getElementById('progressText').textContent = 'Please set your OpenRouter API key in Settings.';
      setTimeout(() => setProgressVisible(false), 3000);
      return;
    }

    progressMode = 'scoring';
    scoreAllBtn.disabled = true;
    const stopBtn = document.getElementById('stopBtn');
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    setProgressVisible(true);
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = 'Starting scoring…';

    chrome.runtime.sendMessage({
      action: 'scoreAll',
      candidateProfile: sync.candidateProfile,
      apiKey: sync.openrouterKey,
      model: sync.selectedModel || 'deepseek/deepseek-v4-flash',
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

  initTheme();
  initSettingsToggle();
  initStopBtn();
  initTrackAll();
  initScoreAll();
  await loadGeneratedResumes();
  await render();
  await loadSettingsUI();

  // Restore in-progress state if background was already running when popup opened
  chrome.storage.local.get(['scoringState', 'trackingState'], ({ scoringState, trackingState }) => {
    if (scoringState?.status === 'running') applyScoringState(scoringState);
    if (trackingState?.status === 'running') applyTrackingState(trackingState);
  });

  // Re-render when background updates state
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.generatedResumes) {
      const obj = changes.generatedResumes.newValue || {};
      Object.entries(obj).forEach(([url, content]) => generatedResumes.set(url, content));
    }
    if (changes.resumeGenerations) {
      resumeGenerations = changes.resumeGenerations.newValue || {};
    }
    if (changes.trackedJobs) render();
    if (changes.scoringState?.newValue) applyScoringState(changes.scoringState.newValue);
    if (changes.trackingState?.newValue) applyTrackingState(changes.trackingState.newValue);
    if (changes.generatedResumes || changes.resumeGenerations) render();
  });

  document.getElementById('resetResumesBtn').addEventListener('click', async () => {
    if (!confirm('Clear all generated resumes? You can regenerate them anytime.')) return;
    await chrome.storage.local.remove('generatedResumes');
    generatedResumes.clear();
    render();
  });

  document.getElementById('exportBtn').addEventListener('click', exportXlsx);
  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Remove all tracked jobs?')) return;
    await saveJobs([]);
    render();
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsUI);

  document.getElementById('genProfileBtn').addEventListener('click', async () => {
    const btn = document.getElementById('genProfileBtn');
    const statusEl = document.getElementById('uploadStatus');
    const spinner = '<span class="spinner"></span>';
    const [sync, local] = await Promise.all([loadSyncSettings(), loadLocalResumeData()]);
    if (!local.resumeText) return;
    if (!sync.openrouterKey) {
      statusEl.textContent = 'Please set your OpenRouter API key first.';
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    btn.disabled = true;
    statusEl.style.color = 'var(--muted-fg)';
    statusEl.innerHTML = `${spinner}Generating candidate profile…`;
    try {
      const profile = await generateCandidateProfile(local.resumeText, sync.openrouterKey, sync.selectedModel || 'deepseek/deepseek-v4-flash');
      document.getElementById('candidateProfileArea').value = profile;
      await saveSyncSettings({ candidateProfile: profile });
      statusEl.innerHTML = '';
      statusEl.textContent = '✓ Profile generated and saved.';
      statusEl.style.color = 'var(--success)';
      btn.disabled = false;
      render();
    } catch (err) {
      statusEl.innerHTML = '';
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = 'var(--destructive)';
      btn.disabled = false;
    }
  });

  document.getElementById('resumeUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('fileInputText').textContent = file.name;
    const statusEl = document.getElementById('uploadStatus');
    const isTex  = file.name.toLowerCase().endsWith('.tex');
    const isPdf  = file.name.toLowerCase().endsWith('.pdf');
    const isDocx = file.name.toLowerCase().endsWith('.docx');
    if (!isTex && !isPdf && !isDocx) {
      statusEl.textContent = 'Please upload a PDF, .tex, or .docx file.';
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    const settings = await loadSyncSettings();
    if (!settings.openrouterKey) {
      statusEl.textContent = 'Please set your OpenRouter API key first.';
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    const spinner = '<span class="spinner"></span>';
    statusEl.style.color = 'var(--muted-fg)';
    const label = isTex ? 'Reading .tex file…' : isDocx ? 'Extracting .docx text…' : 'Extracting PDF text…';
    statusEl.innerHTML = `${spinner}${label}`;
    try {
      let text;
      if (isTex)       text = await file.text();
      else if (isDocx) text = await extractDocxText(file);
      else             text = await extractPdfText(file);
      const format    = isTex ? 'tex' : isDocx ? 'docx' : 'pdf';
      const truncated = text.slice(0, isTex ? 20000 : 4000);
      await saveLocalResumeData({ resumeText: truncated, resumeFormat: format, resumeFilename: file.name });
      statusEl.innerHTML = '';
      statusEl.textContent = `✓ File loaded (${format}). Click Generate Profile to continue.`;
      statusEl.style.color = 'var(--success)';
      document.getElementById('genProfileBtn').disabled = false;
    } catch (err) {
      statusEl.innerHTML = '';
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = 'var(--destructive)';
    }
  });
});
