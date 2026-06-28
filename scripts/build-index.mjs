#!/usr/bin/env node
// Build the GitHub Pages LANDING page that links to each matrix leg's self-contained
// HTML report. This is NOT data aggregation — each leg's report is built independently
// by build-report.mjs; this only emits an index with a per-leg pass/fail summary and
// a link to `./<leg>/`.
//
//   node scripts/build-index.mjs [--reports-dir _dl] [--site _site] [--run-url URL] [--out FILE]
//
// Layout it expects (produced by the nightly `pages` job):
//   <reports-dir>/report-<leg>/ci-report.json   one per matrix leg (leg = "<os>-<cli_id>")
//   <site>/<leg>/index.html                      the per-leg report build-report.mjs wrote
// It writes <site>/index.html linking to each ./<leg>/.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname, isAbsolute } from "node:path"

const cwdAbs = (p) => (isAbsolute(p) ? p : join(process.cwd(), p))

function parseArgs(argv) {
  const out = { reportsDir: "_dl", site: "_site", runUrl: "", outFile: "" }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reports-dir") out.reportsDir = argv[++i]
    else if (argv[i] === "--site") out.site = argv[++i]
    else if (argv[i] === "--run-url") out.runUrl = argv[++i]
    else if (argv[i] === "--out") out.outFile = argv[++i]
  }
  return out
}
const a = parseArgs(process.argv.slice(2))
const reportsDir = cwdAbs(a.reportsDir)
const site = cwdAbs(a.site)
const outFile = a.outFile ? cwdAbs(a.outFile) : join(site, "index.html")

const runUrl =
  a.runUrl ||
  (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "")

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
const cliFromDescribe = (d) => (d.match(/\[([^\]]+)\]\s*$/) || [])[1] || "unknown"
const fmtStamp = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—")

// ── discover per-leg reports ───────────────────────────────────────────────────
const legs = []
if (existsSync(reportsDir)) {
  for (const d of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith("report-")) continue
    const file = join(reportsDir, d.name, "ci-report.json")
    if (!existsSync(file)) continue
    let j
    try {
      j = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    const leg = d.name.slice("report-".length)
    const rows = (j.testResults ?? []).flatMap((f) => f.assertionResults ?? [])
    const channel = cliFromDescribe(rows[0]?.ancestorTitles?.join(" › ") ?? "")
    // OS = leg with the trailing "-<channel>" removed (matrix names are "<os>-<cli_id>").
    const os = channel !== "unknown" && leg.endsWith(`-${channel}`) ? leg.slice(0, -(channel.length + 1)) : leg
    const passed = rows.filter((r) => r.status === "passed").length
    const failed = rows.filter((r) => r.status === "failed").length
    const skipped = rows.filter((r) => r.status === "skipped" || r.status === "pending").length
    legs.push({ leg, os, channel, total: rows.length, passed, failed, skipped, startTime: j.startTime, href: `./${leg}/` })
  }
}
legs.sort((x, y) => y.failed - x.failed || x.os.localeCompare(y.os) || x.channel.localeCompare(y.channel))

// ── totals across legs ─────────────────────────────────────────────────────────
const legFails = legs.filter((l) => l.failed > 0).length
const totalFailedTests = legs.reduce((s, l) => s + l.failed, 0)
const latest = legs.reduce((m, l) => Math.max(m, l.startTime || 0), 0)

const cards = legs
  .map((l) => {
    const rate = l.passed + l.failed ? Math.round((l.passed / (l.passed + l.failed)) * 100) : 0
    const cls = l.failed > 0 ? "bad" : "ok"
    return `<a class="leg ${cls}" href="${esc(l.href)}">
      <div class="leg-h"><span class="dot"></span><span class="os">${esc(l.os)}</span><span class="ch">${esc(l.channel)}</span></div>
      <div class="leg-stats">${l.passed}✅ ${l.failed}❌ ${l.skipped}⏭️ <span class="muted">/ ${l.total}</span></div>
      <div class="bar"><i style="width:${rate}%"></i></div>
      <div class="leg-foot">${rate}% · ${esc(fmtStamp(l.startTime))}</div>
    </a>`
  })
  .join("\n")

const empty = legs.length === 0

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cdktn-cli e2e — last run results</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2128;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--green:#3fb950;--red:#f85149;--blue:#58a6ff;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:var(--panel);border-bottom:1px solid var(--border);padding:.9rem 1.2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
header h1{font-size:1.1rem;margin:0}
header .sub{color:var(--muted);font-size:.82rem}
.spacer{flex:1}
.btn{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:.35rem .7rem;font-size:.82rem;text-decoration:none}
main{max-width:980px;margin:0 auto;padding:1.4rem}
.summary{color:var(--muted);margin-bottom:1.2rem}
.summary b{color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem}
a.leg{display:block;background:var(--panel);border:1px solid var(--border);border-left-width:4px;border-radius:10px;padding:1rem;color:inherit;text-decoration:none;transition:border-color .12s,transform .12s}
a.leg:hover{transform:translateY(-2px);border-color:var(--blue)}
a.leg.ok{border-left-color:var(--green)} a.leg.bad{border-left-color:var(--red)}
.leg-h{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem}
.dot{width:9px;height:9px;border-radius:50%;background:var(--green)} .bad .dot{background:var(--red)}
.os{font-weight:600} .ch{color:var(--muted);font-family:var(--mono);font-size:.8rem}
.leg-stats{font-size:.95rem} .muted{color:var(--muted)}
.bar{height:7px;border-radius:4px;background:var(--red);overflow:hidden;margin:.55rem 0 .4rem}
.bar>i{display:block;height:100%;background:var(--green)}
.leg-foot{color:var(--muted);font-size:.75rem;font-family:var(--mono)}
.note{color:var(--muted);border:1px dashed var(--border);border-radius:8px;padding:1.2rem;text-align:center}
footer{color:var(--muted);font-size:.75rem;text-align:center;padding:2rem 1rem}
a{color:var(--blue)}
</style>
</head>
<body>
<header>
  <h1>cdktn-cli e2e — last run results</h1>
  <span class="sub">${esc(fmtStamp(latest))}</span>
  <div class="spacer"></div>
  ${runUrl ? `<a class="btn" href="${esc(runUrl)}" target="_blank" rel="noopener">↗ Actions run</a>` : ""}
</header>
<main>
  ${
    empty
      ? `<div class="note">No reports were produced for this run. Check the <a href="${esc(runUrl || "#")}">Actions run</a>.</div>`
      : `<div class="summary"><b>${legs.length}</b> leg(s) · <b>${legFails}</b> with failures · <b>${totalFailedTests}</b> failing test(s) total. Click a leg for its full report.</div>
  <div class="grid">${cards}</div>`
  }
</main>
<footer>Generated by scripts/build-index.mjs · each leg is a self-contained report</footer>
</body>
</html>`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, html)
console.error(`[build-index] ${legs.length} leg(s), ${legFails} with failures → ${outFile}`)
