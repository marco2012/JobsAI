const BTN_CLASS = 'ljt-track-btn';

// --- Panels ---

function getDetailPanel() {
  // Search/collections pages: lazy-column[1] = job detail
  const cols = document.querySelectorAll('[data-testid="lazy-column"]');
  if (cols[1]) return cols[1];
  // Recommended/single-pane pages
  return document.querySelector('.jobs-details__main-content') || null;
}

// --- Job ID ---

function getJobIdFromUrl() {
  return new URLSearchParams(location.search).get('currentJobId') || null;
}

// --- Job info from detail panel ---

function getJobTitle(panel) {
  // Try h1 in the detail panel first
  const h1 = panel?.querySelector('h1');
  if (h1?.innerText?.trim()) return h1.innerText.trim();
  // Fallback: parse "Title | Company | LinkedIn" from document.title
  const parts = document.title.split(' | ');
  if (parts.length >= 2) return parts[0].trim();
  return 'Unknown Title';
}

function getCompany(panel) {
  // Search page: componentkey attribute; recommended page: class-based link
  const link = panel?.querySelector('a[componentkey*="auto-binding"]')
    || panel?.querySelector('.job-details-jobs-unified-top-card__company-name a');
  if (link?.innerText?.trim()) return link.innerText.trim();
  // Fallback: second segment of "Title | Company | LinkedIn"
  const parts = document.title.split(' | ');
  if (parts.length >= 2) return parts[1].trim();
  return 'Unknown Company';
}

function getMetaSpans(panel) {
  // Search page uses span.e0d2ec4d; recommended page uses span.tvm__text--low-emphasis
  const spans = Array.from(panel?.querySelectorAll('span.e0d2ec4d') || [])
    .map(s => s.innerText?.trim()).filter(Boolean);
  if (spans.length) return spans;
  return Array.from(panel?.querySelectorAll('span.tvm__text--low-emphasis') || [])
    .map(s => s.innerText?.trim()).filter(Boolean);
}

function getLocation(panel) {
  return getMetaSpans(panel).find(t =>
    !t.match(/\d+\s*(day|hour|week|month)s?\s*ago|reposted|just now|applicant|clicked apply/i)
  ) || '';
}

function parseRelativeDate(text) {
  if (!text) return '';
  // Strip "Reposted" prefix if present
  const t = text.replace(/^reposted\s*/i, '').trim().toLowerCase();
  const now = new Date();

  if (t.match(/just now|moments?\s*ago/)) {
    // same day
  } else {
    const hourM  = t.match(/(\d+)\s*hours?\s*ago/);
    const dayM   = t.match(/(\d+)\s*days?\s*ago/);
    const weekM  = t.match(/(\d+)\s*weeks?\s*ago/);
    const monthM = t.match(/(\d+)\s*months?\s*ago/);

    if (hourM)  now.setHours(now.getHours()   - parseInt(hourM[1]));
    else if (dayM)   now.setDate(now.getDate()   - parseInt(dayM[1]));
    else if (weekM)  now.setDate(now.getDate()   - parseInt(weekM[1]) * 7);
    else if (monthM) now.setMonth(now.getMonth() - parseInt(monthM[1]));
    else return text; // unrecognised format — keep original string
  }

  // Format as YYYY-MM-DD
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getPostedDate(panel) {
  const raw = getMetaSpans(panel).find(t =>
    t.match(/\d+\s*(day|hour|week|month)s?\s*ago|reposted|just now/i)
  ) || '';
  return parseRelativeDate(raw);
}

function getApplicants(panel) {
  const raw = getMetaSpans(panel).find(t =>
    t.match(/applicant|clicked apply|people applied/i)
  ) || '';
  if (!raw) return '';
  // Extract leading number and append "applicants"
  const m = raw.match(/(\d[\d,]*)/);
  return m ? `${m[1]} applicants` : raw;
}

function getDescription(panel) {
  // Search page: componentkey attribute; recommended page: #job-details or .jobs-description
  const section = panel?.querySelector('[componentkey*="AboutTheJob"]')
    || panel?.querySelector('#job-details')
    || panel?.querySelector('.jobs-description');
  if (!section) return '';
  let text = section.innerText?.trim() || '';
  text = text.replace(/^About the job\s*/i, '');
  text = text.replace(/[…]{1,3}\s*more\b/gi, '').trim();
  return text;
}

function getJobUrl(jobId) {
  return `https://www.linkedin.com/jobs/view/${jobId}/`;
}

// --- Injection point ---

function findSaveButton(panel) {
  if (!panel) return null;
  // Search page: explicit aria-label
  const byLabel = panel.querySelector('button[aria-label="Save the job"], button[aria-label="Unsave the job"]');
  if (byLabel) return byLabel;
  // Recommended page: no aria-label, identified by text
  return Array.from(panel.querySelectorAll('button')).find(b =>
    b.innerText?.trimStart().startsWith('Save')
  ) || null;
}

// --- Storage ---

function storageAvailable() {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local;
}

function loadJobs() {
  if (!storageAvailable()) return Promise.resolve([]);
  return new Promise(r => chrome.storage.local.get('trackedJobs', d => r(d.trackedJobs || [])));
}
function saveJobs(jobs) {
  if (!storageAvailable()) return Promise.resolve();
  return new Promise(r => chrome.storage.local.set({ trackedJobs: jobs }, r));
}
async function isTracked(jobId) {
  return (await loadJobs()).some(j => j.id === jobId);
}
async function toggleJob(jobId, title, company, url, description, location, postedDate, applicants) {
  const jobs = await loadJobs();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) {
    jobs.push({ id: jobId, title, company, url, description, location, postedDate, applicants, dateAdded: new Date().toISOString() });
    await saveJobs(jobs);
    return true;
  }
  jobs.splice(idx, 1);
  await saveJobs(jobs);
  return false;
}

