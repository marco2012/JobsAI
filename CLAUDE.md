# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


# Job Application Optimizer — Agent Instructions

## On Session Start

When a new conversation begins, greet the user with this message (adapt naturally, don't copy verbatim):

---

👋 **Welcome to Job Application Optimizer!**

I help you tailor your resume to every LinkedIn job you saved. Here's what I do:

1. **Read** — I load your job list from `optimizer/jobs.xlsx` (exported from the LinkedIn Job Tracker Chrome extension)
2. **Score** — I score every job against your resume (0–100) and explain the fit
3. **Tailor** — For strong matches (score ≥ 65), I generate a customized PDF resume optimized for that specific role

**To get started, you'll need:**
- `optimizer/resume.tex` or `optimizer/resume.docx` — your base resume
- `optimizer/jobs.xlsx` — your job list exported from the LinkedIn Job Tracker Chrome extension

**Don't have `optimizer/jobs.xlsx` yet?**
Load the **LinkedIn Job Tracker** Chrome extension (`linkedin-job-tracker/` folder in this repo), browse LinkedIn jobs, click **+ Track** on each job you want, then click **Export jobs.xlsx** in the extension popup and place it in `optimizer/`.

**Ready to run?** Just say **"start"** and I'll run the preflight checks and generate your resumes.

---

## Goal

Score job postings against your resume and generate a tailored PDF resume for every strong match (fit score ≥ 65). One run processes your full job list end-to-end.

## How It Works

```
optimizer/jobs.xlsx  →  (Claude reads descriptions)  →  score + tailor  →  optimizer/resumes/*.pdf
```

1. **`optimizer/jobs.xlsx`** — exported from the LinkedIn Job Tracker extension. Columns: `Role`, `Company`, `Location`, `Posted`, `Applicants`, `Job Link`, `Description`
2. **Claude** — reads each row, scores fit, tailors the resume for matches, writes PDFs to `optimizer/resumes/`

The job description is already in `jobs.xlsx` — no separate scraping step needed.

---

## Preflight Checklist

**Run every check below before doing anything else.** For each failure, stop and show the user the exact install command — do not proceed until all checks pass.

### 1. Required files

Run:
```bash
ls optimizer/jobs.xlsx optimizer/resume_optimizer_skill.md && (ls optimizer/resume.tex 2>/dev/null || ls optimizer/resume.docx 2>/dev/null) && echo "resume OK"
```

| File | Description |
|------|-------------|
| `optimizer/jobs.xlsx` | Job list exported from LinkedIn Job Tracker extension |
| `optimizer/resume.tex` or `optimizer/resume.docx` | Your base resume — **never overwrite this** |
| `optimizer/resume_optimizer_skill.md` | XYZ formula rules used by subagents |

If any file is missing:
- `optimizer/jobs.xlsx` → install the LinkedIn Job Tracker extension, track jobs on LinkedIn, click Export, place in `optimizer/`
- `optimizer/resume.tex` / `optimizer/resume.docx` → place your resume in `optimizer/`
- `optimizer/resume_optimizer_skill.md` → restore from git

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

### 4. LaTeX (only if using resume.tex)

**If using `resume.tex`** — check pdflatex:
```bash
/Library/TeX/texbin/pdflatex --version 2>&1 || pdflatex --version 2>&1
```
If missing:
```
brew install --cask mactex-no-gui
```

**If using `resume.docx`** — no additional tools required.

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

If any row shows ❌, stop and wait for the user to fix it before continuing.

---

## Running the Pipeline

### Step 1 — Setup

Detect resume format:
```bash
ls optimizer/resume.tex 2>/dev/null && echo "tex" || echo "docx"
```

**If `.tex`:** output format is `.tex` → compiled to PDF with pdflatex.
**If `.docx`:** output format is `.docx` → converted to PDF with pandoc.

Read the resume. Extract a concise candidate profile:
- Top 10 skills, years of experience, role types, tech stack.
- Store as `CANDIDATE_PROFILE` (max 200 words). Inject into every analyst subagent.

Ensure `optimizer/jobs.xlsx` has output columns: **`fit_score`**, **`fit_reasoning`**, **`resume_path`**. If absent, add them as new headers.

### Step 2 — Read jobs from Excel

Use Python to read all rows from `optimizer/jobs.xlsx`:

```python
from openpyxl import load_workbook
import json

wb = load_workbook('optimizer/jobs.xlsx')
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
>    - Read `optimizer/resume.{RESUME_FORMAT}`.
>    - Use `optimizer/resume_optimizer_skill.md` to tailor it to this job description.
>    - After generating a draft, verify the resume is genuinely tailored — add key requirements to improve fit.
>    - Derive the country from the job's `Location` field using your geographic knowledge — the field may contain only a city or region with no explicit country name (e.g. "Zurich", "Geneva (Hybrid)", "New York, NY", "London" → `Switzerland`, `Switzerland`, `USA`, `UK`). Do NOT split on commas and take the last token; reason about which country the location actually belongs to. If ambiguous or blank, use `Unknown`. Sanitize to a valid folder name (spaces → underscores, no special characters).
>    - Create the country subfolder if needed: `mkdir -p optimizer/resumes/{COUNTRY}`
>    - Save to `optimizer/resumes/{COUNTRY}/{SCORE}_{COMPANY}_{ROLE}.{RESUME_FORMAT}` (score is the integer fit_score, e.g. `87`; sanitize company/role special characters to underscores).
>    - **If `.tex`:** When writing the tailored `.tex` file, **never escape `#` inside `\newcommand` definitions** — `#1`, `#2`, `#3`, `#4` are LaTeX argument placeholders and must stay unescaped (e.g. `& #2 \\` not `& \#2 \\`). Escaping them causes the literal string `#2` to appear in the PDF instead of the argument value. Compile with `/Library/TeX/texbin/pdflatex -output-directory optimizer/resumes/{COUNTRY} optimizer/resumes/{COUNTRY}/{SCORE}_{COMPANY}_{ROLE}.tex`. Delete `.aux`, `.out`, `.log`. Set `resume_path` = `optimizer/resumes/{COUNTRY}/{SCORE}_{COMPANY}_{ROLE}.pdf`
>    - **If `.docx`:** Do NOT convert to PDF. Set `resume_path` = `optimizer/resumes/{COUNTRY}/{SCORE}_{COMPANY}_{ROLE}.docx`
>    - If `.tex` compilation fails, keep the source file and set `resume_path` to null.
>
> 3. **REPORT:** Append one JSON line to `optimizer/results.jsonl`:
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

wb = load_workbook('optimizer/jobs.xlsx')
ws = wb.active

headers = {cell.value: cell.column for cell in ws[1]}
for col_name in ['fit_score', 'fit_reasoning', 'resume_path']:
    if col_name not in headers:
        col = ws.max_column + 1
        ws.cell(row=1, column=col, value=col_name)
        headers[col_name] = col

with open('optimizer/results.jsonl') as f:
    for line in f:
        r = json.loads(line)
        ws.cell(row=r['row'], column=headers['fit_score'], value=r['fit_score'])
        ws.cell(row=r['row'], column=headers['fit_reasoning'], value=r['fit_reasoning'])
        ws.cell(row=r['row'], column=headers['resume_path'], value=r['resume_path'])

# Sort all data rows by fit_score descending (keep header in row 1)
header_row = [cell.value for cell in ws[1]]
data_rows = [[ws.cell(row=i, column=j).value for j in range(1, ws.max_column + 1)]
             for i in range(2, ws.max_row + 1)]
fit_col = header_row.index('fit_score')
data_rows.sort(key=lambda r: (r[fit_col] is None, -(r[fit_col] or 0)))
for i, row_data in enumerate(data_rows, start=2):
    for j, val in enumerate(row_data, start=1):
        ws.cell(row=i, column=j, value=val)

ws.freeze_panes = 'A2'

wb.save('optimizer/jobs.xlsx')
print("optimizer/jobs.xlsx updated and sorted by fit_score desc.")
```

### Step 5 — Final report

Read `optimizer/results.jsonl`. Print a markdown table sorted by `fit_score` descending:

| Role | Company | Score | Reasoning | Resume |
|------|---------|-------|-----------|--------|
| ...  | ...     | ...   | ...       | yes/no |

### Step 6 — Cleanup

Delete all temporary jsonl files:

```bash
rm -f optimizer/*.jsonl
```

---

## File Structure

```
jobsAI/
├── CLAUDE.md                        ← Claude Code instructions (this file)
├── README.md
├── .gitignore
├── linkedin-job-tracker/            ← Chrome extension source
│   ├── manifest.json
│   ├── content.js / content.css
│   ├── popup.html / popup.js
│   ├── background.js
│   └── xlsx.mini.min.js
└── optimizer/
    ├── resume_optimizer_skill.md    ← XYZ formula rules
    ├── resume.tex                   ← your base resume (READ ONLY, gitignored)
    ├── resume.docx                  ← alternative resume (READ ONLY, gitignored)
    ├── jobs.xlsx                    ← job list (gitignored)
    ├── results.jsonl                ← generated by Step 3 (gitignored)
    └── resumes/                     ← generated resumes, organised by country (gitignored)
        ├── Switzerland/
        │   ├── Salesforce_Solution_Consultant.tex
        │   └── Salesforce_Solution_Consultant.pdf
        ├── USA/
        │   ├── Stripe_PM.tex
        │   └── Stripe_PM.pdf
        └── ...
```

---

## Rules for Subagents

- **Never overwrite `optimizer/resume.tex` or `optimizer/resume.docx`** — always write to `optimizer/resumes/{COUNTRY}/`
- Derive country from the job's `Location` field; use `Unknown` if blank
- Output filenames: `{COMPANY}_{ROLE}.tex` or `{COMPANY}_{ROLE}.docx` — sanitize spaces and special characters to underscores
- Create country subfolders with `mkdir -p` before writing
- After compiling PDF from `.tex`, delete `.aux`, `.out`, `.log` files
- If PDF generation fails, save the source file anyway and set `resume_path` to null

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ModuleNotFoundError: openpyxl` | `pip3 install openpyxl` |
| `pdflatex: command not found` | `brew install --cask mactex-no-gui` then restart terminal |
| `optimizer/resumes/` directory missing | `mkdir -p optimizer/resumes` (country subfolders are created automatically) |
| jobs.xlsx missing Description column | Re-export from LinkedIn Job Tracker extension (v1.1+) |

---

## Sharing This Project

Include:
- `CLAUDE.md`, `linkedin-job-tracker/`, `optimizer/resume_optimizer_skill.md`

Exclude (already in `.gitignore`):
```
optimizer/resume.tex
optimizer/resume.docx
optimizer/jobs.xlsx
optimizer/results.jsonl
optimizer/resumes/
```

New users: place their resume in `optimizer/` and export `jobs.xlsx` from the extension into `optimizer/`, then open the folder in Claude Code.
