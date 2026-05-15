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
  return new Promise(r => chrome.storage.sync.get(['openrouterKey', 'geminiKey', 'selectedModel', 'scoringModel', 'candidateProfile'], d => r(d)));
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

let searchQuery = '';

async function render() {
  const [jobs, sync] = await Promise.all([loadJobs(), loadSyncSettings()]);
  const subtitle  = document.getElementById('subtitle');
  const list      = document.getElementById('jobList');
  const exportBtn = document.getElementById('exportBtn');

  const hasProfile = !!(sync.candidateProfile && sync.candidateProfile.trim());
  exportBtn.disabled   = jobs.length === 0;
  const scoreAllBtn = document.getElementById('scoreAllBtn');
  scoreAllBtn.disabled = jobs.length === 0 || !hasProfile;
  scoreAllBtn.title    = !hasProfile ? 'Upload your resume in Settings first' : '';

  if (jobs.length === 0) {
    subtitle.textContent = '0 jobs tracked';
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No jobs tracked yet</div>
        <div class="empty-desc">Browse LinkedIn jobs and click <strong>+ Track</strong> in the job detail panel.</div>
      </div>`;
    return;
  }

  // Sort: by score if any scored, otherwise newest first
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

  // Filter by search query
  const q = searchQuery.toLowerCase();
  const pageJobs = q
    ? jobs.filter(j => [j.title, j.company, j.location].some(s => (s || '').toLowerCase().includes(q)))
    : jobs;

  if (q) {
    subtitle.textContent = `${pageJobs.length} of ${jobs.length} job${jobs.length !== 1 ? 's' : ''}`;
  } else {
    subtitle.textContent = `${jobs.length} job${jobs.length !== 1 ? 's' : ''} tracked`;
  }

  if (pageJobs.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-title">No jobs match "${esc(searchQuery)}"</div>
      </div>`;
    return;
  }

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
      genBtnClass += ' job-gen-btn--stop';
      genBtnContent = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      genBtnTitle = 'Stop generation';
      genBtnDisabled = false;
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
      <button class="job-remove" data-url="${esc(job.url)}" title="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>`;
  }).join('');

  list.querySelectorAll('.job-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const all = await loadJobs();
      const idx = all.findIndex(j => j.url === btn.dataset.url);
      if (idx !== -1) all.splice(idx, 1);
      await saveJobs(all);
      render();
    });
  });

  list.querySelectorAll('.job-gen-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const job = pageJobs.find(j => j.url === btn.dataset.url);
      if (!job) return;

      // Currently generating — stop it
      if (resumeGenerations[job.url]?.status === 'pending') {
        chrome.runtime.sendMessage({ action: 'stopGeneration', jobUrl: job.url });
        delete resumeGenerations[job.url];
        chrome.storage.local.set({ resumeGenerations: { ...resumeGenerations } });
        await render();
        return;
      }

      // Already generated — download immediately
      if (generatedResumes.has(job.url)) {
        const local = await loadLocalResumeData();
        downloadResume(generatedResumes.get(job.url), job, local.resumeFormat || 'pdf');
        return;
      }

      // Dispatch generation to background service worker
      const local = await loadLocalResumeData();
      if (!local.resumeText) {
        btn.title = 'Re-upload your resume in Settings to enable this';
        return;
      }
      const live = getLiveSettings();
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
        apiKey: live.openrouterKey,
        geminiKey: live.geminiKey,
        model: live.selectedModel || 'gemini-2.5-flash',
        format,
      });
      await render();
    });
  });

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

function resolveApi(model, openrouterKey, geminiKey) {
  const isGemini = !model.includes('/');
  return {
    url: isGemini
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions',
    key: isGemini ? geminiKey : openrouterKey,
    provider: isGemini ? 'Google AI Studio' : 'OpenRouter',
  };
}

