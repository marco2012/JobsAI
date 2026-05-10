# LinkedIn Job Tracker

A Chrome extension to track, score, and generate tailored resumes for LinkedIn jobs.

<img src="screenshot.png" width="400" />

## Install

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `linkedin-job-tracker/` folder
4. The extension icon appears in your toolbar

## Setup

1. Open the extension popup and go to **Settings**
2. Under **OpenRouter**, paste your API key (get one at [openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys))
3. Upload your resume (`.tex` or `.docx`) and click **Generate Profile** to create your candidate profile

## Track jobs

1. Go to [LinkedIn Jobs](https://www.linkedin.com/jobs/)
2. Open any job description
3. Click **+ Track** in the job detail panel
4. Use **Track All** in the popup to batch-track every visible job on the page

## Features

| Feature | Description |
|---------|-------------|
| **Track / Track All** | Save jobs with their full description; batch-track an entire search page |
| **Score All** | Score every tracked job against your candidate profile (0–100) using AI |
| **Generate resume** | Generate a tailored resume for any job directly from the popup |
| **Regenerate** | Clear and regenerate a resume with updated settings or prompt |
| **Export jobs.xlsx** | Export all tracked jobs (with scores) to Excel |
| **Search** | Filter your job list by title, company, or location |

## Settings

- **OpenRouter** or **Google AI Studio** — pick your AI provider and paste your API key
- **Resume model** — model used for resume generation (default: `gpt-5.4-mini`)
- **Scoring model** — model used for job scoring (default: `gemini-3.1-flash-lite`)
- **Candidate profile** — paste or generate a summary used for AI scoring
- **Resume** — upload your base resume (`.tex` or `.docx`) used for generation
- **Resume generation prompt** — editable system prompt; customize tone, length, and style
