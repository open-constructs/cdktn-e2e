#!/usr/bin/env node
// Build a single self-contained HTML report from ONE e2e run's artifacts.
//
//   node scripts/build-report.mjs [--report FILE] [--artifacts DIR] [--run-url URL] [--out FILE]
//
// Reads (all optional — missing inputs degrade gracefully):
//   reports/ci-report.json          vitest JSON reporter (jest-shape) for this run
//   artifacts/<CLI_ID>__<title>__<i>.svg|.txt   terminal screenshot + final screen
//   reports/manual-verify-<CLI_ID>.md           optional human Ctrl-C results
//
// Writes reports/html/index.html — inline CSS+JS, SVGs embedded inline, no CDNs,
// works fully offline. Wired as `pnpm report:html`.
//
// Single-run by design: the nightly CI builds this on a fresh checkout/machine, so
// there is nothing to aggregate. (Cross-channel comparison was intentionally removed.)
//
// FUTURE: when Vitest 5.0 ships (currently beta-only, see DESIGN.md "HTML report"),
// the built-in `['html', { singleFile: true }]` reporter + `context.annotate()`
// attachments can likely replace most of this. Tracked for migration then.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS = join(ROOT, "reports")
// Explicit CLI paths resolve against the caller's cwd (conventional); defaults are
// repo-relative so `pnpm report:html` works from anywhere.
const abs = (p) => (isAbsolute(p) ? p : join(process.cwd(), p))

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    runUrl: "",
    outFile: join(REPORTS, "html", "index.html"),
    reportFile: join(REPORTS, "ci-report.json"),
    artifactsDir: join(ROOT, "artifacts"),
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run-url") out.runUrl = argv[++i]
    else if (argv[i] === "--out") out.outFile = abs(argv[++i])
    else if (argv[i] === "--report") out.reportFile = abs(argv[++i])
    else if (argv[i] === "--artifacts") out.artifactsDir = abs(argv[++i])
  }
  return out
}
const { runUrl: runUrlArg, outFile, reportFile, artifactsDir } = parseArgs(process.argv.slice(2))

// Prefer an explicit --run-url, else reconstruct from GitHub Actions env.
const runUrl =
  runUrlArg ||
  (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "")

// ── helpers ───────────────────────────────────────────────────────────────────
// Strip all escape sequences: CSI (incl. private `?25l` cursor modes), OSC, and
// lone Fe escapes — not just SGR colour codes.
const stripAnsi = (s) =>
  String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b/g, "␛") // any lone ESC left in prose (e.g. a message quoting "\x1b[")
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
// Mirror the suite's artifact-name sanitisation (src/setup.ts screenshot path).
const sanitize = (title) => title.replace(/[^\w.-]+/g, "_").slice(0, 80)
const cliFromDescribe = (d) => (d.match(/\[([^\]]+)\]\s*$/) || [])[1] || "unknown"
const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)
const fmtStamp = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—")

// ── read the single report ─────────────────────────────────────────────────────
let report = null
if (existsSync(reportFile)) {
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"))
  } catch {
    report = null
  }
}

function writePlaceholder(msg) {
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(
    outFile,
    `<!doctype html><meta charset="utf-8"><title>cdktn e2e report</title>` +
      `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.6">` +
      `<h1>No report found</h1><p>${esc(msg)}</p>` +
      `<p>Run a suite first, e.g. <code>CLI_ID=cdktn-next pnpm test</code>, then <code>pnpm report:html</code>.</p></body>`,
  )
  console.error(`[build-report] ${msg} — wrote placeholder to ${outFile}`)
  process.exit(0)
}

if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0) {
  writePlaceholder(`No usable report at ${reportFile}`)
}

// ── flatten to rows ─────────────────────────────────────────────────────────────
const rows = []
for (const f of report.testResults) {
  const file = (f.name ?? "").split(/[\\/]/).pop() || "(unknown file)"
  for (const a of f.assertionResults ?? []) {
    const describe = (a.ancestorTitles ?? []).join(" › ") || "(top level)"
    rows.push({
      file,
      describe,
      cliId: cliFromDescribe(describe),
      title: a.title ?? a.fullName ?? "(untitled)",
      status: a.status ?? "unknown",
      duration: typeof a.duration === "number" ? a.duration : 0,
      failureMessages: (a.failureMessages ?? []).map(stripAnsi),
    })
  }
}
const channels = [...new Set(rows.map((r) => r.cliId))]

