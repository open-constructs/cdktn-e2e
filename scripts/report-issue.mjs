#!/usr/bin/env node
// Manage ONE dedup'd GitHub issue per CLI channel from vitest JSON reports.
//
//   node scripts/report-issue.mjs --cli-id cdktn-next [--run-url URL] <report.json...>
//
// Policy (see DESIGN.md "Re-run policy"): each @next version is tested once; the
// cron does NOT auto-retry failures. So a failure must be SURFACED, not repeated:
//  - failures present  → open a tracking issue (or comment on the existing one)
//  - all green         → comment "recovered" and close any open issue
//
// Idempotent and safe: if `gh`/token is unavailable it logs and exits 0 (never
// breaks the workflow). Dedup is by a hidden marker in the issue body.

import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"

const LABEL = "nightly-e2e"

function parseArgs(argv) {
  const out = { cliId: "unknown", runUrl: "", files: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cli-id") out.cliId = argv[++i]
    else if (argv[i] === "--run-url") out.runUrl = argv[++i]
    else out.files.push(argv[i])
  }
  return out
}

/** Flatten vitest (jest-shape) JSON into {file,title,status} rows. */
function readReport(file) {
  const j = JSON.parse(readFileSync(file, "utf8"))
  const rows = []
  for (const f of j.testResults ?? []) {
    const base = (f.name ?? "").split(/[\\/]/).pop()
    for (const a of f.assertionResults ?? []) {
      rows.push({ file: base, title: a.title, status: a.status })
    }
  }
  return rows
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8" })
  } catch (err) {
    if (allowFail) return ""
    throw err
  }
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const { cliId, runUrl, files } = parseArgs(process.argv.slice(2))
const present = files.filter(existsSync)
if (present.length === 0) {
  console.error(`[report-issue] no report files found (${files.join(", ")}); nothing to do`)
  process.exit(0)
}

// Aggregate across all passed reports (e.g. one per OS), dedup failing titles.
const all = present.flatMap(readReport)
const failed = [...new Map(all.filter((r) => r.status === "failed").map((r) => [`${r.file}::${r.title}`, r])).values()]
const passedCount = all.filter((r) => r.status === "passed").length
const FAILS = failed.length > 0

const marker = `<!-- e2e:${cliId} -->`
const title = `Nightly e2e: ${cliId} regression`

if (!ghAvailable() || !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error("[report-issue] gh CLI or token unavailable — skipping issue management")
  console.error(`[report-issue] ${cliId}: ${failed.length} failed / ${passedCount} passed`)
  process.exit(0)
}

// Ensure the label exists (ignore "already exists").
gh(["label", "create", LABEL, "--color", "B60205", "--description", "nightly e2e regressions"], { allowFail: true })

// Find an existing open issue carrying our marker.
const listed = gh(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "50", "--json", "number,body"], {
  allowFail: true,
})
let existing = null
try {
  existing = (JSON.parse(listed || "[]")).find((i) => (i.body ?? "").includes(marker))?.number ?? null
} catch {
  existing = null
}

const runLine = runUrl ? `\n\nRun: ${runUrl}` : ""

if (FAILS) {
  const table = [
    "| test | status |",
    "| --- | --- |",
    ...failed.map((f) => `| ${f.file} › ${f.title} | ❌ failed |`),
  ].join("\n")
  const body = `${marker}\n**${cliId}** — ${failed.length} failing test(s), ${passedCount} passing (across ${present.length} report(s)).\n\n${table}${runLine}`

  if (existing) {
    gh(["issue", "comment", String(existing), "--body", body])
    console.error(`[report-issue] updated issue #${existing} (${failed.length} failures)`)
  } else {
    gh(["issue", "create", "--title", title, "--label", LABEL, "--body", body])
    console.error(`[report-issue] opened issue for ${cliId} (${failed.length} failures)`)
  }
} else if (existing) {
  gh(["issue", "comment", String(existing), "--body", `${marker}\n✅ Recovered — all ${passedCount} tests passing.${runLine}`])
  gh(["issue", "close", String(existing)])
  console.error(`[report-issue] closed issue #${existing} (recovered)`)
} else {
  console.error(`[report-issue] ${cliId}: all green, no open issue — nothing to do`)
}