async function generateCandidateProfile(resumeText, openrouterKey, geminiKey, model) {
  console.log('[profile] model:', model, '| resume chars:', resumeText.length);

  const { url, key, provider } = resolveApi(model, openrouterKey, geminiKey);
  if (!key) throw new Error(`${provider} API key is not set`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: `You are a senior technical recruiter building a candidate brief used for job-fit scoring.

Extract the following from the resume and write them as flowing plain text:

1. Seniority and experience: total years of work experience and current level (e.g. "8 years, senior individual contributor with team-lead experience")
2. Primary roles: job titles held, most recent first
3. Technical skills: top 12 tools, languages, platforms, and frameworks — include years of use and context where evident (e.g. "Python 6 yrs used for production ML pipelines", "Salesforce CRM 4 yrs enterprise deployments")
4. Domains and industries: sectors, verticals, and problem spaces worked in (e.g. "enterprise SaaS, fintech, data infrastructure, professional services")
5. Top 3 achievements: concrete and quantified — include numbers, percentages, revenue, scale, or time saved
6. Education and certifications: degrees, institutions, and any notable certifications

Rules:
- Be specific: use tool names, numbers, and context — vague statements like "strong communicator" are useless
- Plain text only — no markdown, no bullet points, no section headers, no labels
- 220–280 words

Resume:
${resumeText}`,
      }],
      max_tokens: 1200,
    }),
  });

  console.log('[profile] HTTP status:', response.status);
  if (response.status === 401) throw new Error('Invalid API key (401)');
  if (response.status === 429) throw new Error('Rate limited (429) — try again later');
  if (!response.ok) throw new Error(`${provider} error ${response.status}`);

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
    return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]*\]\([^)]*\))/).map(part => {
      if (!part) return '';
      if (part.startsWith('**') && part.endsWith('**')) {
        return `<w:r><w:rPr><w:b/>${szTag}</w:rPr><w:t xml:space="preserve">${x(part.slice(2,-2))}</w:t></w:r>`;
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return `<w:r><w:rPr><w:i/>${szTag}</w:rPr><w:t xml:space="preserve">${x(part.slice(1,-1))}</w:t></w:r>`;
      }
      const linkM = part.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
      if (linkM) {
        // Render markdown link as the raw URL (no markdown syntax in docx)
        return `<w:r><w:rPr>${szTag}</w:rPr><w:t xml:space="preserve">${x(linkM[2])}</w:t></w:r>`;
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

function switchProviderTab(provider) {
  document.querySelectorAll('.provider-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === provider);
  });
  document.getElementById('panelGemini').style.display    = provider === 'gemini'      ? '' : 'none';
  document.getElementById('panelOpenRouter').style.display = provider === 'openrouter' ? '' : 'none';
}

function getScoringModel() {
  const active = document.querySelector('.provider-tab.active')?.dataset.tab;
  return active === 'openrouter'
    ? document.getElementById('scoringModelSelectOR').value
    : document.getElementById('scoringModelSelectGemini').value;
}

function persistModels() {
  chrome.storage.sync.set({ selectedModel: getSelectedModel(), scoringModel: getScoringModel() });
}

function initProviderTabs() {
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchProviderTab(tab.dataset.tab);
      persistModels();
    });
  });
  document.getElementById('modelSelectGemini').addEventListener('change', persistModels);
  document.getElementById('modelSelectOR').addEventListener('change', persistModels);
  document.getElementById('scoringModelSelectGemini').addEventListener('change', persistModels);
  document.getElementById('scoringModelSelectOR').addEventListener('change', persistModels);
  document.getElementById('geminiKey').addEventListener('blur', () =>
    chrome.storage.sync.set({ geminiKey: document.getElementById('geminiKey').value.trim() }));
  document.getElementById('openrouterKey').addEventListener('blur', () =>
    chrome.storage.sync.set({ openrouterKey: document.getElementById('openrouterKey').value.trim() }));
}

function getSelectedModel() {
  const active = document.querySelector('.provider-tab.active')?.dataset.tab;
  return active === 'openrouter'
    ? document.getElementById('modelSelectOR').value
    : document.getElementById('modelSelectGemini').value;
}

// Read current keys + model directly from DOM (no storage round-trip needed)
function getLiveSettings() {
  return {
    selectedModel:   getSelectedModel(),
    openrouterKey:   document.getElementById('openrouterKey')?.value.trim()        || '',
    geminiKey:       document.getElementById('geminiKey')?.value.trim()             || '',
    candidateProfile: document.getElementById('candidateProfileArea')?.value.trim() || '',
  };
}

async function loadSettingsUI() {
  const [sync, local] = await Promise.all([loadSyncSettings(), loadLocalResumeData()]);
  document.getElementById('openrouterKey').value = sync.openrouterKey || '';
  document.getElementById('geminiKey').value = sync.geminiKey || '';

  const model = sync.selectedModel || 'gemini-2.5-flash';
  const isGemini = !model.includes('/');
  switchProviderTab(isGemini ? 'gemini' : 'openrouter');
  if (isGemini) {
    document.getElementById('modelSelectGemini').value = model;
    const sm = sync.scoringModel && !sync.scoringModel.includes('/') ? sync.scoringModel : model;
    document.getElementById('scoringModelSelectGemini').value = sm;
  } else {
    document.getElementById('modelSelectOR').value = model;
    const sm = sync.scoringModel && sync.scoringModel.includes('/') ? sync.scoringModel : model;
    document.getElementById('scoringModelSelectOR').value = sm;
  }

  document.getElementById('candidateProfileArea').value = sync.candidateProfile || '';
  if (local.resumeFilename) {
    document.getElementById('fileInputText').textContent = local.resumeFilename;
  }
  document.getElementById('genProfileBtn').disabled = !local.resumeText;
}

