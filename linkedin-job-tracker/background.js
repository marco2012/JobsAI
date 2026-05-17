// MV3 service worker

let scoringAbort = false;
let trackingPort = null;
const activeGenerations = new Map(); // jobUrl → AbortController

// Clear any 'running' state left over from a previous SW instance that was killed
// mid-operation. Runs every time the SW starts (restarts lose all in-memory state).
chrome.storage.local.get(['scoringState', 'trackingState'], ({ scoringState, trackingState }) => {
  const updates = {};
  if (scoringState?.status  === 'running') updates.scoringState  = { status: 'idle', message: 'Interrupted — extension restarted' };
  if (trackingState?.status === 'running') updates.trackingState = { status: 'idle', message: '' };
  if (Object.keys(updates).length) chrome.storage.local.set(updates);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('trackedJobs', ({ trackedJobs }) => {
    if (!trackedJobs) chrome.storage.local.set({ trackedJobs: [] });
  });
});

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') {
    sendResponse({ alive: true });
  }
  if (msg.action === 'generateResume') {
    handleGenerate(msg).catch(console.error);
    sendResponse({ queued: true });
  }
  if (msg.action === 'stopGeneration') {
    activeGenerations.get(msg.jobUrl)?.abort();
    sendResponse({});
  }
  if (msg.action === 'scoreAll') {
    handleScoreAll(msg).catch(console.error);
    sendResponse({ queued: true });
  }
  if (msg.action === 'stopScoring') {
    scoringAbort = true;
    sendResponse({});
  }
  if (msg.action === 'trackAll') {
    handleTrackAll(msg).catch(console.error);
    sendResponse({ queued: true });
  }
  if (msg.action === 'stopTracking') {
    if (trackingPort) trackingPort.postMessage({ action: 'stop' });
    sendResponse({});
  }
  if (msg.action === 'notify') {
    notify(msg.title, msg.message);
    sendResponse({});
  }
  return false;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}

function loadJobs() {
  return new Promise(r => chrome.storage.local.get('trackedJobs', d => r(d.trackedJobs || [])));
}
function saveJobs(jobs) {
  return new Promise(r => chrome.storage.local.set({ trackedJobs: jobs }, r));
}

// ── API routing ───────────────────────────────────────────────────────────────

function resolveApiKey(model, apiKey, geminiKey) {
  return model.includes('/')
    ? { url: 'https://openrouter.ai/api/v1/chat/completions', key: apiKey }
    : { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: geminiKey };
}

// ── Resume generation (survives popup close) ──────────────────────────────────

async function handleGenerate({ jobUrl, job, resumeText, apiKey, geminiKey, model, format, customPrompt }) {
  const controller = new AbortController();
  activeGenerations.set(jobUrl, controller);

  try {
    const content = await fetchResume(job, resumeText, apiKey, geminiKey, model, format, controller.signal, customPrompt);
    const { generatedResumes = {}, resumeGenerations = {} } =
      await chrome.storage.local.get(['generatedResumes', 'resumeGenerations']);
    generatedResumes[jobUrl] = content;
    delete resumeGenerations[jobUrl];
    await chrome.storage.local.set({ generatedResumes, resumeGenerations });
    notify('Resume ready', `${job.title} @ ${job.company} — click the download icon`);
  } catch (err) {
    if (err.name === 'AbortError') {
      // User cancelled — clear pending state silently
      const { resumeGenerations = {} } = await chrome.storage.local.get('resumeGenerations');
      delete resumeGenerations[jobUrl];
      await chrome.storage.local.set({ resumeGenerations });
      return;
    }
    const message = err.name === 'TimeoutError'
      ? 'Timed out after 5 min — try a faster model'
      : err.message;
    console.error(`[resume] Failed: ${message}`);
    const { resumeGenerations = {} } = await chrome.storage.local.get('resumeGenerations');
    resumeGenerations[jobUrl] = { status: 'error', error: message };
    await chrome.storage.local.set({ resumeGenerations });
    notify('Resume generation failed', message);
  } finally {
    activeGenerations.delete(jobUrl);
  }
}

