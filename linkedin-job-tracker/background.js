// MV3 service worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('trackedJobs', ({ trackedJobs }) => {
    if (!trackedJobs) chrome.storage.local.set({ trackedJobs: [] });
  });
});

// ── Resume generation (survives popup close) ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'generateResume') {
    handleGenerate(msg).catch(console.error);
    sendResponse({ queued: true });
  }
  return false;
});

async function handleGenerate({ jobUrl, job, resumeText, apiKey, model, format }) {
  try {
    const content = await fetchResume(job, resumeText, apiKey, model, format);
    const { generatedResumes = {}, resumeGenerations = {} } =
      await chrome.storage.local.get(['generatedResumes', 'resumeGenerations']);
    generatedResumes[jobUrl] = content;
    delete resumeGenerations[jobUrl];
    await chrome.storage.local.set({ generatedResumes, resumeGenerations });
  } catch (err) {
    const { resumeGenerations = {} } = await chrome.storage.local.get('resumeGenerations');
    resumeGenerations[jobUrl] = { status: 'error', error: err.message };
    await chrome.storage.local.set({ resumeGenerations });
  }
}

async function fetchResume(job, resumeText, apiKey, model, format) {
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

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: `You are a professional resume writer${isTex ? ' specializing in LaTeX' : ''}. Tailor this resume to the job description using the XYZ formula.

Rules:
- XYZ formula: "Accomplished [X] as measured by [Y] by doing [Z]"
- Replace weak verbs (helped, assisted, worked on, responsible for) with power verbs (architected, drove, scaled, engineered, launched, owned, spearheaded)
- Every bullet must have a quantifiable metric (%, $, scale, time saved, users impacted)
- Reorder bullets to highlight skills matching THIS job first
- Naturally incorporate the job's keywords into bullet descriptions
- Cut anything not relevant to this specific role
- After drafting, review and add any key job requirements that are missing
${formatRules}

ORIGINAL RESUME:
${resumeText}

JOB DESCRIPTION:
${job.description || ''}`,
      }],
      max_tokens: 2000,
    }),
  });

  if (response.status === 401) throw new Error('Invalid API key (401)');
  if (response.status === 429) throw new Error('Rate limited — try again later');
  if (!response.ok) throw new Error(`OpenRouter error ${response.status}`);

  const data = await response.json();
  const choice = data.choices?.[0];
  if (!data.choices?.length) throw new Error('No response from model');
  const msg = choice.message;
  const content = msg.content ?? msg.reasoning_content ?? msg.reasoning ?? '';
  if (!content.trim()) throw new Error('Model returned empty content');
  return content.trim();
}