// ── attach artifacts (svg screenshot + txt final-screen) to each failed row ────
let artifactNames = []
try {
  artifactNames = existsSync(artifactsDir) ? readdirSync(artifactsDir) : []
} catch {
  artifactNames = []
}
function artifactsFor(row) {
  const prefix = `${row.cliId}__${sanitize(row.title)}__`
  const svgs = artifactNames.filter((n) => n.startsWith(prefix) && n.endsWith(".svg")).sort()
  const txts = artifactNames.filter((n) => n.startsWith(prefix) && n.endsWith(".txt")).sort()
  const idxs = [...new Set([...svgs, ...txts].map((n) => n.slice(prefix.length).replace(/\.(svg|txt)$/, "")))].sort()
  const items = []
  for (const i of idxs) {
    const svg = svgs.find((n) => n === `${prefix}${i}.svg`)
    const txt = txts.find((n) => n === `${prefix}${i}.txt`)
    items.push({
      idx: i,
      svg: svg ? readFileSync(join(artifactsDir, svg), "utf8") : null,
      txt: txt ? stripAnsi(readFileSync(join(artifactsDir, txt), "utf8")) : null,
    })
  }
  return items
}

// ── manual-verify markdown (optional) ─────────────────────────────────────────
const manualVerify = []
if (existsSync(REPORTS)) {
  for (const f of readdirSync(REPORTS).filter((n) => /^manual-verify-.+\.md$/.test(n))) {
    manualVerify.push({ cliId: f.replace(/^manual-verify-(.+)\.md$/, "$1"), md: readFileSync(join(REPORTS, f), "utf8") })
  }
}

// ── totals ────────────────────────────────────────────────────────────────────
const total = rows.length
const passed = rows.filter((r) => r.status === "passed").length
const failed = rows.filter((r) => r.status === "failed").length
const skippedTests = rows.filter((r) => r.status === "skipped" || r.status === "pending").length
const passRate = total ? Math.round((passed / (passed + failed || 1)) * 100) : 0
const wallMs = rows.reduce((a, r) => a + r.duration, 0)
const runStamp = fmtStamp(report.startTime)

// ── render ────────────────────────────────────────────────────────────────────
const statusIcon = { passed: "✅", failed: "❌", skipped: "⏭️", pending: "⏭️" }

// group rows: file -> describe -> [rows]
const byFile = new Map()
for (const r of rows) {
  if (!byFile.has(r.file)) byFile.set(r.file, new Map())
  const d = byFile.get(r.file)
  if (!d.has(r.describe)) d.set(r.describe, [])
  d.get(r.describe).push(r)
}

let detailHtml = ""
for (const [file, describes] of [...byFile.entries()].sort()) {
  detailHtml += `<section class="file"><h3 class="file-h">${esc(file)}</h3>`
  for (const [describe, drows] of describes) {
    detailHtml += `<div class="desc"><div class="desc-h">${esc(describe)}</div>`
    for (const r of drows) {
      const arts = r.status === "failed" ? artifactsFor(r) : []
      const hasDetail = r.failureMessages.length > 0 || arts.length > 0
      detailHtml += `<div class="test" data-status="${esc(r.status)}" data-dur="${r.duration}" data-title="${esc(r.title.toLowerCase())}">`
      detailHtml += `<div class="test-row${hasDetail ? " expandable" : ""}"${hasDetail ? ' onclick="this.parentElement.classList.toggle(\'open\')"' : ""}>`
      detailHtml += `<span class="pill p-${esc(r.status)}">${statusIcon[r.status] || "·"} ${esc(r.status)}</span>`
      detailHtml += `<span class="t-title">${hasDetail ? '<span class="caret">▸</span> ' : ""}${esc(r.title)}</span>`
      detailHtml += `<span class="t-dur">${fmtDur(r.duration)}</span></div>`
      if (hasDetail) {
        detailHtml += `<div class="test-detail">`
        for (const m of r.failureMessages) detailHtml += `<pre class="fail">${esc(m)}</pre>`
        for (const a of arts) {
          detailHtml += `<div class="artifact"><div class="art-h">terminal #${esc(a.idx)}</div>`
          if (a.svg) detailHtml += `<div class="art-svg">${a.svg}</div>`
          if (a.txt) detailHtml += `<pre class="art-txt">${esc(a.txt)}</pre>`
          detailHtml += `</div>`
        }
        detailHtml += `</div>`
      }
      detailHtml += `</div>`
    }
    detailHtml += `</div>`
  }
  detailHtml += `</section>`
}

// manual-verify section
let manualHtml = ""
if (manualVerify.length) {
  manualHtml += `<section class="card-section"><h2>Manual Ctrl-C verification</h2>`
  for (const mv of manualVerify) {
    manualHtml += `<details class="mv"><summary>${esc(mv.cliId)}</summary><pre class="mv-md">${esc(mv.md)}</pre></details>`
  }
  manualHtml += `</section>`
}