async function fetchResume(job, resumeText, apiKey, geminiKey, model, format, userSignal, customPrompt) {
  // Combine user-cancel signal with a native timeout (setTimeout is unreliable in SW)
  const signal = AbortSignal.any([userSignal, AbortSignal.timeout(300_000)]);
  const isTex = format === 'tex';
  const formatRules = isTex
    ? `- Preserve ALL LaTeX commands, packages, document class, and preamble exactly as-is
- Never escape # inside \\newcommand definitions — #1, #2, #3 are argument placeholders, not literal text
- Keep the same \\begin{document} ... \\end{document} structure
- Output ONLY the complete .tex file. Start with the document class line (e.g. \\documentclass[...])`
    : `- Output the resume in Markdown format so it can be rendered as a formatted Word document:
  - # Candidate Name (H1, one line)
  - Contact info as a plain line (email | phone | LinkedIn)
  - ## SECTION HEADINGS (H2) for Experience, Education, Skills, etc.
  - ### Company | Role | Dates (H3) for each position
  - - Bullet points for achievements (XYZ formula, metrics required)
  - **bold** for company names, key metrics, and technologies
  - Start directly with # Name`;

  const instructions = customPrompt || `You are a professional resume writer${isTex ? ' specializing in LaTeX' : ''}. Tailor this resume to the job description using the XYZ formula.

Rules:
- XYZ formula: "Accomplished [X] as measured by [Y] by doing [Z]"
- Replace weak verbs (helped, assisted, worked on, responsible for) with power verbs (architected, drove, scaled, engineered, launched, owned, spearheaded)
- Every bullet must have a quantifiable metric (%, $, scale, time saved, users impacted)
- Reorder bullets to highlight skills matching THIS job first
- Naturally incorporate the job's keywords into bullet descriptions
- Cut anything not relevant to this specific role
- After drafting, review and add any key job requirements that are missing
- STRICT LENGTH LIMIT: the resume must fit in 1.5 pages maximum — approximately 500 words total. Cut aggressively. Max 4 bullets per role. Omit old or irrelevant roles entirely.`;

  const { url, key } = resolveApiKey(model, apiKey, geminiKey);
  console.log(`[resume] Generating for model=${model} format=${format}`);
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: `${instructions}
${formatRules}

ORIGINAL RESUME:
${resumeText}

JOB DESCRIPTION:
${job.description || ''}`,
      }],
      max_tokens: isTex ? 16000 : 4000,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try { const e = await response.json(); detail = e.error?.message || JSON.stringify(e); } catch {}
    const msg = response.status === 401 ? 'Invalid API key (401)'
      : response.status === 429 ? 'Rate limited — try again later'
      : `API error ${response.status}${detail ? ': ' + detail : ''}`;
    console.error(`[resume] ${msg}`);
    throw new Error(msg);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  if (!data.choices?.length) throw new Error('No response from model');
  if (choice.finish_reason === 'length') {
    throw new Error('Output was cut off — the model hit its token limit. Try a model with higher output capacity.');
  }
  const msg = choice.message;
  const content = msg.content ?? msg.reasoning_content ?? msg.reasoning ?? '';
  if (!content.trim()) throw new Error('Model returned empty content');
  console.log(`[resume] Done — ${content.trim().length} chars, finish_reason=${choice.finish_reason}`);
  return content.trim();
}

// ── Score All (survives popup close) ─────────────────────────────────────────

async function handleScoreAll({ candidateProfile, apiKey, geminiKey, model }) {
  scoringAbort = false;
  const jobs = await loadJobs();
  const unscored = jobs.filter(j => typeof j.fit_score !== 'number');
  const total = unscored.length;

  if (total === 0) {
    await chrome.storage.local.set({ scoringState: { status: 'idle', message: 'All jobs already scored.' } });
    return;
  }

  await chrome.storage.local.set({
    scoringState: { status: 'running', current: 0, total, failed: 0, message: 'Starting scoring…' },
  });

  let failed = 0;
  let lastError = '';
  for (let i = 0; i < total; i++) {
    if (scoringAbort) break;
    const job = unscored[i];
    await chrome.storage.local.set({
      scoringState: { status: 'running', current: i + 1, total, failed, message: `Scoring ${i + 1} / ${total}…` },
    });

    try {
      const score = await scoreJob(job, candidateProfile, apiKey, geminiKey, model);
      if (typeof score === 'number') {
        const stored = await loadJobs();
        const idx = stored.findIndex(j => j.url === job.url);
        if (idx !== -1) {
          stored[idx].fit_score = score;
          await saveJobs(stored);
        }
      }
    } catch (err) {
      lastError = err.message;
      // Stop immediately on auth or rate-limit errors — retrying won't help
      if (err.message.includes('401') || err.message.includes('429')) {
        await chrome.storage.local.set({
          scoringState: { status: 'idle', current: i + 1, total, failed, message: `Stopped: ${err.message}` },
        });
        return;
      }
      console.error(`[score] job "${job.title}" @ "${job.company}" failed:`, err.message);
      failed++;
    }
  }

  const aborted = scoringAbort;
  const baseMsg = aborted ? 'Scoring stopped.' : 'Scoring complete.';
  const failNote = failed > 0 ? ` ${failed} job(s) failed — last error: ${lastError}` : '';
  const finalMsg = `${baseMsg}${failNote}`;
  await chrome.storage.local.set({
    scoringState: { status: 'idle', current: total, total, failed, message: finalMsg, aborted },
  });
  if (!aborted) notify('Scoring complete', failed > 0 ? `${failed} failed — ${lastError}` : 'All jobs scored');
}

