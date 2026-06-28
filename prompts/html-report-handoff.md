# Handoff: build an HTML report over `reports/ci-report.json`

You are building a polished, self-contained **HTML report** for the cdktn-cli-e2e
suite, on top of the artifacts a run already produces. Work in
`/Users/vincentdesmet/cdktn/cdktn-termless`. Deliver a script + sample output; don't
change the test suite.

## What exists to visualize

1. **`reports/ci-report.json`** — vitest's JSON reporter (jest-shape). Relevant fields:
   ```jsonc
   {
     "numTotalTests": 14, "numPassedTests": 10, "numFailedTests": 4, "numPendingTests": 1,
     "startTime": 1719600000000,
     "testResults": [                       // one entry per test FILE
       {
         "name": "/abs/path/tests/ctrl-c-teardown.test.ts",
         "status": "failed",
         "assertionResults": [              // one per test
           {
             "title": "R1: Ctrl-C at the approval menu …",
             "fullName": "#283 … > R1: …",
             "ancestorTitles": ["#283 state-lock release [cdktn-prhead]"],
             "status": "passed|failed|skipped|pending",
             "duration": 32721,
             "failureMessages": ["AssertionError: … (ANSI-coloured, multi-line)"]
           }
         ]
       }
     ]
   }
   ```
   The describe title embeds the channel, e.g. `[cdktn-prhead]` — parse it out as the
   `CLI_ID`. Strip ANSI (`\x1b\[[0-9;]*m`) from `failureMessages`.

2. **`artifacts/`** — on failure, the suite writes, per spawned terminal:
   `<CLI_ID>__<sanitized test name>__<i>.svg` (a terminal screenshot) and `.txt`
   (the spawned command + `exit=…` + final screen text). Match these to failed tests
   by the sanitized title (`title.replace(/[^\w.-]+/g,"_").slice(0,80)`).

3. **`reports/raw/<CLI_ID>/*.json`** (CI only) — per-OS copies, same shape. And the
   nightly workflow can aggregate several `CLI_ID`s; a cross-channel **verdict matrix**
   (test × CLI_ID, with NEW-vs-pre-existing classification — see `report-issue.mjs` /
   the `e2e-matrix-run` workflow logic) is the most valuable view when present.

4. **`reports/manual-verify-<CLI_ID>.md`** — optional human Ctrl-C results to fold in.

## Deliverable

- `scripts/build-report.mjs` (Node/ESM, no build step) that reads `ci-report.json`
  (and `artifacts/`, and any sibling `reports/raw/*/*.json`) and writes a **single
  self-contained** `reports/html/index.html` — inline CSS + JS, **no external CDNs**,
  SVG screenshots embedded inline (or as `data:` URIs) so the file works offline.
- Wire it as `pnpm report:html` in `package.json`. `reports/` is gitignored — keep it
  there.

## The report should show

- **Header / summary cards**: CLI_ID(s), totals (passed / failed / skipped), pass rate,
  total wall-time, run timestamp; link to the GitHub Actions run if `GITHUB_*` env /
  a `--run-url` arg is given.
- **Per-test table**, grouped by file → describe, with status pill, duration, and a
  collapsible **failure message** (ANSI-stripped, monospace) for failures.
- **Failure detail**: inline the matching `artifacts/*.svg` terminal screenshot and the
  `.txt` (command + exit + final screen) under each failed test.
- **Cross-channel matrix** when multiple channels' reports are present: rows = tests,
  columns = CLI_ID, cells = ✅/❌/⏭️, plus a verdict column (🔴 NEW vs ⚪ pre-existing,
  using the "a failure is only NEW if it passed in an earlier channel" rule).
- **Quality-of-life**: filter by status (toggle pass/fail/skip), dark mode, sortable by
  duration, sticky header. Keep it tasteful and fast — vanilla JS is fine; if you reach
  for a framework, it must still emit one self-contained file.

## Constraints & checks

- Node 24 / ESM only (match the repo). No new heavy deps; if you must add one, justify
  it and keep the output self-contained.
- Handle missing inputs gracefully (no `ci-report.json` → friendly message; no
  artifacts → omit the screenshot section).
- Verify by generating from a real run: `CLI_ID=cdktn-next pnpm test` (or reuse an
  existing `reports/ci-report.json`), then `pnpm report:html`, and open
  `reports/html/index.html`. Include a screenshot or describe the result in your final
  message.
- Don't touch `tests/`, `src/`, or fixtures. Only add `scripts/build-report.mjs`, the
  `package.json` script, and (optionally) a short note in `guides/running-tests.md`.