// --- Button ---

function applyState(btn, tracked) {
  btn.textContent = tracked ? '✓ Tracked' : '+ Track';
  btn.dataset.tracked = String(tracked);
  btn.classList.toggle('tracked', tracked);
  btn.title = tracked ? 'Click to remove' : 'Track this job';
}

async function addTrackButton(panel, jobId) {
  if (panel.querySelector(`.${BTN_CLASS}`)) return;

  // On search page the Save button is found by aria-label and sits inside a wrapper div;
  // we insert after the wrapper so Track lands in the flex row, not inside the wrapper.
  // On the recommended page the Save button is a direct flex child, so insert after it directly.
  const byLabel = panel.querySelector('button[aria-label="Save the job"], button[aria-label="Unsave the job"]');
  const saveBtn = byLabel || Array.from(panel.querySelectorAll('button')).find(b =>
    b.innerText?.trimStart().startsWith('Save')
  );
  if (!saveBtn) return;

  const insertAnchor = byLabel ? (saveBtn.parentElement || saveBtn) : saveBtn;

  const tracked = await isTracked(jobId);
  const btn = document.createElement('button');
  btn.className = BTN_CLASS;
  applyState(btn, tracked);

  btn.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    const now = await toggleJob(
      jobId,
      getJobTitle(panel), getCompany(panel), getJobUrl(jobId), getDescription(panel),
      getLocation(panel), getPostedDate(panel), getApplicants(panel)
    );
    applyState(btn, now);
    btn.disabled = false;
  });

  const wrap = document.createElement('div');
  wrap.className = 'ljt-btn-wrap';
  wrap.dataset.jobId = jobId;
  wrap.appendChild(btn);
  insertAnchor.insertAdjacentElement('afterend', wrap);
}

// --- Main scan ---

function processPage() {
  const jobId = getJobIdFromUrl();
  if (!jobId) return;

  const panel = getDetailPanel();
  if (!panel) return;

  // If the button already exists for this job, do nothing
  const existing = panel.querySelector('.ljt-btn-wrap');
  if (existing?.dataset.jobId === jobId) return;

  // Remove stale button from a previous job
  existing?.remove();

  if (!findSaveButton(panel)) return; // detail panel still loading

  addTrackButton(panel, jobId);
}

// --- Init ---

processPage();

// Re-scan on DOM mutations (detail panel loads asynchronously)
let debounce;
const observer = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(processPage, 400);
});
observer.observe(document.body, { childList: true, subtree: true });

// Re-scan on SPA navigation (job selection changes URL)
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // Give LinkedIn time to swap in the new detail panel content
    setTimeout(processPage, 900);
  }
}).observe(document, { subtree: true, childList: true });