async function scoreJob(job, candidateProfile, apiKey, geminiKey, model) {
  const prompt = `You are a job-fit evaluator. Score how well this candidate fits this job.

CANDIDATE PROFILE:
${candidateProfile}

JOB DESCRIPTION:
${job.description || 'No description available.'}

Respond with ONLY a single integer between 1 and 100.
Score based on: skills match (40%), experience alignment (30%), role type fit (20%), domain relevance (10%).
No explanation. No punctuation. Just the number.`;

  const { url, key } = resolveApiKey(model, apiKey, geminiKey);
  console.log(`[score] model=${model} url=${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try { const e = await response.json(); detail = e.error?.message || JSON.stringify(e); } catch {}
    const msg = `API error ${response.status}${detail ? ': ' + detail : ''}`;
    console.error(`[score] ${msg}`);
    throw new Error(msg);
  }

  const data = await response.json();
  if (!data.choices?.length) return null;
  const msg = data.choices[0].message;
  const text = (msg.content ?? msg.reasoning_content ?? msg.reasoning ?? '').trim();
  const result = parseInt(text, 10);
  if (isNaN(result) || result < 1 || result > 100) return null;
  return result;
}

// ── Track All (survives popup close) ─────────────────────────────────────────

async function handleTrackAll({ tabId }) {
  try {
    trackingPort = chrome.tabs.connect(tabId, { name: 'ljt-track-all' });
  } catch (err) {
    await chrome.storage.local.set({ trackingState: { status: 'idle', message: `Error: ${err.message}` } });
    return;
  }

  // Attach listeners inside try/catch — port properties throw if the content
  // script context was invalidated (e.g. extension just reloaded without a tab refresh).
  try {
    trackingPort.onMessage.addListener(async msg => {
      if (msg.type === 'progress') {
        await chrome.storage.local.set({
          trackingState: { status: 'running', done: msg.done, total: msg.total, skipped: msg.skipped, failed: msg.failed, message: '' },
        });
      } else if (msg.type === 'done') {
        const text = `Done! ${msg.done} new, ${msg.skipped} already tracked${msg.failed ? `, ${msg.failed} failed` : ''}`;
        await chrome.storage.local.set({
          trackingState: { status: 'idle', done: msg.done, total: msg.total, skipped: msg.skipped, failed: msg.failed, message: text },
        });
        notify('Track All complete', `${msg.done} new job${msg.done !== 1 ? 's' : ''} tracked`);
        trackingPort = null;
      } else if (msg.type === 'stopped') {
        const text = `Stopped — ${msg.done} new, ${msg.skipped} already tracked${msg.failed ? `, ${msg.failed} failed` : ''}`;
        await chrome.storage.local.set({
          trackingState: { status: 'idle', done: msg.done, total: msg.total, skipped: msg.skipped, failed: msg.failed, message: text },
        });
        trackingPort = null;
      } else if (msg.type === 'error') {
        await chrome.storage.local.set({ trackingState: { status: 'idle', message: `Error: ${msg.message}` } });
        trackingPort = null;
      }
    });

    trackingPort.onDisconnect.addListener(async () => {
      const connErr = chrome.runtime.lastError;
      trackingPort = null;
      const message = connErr
        ? (connErr.message?.includes('Receiving end does not exist') || connErr.message?.includes('invalidated')
            ? 'Refresh the LinkedIn tab, then try again'
            : `Error: ${connErr.message}`)
        : '';
      await chrome.storage.local.set({ trackingState: { status: 'idle', message } });
    });
  } catch (err) {
    trackingPort = null;
    await chrome.storage.local.set({ trackingState: { status: 'idle', message: 'Refresh the LinkedIn tab, then try again' } });
    return;
  }

  await chrome.storage.local.set({
    trackingState: { status: 'running', done: 0, total: 0, skipped: 0, failed: 0, message: 'Starting…' },
  });

  trackingPort.postMessage({ action: 'trackAllVisible' });
}

