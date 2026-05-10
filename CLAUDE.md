# Job Application Optimizer — Agent Instructions

## On Session Start

When a new conversation begins, greet the user with this message (adapt naturally, don't copy verbatim):

---

👋 **Welcome to Job Application Optimizer!**

I help you tailor your resume to every LinkedIn job you saved. Here's what I do:

1. **Read** — I load your job list from `jobs.xlsx` (exported from the LinkedIn Job Tracker Chrome extension)
2. **Score** — I score every job against your resume (0–100) and explain the fit
3. **Tailor** — For strong matches (score ≥ 65), I generate a customized PDF resume optimized for that specific role

**To get started, you'll need:**
- `resume.tex` or `resume.docx` — your base resume (place it in this folder)
- `jobs.xlsx` — your job list exported from the LinkedIn Job Tracker Chrome extension

**Don't have `jobs.xlsx` yet?**
Load the **LinkedIn Job Tracker** Chrome extension (`linkedin-job-tracker/` folder in this repo), browse LinkedIn jobs, click **+ Track** on each job you want, then click **Export jobs.xlsx** in the extension popup and drop the file here.

**Ready to run?** Just say **"start"** and I'll run the preflight checks and generate your resumes.

---

## Goal

Score job postings against your resume and generate a tailored PDF resume for every strong match (fit score ≥ 65). One run processes your full job list end-to-end.

## How It Works

```
jobs.xlsx  →  (Claude reads descriptions)  →  score + tailor  →  resumes/*.pdf
```

1. **`jobs.xlsx`** — exported from the LinkedIn Job Tracker extension. Columns: `Role`, `Company`, `Location`, `Posted`, `Applicants`, `Job Link`, `Description`
2. **Claude** — reads each row, scores fit, tailors the resume for matches, writes PDFs to `resumes/`

The job description is already in `jobs.xlsx` — no separate scraping step needed.

---

## Preflight Checklist

**Run every check below before doing anything else.** For each failure, stop and show the user the exact install command — do not proceed until all checks pass.

### 1. Required files

Run:
```bash
ls jobs.xlsx resume_optimizer_skill.md && (ls resume.tex 2>/dev/null || ls resume.docx 2>/dev/null) && echo "resume OK"
```

| File | Description |
|------|-------------|
| `jobs.xlsx` | Job list exported from LinkedIn Job Tracker extension |
| `resume.tex` or `resume.docx` | Your base resume — **never overwrite this** |
| `resume_optimizer_skill.md` | XYZ formula rules used by subagents |

If any file is missing:
- `jobs.xlsx` → install the LinkedIn Job Tracker extension, track jobs on LinkedIn, click Export
- `resume.tex` / `resume.docx` → place your resume in this folder
- `resume_optimizer_skill.md` → restore from git

### 2. Python 3

Run:
```bash
python3 --version
```

If missing:
```
Python 3 is required.
Install via: brew install python
```

### 3. Python openpyxl

Run:
```bash
python3 -c "import openpyxl; print('openpyxl OK')"
```

If it fails:
```bash
pip3 install openpyxl
```

### 4. LaTeX or pandoc (depends on resume format)

**If using `resume.tex`** — check pdflatex:
```bash
/Library/TeX/texbin/pdflatex --version 2>&1 || pdflatex --version 2>&1
```
If missing:
```
brew install --cask mactex-no-gui
```

**If using `resume.docx`** — check pandoc:
```bash
pandoc --version 2>&1 | head -1
```
If missing:
```
brew install pandoc
```

### Preflight summary rule

After running all checks, print a status table:

| Check | Status |
|-------|--------|
| jobs.xlsx | ✅ / ❌ missing |
| resume (.tex or .docx) | ✅ / ❌ missing |
| resume_optimizer_skill.md | ✅ / ❌ missing |
| Python 3 | ✅ / ❌ not found |
| openpyxl | ✅ / ❌ not installed |
| pdflatex (if .tex) | ✅ / ❌ not found |
| pandoc (if .docx) | ✅ / ❌ not found |

If any row shows ❌, stop and wait for the user to fix it before continuing.

---

## Running the Pipeline

### Step 1 — Setup

Detect resume format:
```bash
ls resume.tex 2>/dev/null && echo "tex" || echo "docx"
```

**If `.tex`:** output format is `.tex` → compiled to PDF with pdflatex.
**If `.docx`:** output format is `.docx` → converted to PDF with pandoc.

Read the resume. Extract a concise candidate profile:
- Top 10 skills, years of experience, role types, tech stack.
- Store as `CANDIDATE_PROFILE` (max 200 words). Inject into every analyst subagent.

Ensure `jobs.xlsx` has output columns: **`fit_score`**, **`fit_reasoning`**, **`resume_path`**. If absent, add them as new headers.

### Step 2 — Read jobs from Excel

Use Python to read all rows from `jobs.xlsx`:

```python
from openpyxl import load_workbook
import json

wb = load_workbook('jobs.xlsx')
ws = wb.active
headers = [cell.value for cell in ws[1]]
jobs = []
for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
    r = dict(zip(headers, row))
    r['_row'] = i
    jobs.append(r)
print(json.dumps(jobs))
```

### Step 3 — Score & Optimize (parallel subagents)

Spawn one **analyst subagent per job** in batches of **8 in parallel**.

Each subagent receives this prompt (inject `JOB_JSON`, `CANDIDATE_PROFILE`, `RESUME_FORMAT`):

---

> You are a job fit analyst.
>
> **Job:** {JOB_JSON}
> **Candidate profile:** {CANDIDATE_PROFILE}
> **Resume format:** {RESUME_FORMAT} (`tex` or `docx`)
>
> 1. **SCORE** — Assign `fit_score` (0–100) based on: skills match, experience alignment, role type, domain. Write 2-sentence `fit_reasoning`.
>
> 2. **OPTIMIZE** — If `fit_score >= 65`:
>    - Read `resume.{RESUME_FORMAT}`.
>    - Use `resume_optimizer_skill.md` to tailor it to this job description.
>    - After generating a draft, verify the resume is genuinely tailored — add key requirements to improve fit.
>    - Save to `./resumes/{COMPANY}_{ROLE}.{RESUME_FORMAT}` (sanitize special characters to underscores).
>    - **If `.tex`:** Compile with `/Library/TeX/texbin/pdflatex -output-directory ./resumes ./resumes/{COMPANY}_{ROLE}.tex`. Delete `.aux`, `.out`, `.log`. Set `resume_path` = `./resumes/{COMPANY}_{ROLE}.pdf`
>    - **If `.docx`:** Convert with `pandoc ./resumes/{COMPANY}_{ROLE}.docx -o ./resumes/{COMPANY}_{ROLE}.pdf`. Set `resume_path` = `./resumes/{COMPANY}_{ROLE}.pdf`
>    - If compilation/conversion fails, keep the source file and set `resume_path` to null.
>    - Otherwise set `resume_path` = null.
>
> 3. **REPORT:** Append one JSON line to `results.jsonl`:
>    ```json
>    {"row": {ROW}, "role": "...", "company": "...", "fit_score": 0, "fit_reasoning": "...", "resume_path": "... or null"}
>    ```
>    Then print: `{ROLE} @ {COMPANY} — Score: {SCORE} — Resume: yes/no`

---

Wait for all subagents to finish.

### Step 4 — Write results back to Excel

```python
from openpyxl import load_workbook
import json

wb = load_workbook('jobs.xlsx')
ws = wb.active

headers = {cell.value: cell.column for cell in ws[1]}
for col_name in ['fit_score', 'fit_reasoning', 'resume_path']:
    if col_name not in headers:
        col = ws.max_column + 1
        ws.cell(row=1, column=col, value=col_name)
        headers[col_name] = col

with open('results.jsonl') as f:
    for line in f:
        r = json.loads(line)
        ws.cell(row=r['row'], column=headers['fit_score'], value=r['fit_score'])
        ws.cell(row=r['row'], column=headers['fit_reasoning'], value=r['fit_reasoning'])
        ws.cell(row=r['row'], column=headers['resume_path'], value=r['resume_path'])

wb.save('jobs.xlsx')
print("jobs.xlsx updated.")
```

### Step 5 — Final report

Read `results.jsonl`. Print a markdown table sorted by `fit_score` descending:

| Role | Company | Score | Reasoning | Resume |
|------|---------|-------|-----------|--------|
| ...  | ...     | ...   | ...       | yes/no |

---

## File Structure

```
jobs_marco/
├── CLAUDE.md                  ← Claude Code instructions (this file)
├── resume_optimizer_skill.md  ← XYZ formula rules
├── resume.tex                 ← your base resume in LaTeX (READ ONLY)
├── resume.docx                ← your base resume in Word (READ ONLY, alternative)
├── jobs.xlsx                  ← job list (updated with scores after Step 4)
├── results.jsonl              ← generated by Step 3
├── linkedin-job-tracker/          ← LinkedIn Job Tracker extension source
└── resumes/
    ├── Stripe_PM.tex / .docx
    ├── Stripe_PM.pdf
    └── ...
```

---

## Rules for Subagents

- **Never overwrite `resume.tex` or `resume.docx`** — always write to `resumes/` subdirectory
- Output filenames: `{COMPANY}_{ROLE}.tex` or `{COMPANY}_{ROLE}.docx` — sanitize spaces and special characters to underscores
- After compiling PDF from `.tex`, delete `.aux`, `.out`, `.log` files
- If PDF generation fails, save the source file anyway and set `resume_path` to null

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ModuleNotFoundError: openpyxl` | `pip3 install openpyxl` |
| `pdflatex: command not found` | `brew install --cask mactex-no-gui` then restart terminal |
| `pandoc: command not found` | `brew install pandoc` |
| `resumes/` directory missing | `mkdir -p resumes` |
| jobs.xlsx missing Description column | Re-export from LinkedIn Job Tracker extension (v1.1+) |

---

## Sharing This Project

Include:
- `CLAUDE.md`, `resume_optimizer_skill.md`, `linkedin-job-tracker/`

Exclude (add to `.gitignore`):
```
resume.tex
resume.docx
jobs.xlsx
results.jsonl
resumes/
*.pdf
*.aux
*.log
*.out
```

New users: add their own resume (`.tex` or `.docx`) and `jobs.xlsx`, then open the folder in Claude Code.
