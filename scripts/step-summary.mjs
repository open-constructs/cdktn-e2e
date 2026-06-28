#!/usr/bin/env node
// Append a per-run pass/fail table to the GitHub Actions step summary so the run
// page itself is the report (independent of any notification).
//
//   node scripts/step-summary.mjs <report.json>
//
// No-ops when GITHUB_STEP_SUMMARY is unset (i.e. outside Actions).

import { readFileSync, appendFileSync, existsSync } from "node:fs"

const file = process.argv[2]
const out = process.env.GITHUB_STEP_SUMMARY
if (!out) process.exit(0)
if (!file || !existsSync(file)) {
  appendFileSync(out, `\n> ⚠️ no vitest report at \`${file ?? "?"}\`\n`)
  process.exit(0)
}

const j = JSON.parse(readFileSync(file, "utf8"))
const icon = (s) => (s === "passed" ? "✅" : s === "failed" ? "❌" : s === "skipped" || s === "pending" ? "⏭️" : "·")
const rows = []
let pass = 0
let fail = 0
for (const f of j.testResults ?? []) {
  const base = (f.name ?? "").split(/[\\/]/).pop()
  for (const a of f.assertionResults ?? []) {
    if (a.status === "passed") pass++
    else if (a.status === "failed") fail++
    rows.push(`| ${base} › ${a.title} | ${icon(a.status)} |`)
  }
}

const cliId = process.env.CLI_ID ?? "?"
const os = process.env.RUNNER_OS ?? process.platform
const header = `### e2e — \`${cliId}\` on ${os}: ${pass} passed, ${fail} failed\n\n| test | result |\n| --- | --- |\n`
appendFileSync(out, `\n${header}${rows.join("\n")}\n`)