async function saveSettingsUI() {
  const openrouterKey = document.getElementById('openrouterKey').value.trim();
  const geminiKey = document.getElementById('geminiKey').value.trim();
  const selectedModel = getSelectedModel();
  const scoringModel = getScoringModel();
  const profile = document.getElementById('candidateProfileArea').value.trim();
  await saveSyncSettings({ openrouterKey, geminiKey, selectedModel, scoringModel, candidateProfile: profile });
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

  // lastFocusedWindow is required in popup context — currentWindow resolves to the
  // popup's own window which has no tabs, leaving the button permanently disabled.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
    const url = tabs[0]?.url || '';
    const onJobsPage = /linkedin\.com\/jobs\//.test(url) || /linkedin\.com\/jobs-tracker/.test(url);
    btn.disabled = !onJobsPage;
    if (!onJobsPage) btn.title = 'Open a LinkedIn jobs or saved-jobs page first';
  });

  btn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
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
    const live = getLiveSettings();
    // candidateProfile lives in storage; fall back if the textarea is empty (settings not opened yet)
    const sync = await loadSyncSettings();
    const candidateProfile = live.candidateProfile || sync.candidateProfile || '';

    if (!candidateProfile.trim()) {
      setProgressVisible(true);
      document.getElementById('progressText').textContent = 'Please upload your resume in Settings first.';
      setTimeout(() => setProgressVisible(false), 3000);
      return;
    }

    const scoreModel = getScoringModel() || live.selectedModel || 'gemini-2.5-flash';
    const { key: scoreKey, provider: scoreProvider } = resolveApi(scoreModel, live.openrouterKey, live.geminiKey);
    if (!scoreKey?.trim()) {
      setProgressVisible(true);
      document.getElementById('progressText').textContent = `Please set your ${scoreProvider} API key in Settings.`;
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
      candidateProfile,
      apiKey:     live.openrouterKey,
      geminiKey:  live.geminiKey,
      model:      scoreModel,
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

  initTheme();
  initSettingsToggle();
  initProviderTabs();
  initStopBtn();
  initTrackAll();
  initScoreAll();
  await loadGeneratedResumes();
  await render();
  await loadSettingsUI();

  // Restore in-progress state only if the background SW is provably still running.
  // A ping with no reply means the SW was killed — reset stale 'running' state so
  // the Track All button isn't left permanently disabled.
  chrome.storage.local.get(['scoringState', 'trackingState'], ({ scoringState, trackingState }) => {
    let replied = false;
    chrome.runtime.sendMessage({ action: 'ping' }, () => {
      replied = true;
      if (scoringState?.status  === 'running') applyScoringState(scoringState);
      if (trackingState?.status === 'running') applyTrackingState(trackingState);
    });
    // If no reply within 400 ms the SW is dead — clear stale running states
    setTimeout(() => {
      if (replied) return;
      if (scoringState?.status  === 'running') chrome.storage.local.set({ scoringState:  { status: 'idle', message: '' } });
      if (trackingState?.status === 'running') chrome.storage.local.set({ trackingState: { status: 'idle', message: '' } });
    }, 400);
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

  document.getElementById('searchInput').addEventListener('input', e => {
    searchQuery = e.target.value;
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
    const [live, local] = await Promise.all([Promise.resolve(getLiveSettings()), loadLocalResumeData()]);
    if (!local.resumeText) return;
    const selModel = live.selectedModel || 'gemini-2.5-flash';
    const { key: activeKey, provider } = resolveApi(selModel, live.openrouterKey, live.geminiKey);
    if (!activeKey) {
      statusEl.textContent = `Please set your ${provider} API key first.`;
      statusEl.style.color = 'var(--destructive)';
      return;
    }
    btn.disabled = true;
    statusEl.style.color = 'var(--muted-fg)';
    statusEl.innerHTML = `${spinner}Generating candidate profile…`;
    try {
      const profile = await generateCandidateProfile(local.resumeText, live.openrouterKey, live.geminiKey, selModel);
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
    const liveUp = getLiveSettings();
    const _selModel = liveUp.selectedModel || 'gemini-2.5-flash';
    const { key: _activeKey, provider: _provider } = resolveApi(_selModel, liveUp.openrouterKey, liveUp.geminiKey);
    if (!_activeKey) {
      statusEl.textContent = `Please set your ${_provider} API key first.`;
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