const channelLabel = channels.join(" · ") || "unknown"
const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cdktn-cli e2e report — ${esc(channelLabel)}</title>
<style>
:root{
  --bg:#0d1117; --panel:#161b22; --panel2:#1c2128; --border:#30363d; --text:#e6edf3; --muted:#8b949e;
  --green:#3fb950; --red:#f85149; --yellow:#d29922; --blue:#58a6ff; --accent:#58a6ff;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
}
[data-theme="light"]{
  --bg:#ffffff; --panel:#f6f8fa; --panel2:#eef1f4; --border:#d0d7de; --text:#1f2328; --muted:#656d76;
  --green:#1a7f37; --red:#cf222e; --yellow:#9a6700; --blue:#0969da;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:20;background:var(--panel);border-bottom:1px solid var(--border);padding:.7rem 1.2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
header h1{font-size:1.05rem;margin:0;font-weight:600}
header .sub{color:var(--muted);font-size:.8rem}
.spacer{flex:1}
main{max-width:1100px;margin:0 auto;padding:1.2rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.8rem;margin-bottom:1.4rem}
.cardk{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:.8rem 1rem}
.cardk .n{font-size:1.5rem;font-weight:700;line-height:1}
.cardk .l{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;margin-top:.35rem}
.cardk.ok .n{color:var(--green)} .cardk.bad .n{color:var(--red)} .cardk.skip .n{color:var(--yellow)}
.bar{height:8px;border-radius:4px;background:var(--red);overflow:hidden;margin-top:.5rem}
.bar > i{display:block;height:100%;background:var(--green)}
h2{font-size:1rem;margin:1.6rem 0 .7rem;padding-bottom:.3rem;border-bottom:1px solid var(--border)}
.toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:1rem 0}
.toolbar input[type=search]{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:.35rem .6rem;min-width:200px}
.btn{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:.35rem .7rem;cursor:pointer;font-size:.82rem}
.btn:hover{border-color:var(--accent)}
.btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn.off{opacity:.45;text-decoration:line-through}
.file-h{font-family:var(--mono);font-size:.85rem;color:var(--muted);margin:1.2rem 0 .4rem}
.desc{border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:.7rem;background:var(--panel)}
.desc-h{background:var(--panel2);padding:.45rem .8rem;font-weight:600;font-size:.85rem;border-bottom:1px solid var(--border)}
.test{border-top:1px solid var(--border)}
.test:first-of-type{border-top:none}
.test-row{display:flex;align-items:center;gap:.7rem;padding:.45rem .8rem}
.test-row.expandable{cursor:pointer}
.test-row.expandable:hover{background:var(--panel2)}
.t-title{flex:1;min-width:0}
.caret{display:inline-block;color:var(--muted);transition:transform .15s}
.test.open .caret{transform:rotate(90deg)}
.t-dur{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.8rem;white-space:nowrap}
.pill{font-size:.7rem;padding:.1rem .45rem;border-radius:20px;white-space:nowrap;border:1px solid transparent}
.p-passed{color:var(--green);border-color:var(--green)}
.p-failed{color:var(--red);border-color:var(--red)}
.p-skipped,.p-pending{color:var(--yellow);border-color:var(--yellow)}
.test-detail{display:none;padding:.3rem .8rem .8rem;background:var(--bg)}
.test.open .test-detail{display:block}
pre.fail{background:#2d0f10;color:#ffb4ab;border:1px solid var(--red);border-radius:6px;padding:.7rem;overflow:auto;font-family:var(--mono);font-size:.78rem;white-space:pre-wrap;word-break:break-word}
[data-theme="light"] pre.fail{background:#fff0f0;color:#86181d}
.artifact{margin-top:.7rem;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.art-h{background:var(--panel2);padding:.3rem .6rem;font-size:.75rem;color:var(--muted);font-family:var(--mono)}
.art-svg{padding:.5rem;overflow:auto;background:#1e1e1e}
.art-svg svg{max-width:100%;height:auto;display:block}
pre.art-txt{margin:0;padding:.6rem;font-family:var(--mono);font-size:.75rem;white-space:pre-wrap;color:var(--muted);border-top:1px solid var(--border)}
details.mv{border:1px solid var(--border);border-radius:8px;margin-bottom:.6rem;background:var(--panel);padding:.4rem .8rem}
details.mv summary{cursor:pointer;font-weight:600}
pre.mv-md{white-space:pre-wrap;font-family:var(--mono);font-size:.8rem}
a{color:var(--blue)}
.src{color:var(--muted);font-size:.78rem;margin:-.6rem 0 1rem;font-family:var(--mono)}
.hidden{display:none!important}
footer{color:var(--muted);font-size:.75rem;text-align:center;padding:2rem 1rem}
</style>
</head>
<body>
<header>
  <h1>cdktn-cli e2e</h1>
  <span class="sub">${esc(channelLabel)} &nbsp;•&nbsp; ${esc(runStamp)}</span>
  <div class="spacer"></div>
  ${runUrl ? `<a class="btn" href="${esc(runUrl)}" target="_blank" rel="noopener">↗ Actions run</a>` : ""}
  <button class="btn" id="theme" onclick="toggleTheme()">◐ theme</button>
</header>
<main>
  <div class="cards">
    <div class="cardk"><div class="n">${total}</div><div class="l">tests</div></div>
    <div class="cardk ok"><div class="n">${passed}</div><div class="l">passed</div></div>
    <div class="cardk bad"><div class="n">${failed}</div><div class="l">failed</div></div>
    <div class="cardk skip"><div class="n">${skippedTests}</div><div class="l">skipped</div></div>
    <div class="cardk"><div class="n">${passRate}%</div><div class="l">pass rate</div><div class="bar"><i style="width:${passRate}%"></i></div></div>
    <div class="cardk"><div class="n">${fmtDur(wallMs)}</div><div class="l">total time</div></div>
  </div>
  <div class="src">source: ${esc(reportFile.split(/[\\/]/).pop())} · run ${esc(runStamp)}</div>

  ${manualHtml}

  <h2>Tests</h2>
  <div class="toolbar">
    <input type="search" id="q" placeholder="filter by test name…" oninput="applyFilters()">
    <button class="btn active" data-st="passed" onclick="toggleStatus(this)">✅ passed</button>
    <button class="btn active" data-st="failed" onclick="toggleStatus(this)">❌ failed</button>
    <button class="btn active" data-st="skipped" onclick="toggleStatus(this)">⏭️ skipped</button>
    <span class="spacer"></span>
    <button class="btn" id="sortbtn" onclick="toggleSort()">⇅ sort: source order</button>
    <button class="btn" onclick="setAll(true)">expand all</button>
    <button class="btn" onclick="setAll(false)">collapse all</button>
  </div>
  <div id="detail">${detailHtml}</div>
</main>
<footer>Generated by scripts/build-report.mjs · self-contained, offline-ready</footer>
<script>
const off = new Set();
function toggleStatus(b){
  const st = b.dataset.st;
  if(off.has(st)){off.delete(st); b.classList.remove("off"); b.classList.add("active");}
  else{off.add(st); b.classList.add("off"); b.classList.remove("active");}
  applyFilters();
}
function statusGroup(s){ return s==="pending" ? "skipped" : s; }
function applyFilters(){
  const q=(document.getElementById("q").value||"").toLowerCase();
  document.querySelectorAll(".test").forEach(t=>{
    const st=statusGroup(t.dataset.status);
    const hit=(!off.has(st)) && (!q || t.dataset.title.includes(q));
    t.classList.toggle("hidden", !hit);
  });
  document.querySelectorAll(".desc").forEach(d=>{
    d.classList.toggle("hidden", !d.querySelector(".test:not(.hidden)"));
  });
  document.querySelectorAll("section.file").forEach(s=>{
    s.classList.toggle("hidden", !s.querySelector(".desc:not(.hidden)"));
  });
}
let sortMode=0; // 0 source, 1 slowest, 2 fastest
function toggleSort(){
  sortMode=(sortMode+1)%3;
  document.getElementById("sortbtn").textContent="⇅ sort: "+["source order","slowest first","fastest first"][sortMode];
  document.querySelectorAll(".desc").forEach(d=>{
    const tests=[...d.querySelectorAll(".test")];
    if(sortMode!==0) tests.sort((a,b)=>{const x=+a.dataset.dur,y=+b.dataset.dur;return sortMode===1?y-x:x-y;});
    else tests.sort((a,b)=>(+a.dataset.src||0)-(+b.dataset.src||0));
    tests.forEach(t=>d.appendChild(t));
  });
}
function setAll(open){ document.querySelectorAll(".test").forEach(t=>{ if(t.querySelector(".test-detail")) t.classList.toggle("open",open); }); }
function toggleTheme(){
  const r=document.documentElement;
  r.dataset.theme = r.dataset.theme==="dark" ? "light" : "dark";
  try{ localStorage.setItem("cdktn-report-theme", r.dataset.theme); }catch(e){}
}
(function(){ try{ const t=localStorage.getItem("cdktn-report-theme"); if(t) document.documentElement.dataset.theme=t; }catch(e){} })();
document.querySelectorAll(".desc").forEach(d=>{ [...d.querySelectorAll(".test")].forEach((t,i)=>t.dataset.src=i); });
</script>
</body>
</html>`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, html)
const kb = (Buffer.byteLength(html) / 1024).toFixed(0)
console.error(
  `[build-report] ${total} tests (${passed}✅ ${failed}❌ ${skippedTests}⏭️) — ${channelLabel}`,
)
console.error(`[build-report] wrote ${outFile} (${kb} KB, self-contained)`)
