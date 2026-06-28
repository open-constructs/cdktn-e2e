#!/usr/bin/env node
// Human ground-truth runbook for the Ctrl-C behaviors the automated termless suite
// asserts. Use this to confirm the e2e Pass/Fail findings are FACTUAL — especially
// where automation is uncertain. It guides you through each scenario in a real
// terminal (you press Ctrl-C yourself), shows what the e2e test asserts, records
// your observation, and writes a markdown report.
//
//   CLI_ID=cdktn-prhead node scripts/manual-verify.mjs        # default: cdktn-next
//
// For the #283 lock scenarios it boots an in-process Terraform HTTP backend mock and
// prints the exact command to paste into a SECOND terminal, then reports the mock's
// LOCK/UNLOCK events so you can see, factually, whether the lock was released.

import { createServer } from "node:http"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const CLI_ID = process.env.CLI_ID ?? "cdktn-next"
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => rl.question(q)

function manifest() {
  const p = join(ROOT, ".sandboxes", CLI_ID, "manifest.json")
  if (!existsSync(p)) {
    console.error(`No sandbox for "${CLI_ID}". Run:  pnpm provision ${CLI_ID}`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(p, "utf8"))
}
const cli = manifest()
const fixture = (name) => join(ROOT, ".sandboxes", CLI_ID, "fixtures", name)
const cmd = (args, cwd) => `( cd "${cwd}" && "${process.execPath}" "${cli.binPath}" ${args} )`

// --- minimal in-process Terraform HTTP backend mock (lock-event log) ----------
function startMock() {
  let lock = null
  const events = []
  const GUID = "manual"
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost")
    const body = []
    req.on("data", (c) => body.push(c)).on("end", () => {
      const j = (() => { try { return JSON.parse(Buffer.concat(body).toString() || "null") } catch { return null } })()
      if (u.pathname === `/tfstate/${GUID}/lock`) {
        if (lock) { events.push(`LOCK denied (held by ${lock.ID})`); res.writeHead(423).end(JSON.stringify(lock)); return }
        lock = j ?? { ID: "?" }; events.push(`LOCK acquired (${lock.ID})`); res.writeHead(200).end(JSON.stringify(lock)); return
      }
      if (u.pathname === `/tfstate/${GUID}/unlock`) { events.push(`UNLOCK (${lock?.ID ?? "?"})`); lock = null; res.writeHead(200).end("{}"); return }
      if (u.pathname === `/tfstate/${GUID}`) {
        if (req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(j ?? {}))
        return void res.writeHead(200).end()
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}/tfstate/${GUID}`
    resolve({ base, lockAddr: `${base}/lock`, unlockAddr: `${base}/unlock`, events, lock: () => lock, close: () => server.close() })
  }))
}

const scenarios = [
  {
    id: "R1",
    title: "Ctrl-C at the deploy approval prompt (inquirer)",
    async run() {
      console.log(`\nRun this, and when you see "Please review the diff output above", press Ctrl-C ONCE:\n`)
      console.log("  " + cmd("deploy", fixture("minimal-ts")) + "\n")
      console.log("e2e asserts: process EXITS (cursor restored), does NOT hang.")
      console.log("PASS (fix present): exits cleanly, shell prompt returns, terminal cursor visible.")
      console.log("FAIL (bug): hangs — you must Ctrl-C again / kill it.")
    },
  },
  {
    id: "283-single",
    title: "#283 — single Ctrl-C during apply releases the state lock",
    mock: true,
    async run(mock) {
      console.log(`\nRun this; when terraform reaches "Still creating"/"Gracefully shutting down", press Ctrl-C ONCE:\n`)
      const env = `TF_HTTP_ADDRESS="${mock.base}" TF_HTTP_LOCK_ADDRESS="${mock.lockAddr}" TF_HTTP_UNLOCK_ADDRESS="${mock.unlockAddr}" LOCK_HOLD_SECONDS=25`
      console.log("  " + env + " \\\n    " + cmd("deploy --auto-approve", fixture("locking-http-ts")) + "\n")
      console.log("e2e asserts: screen shows 'Gracefully shutting down'; mock records an UNLOCK; lock released.")
    },
  },
  {
    id: "283-double",
    title: "#283 control — TWO Ctrl-C hard-kills terraform and leaves the lock held",
    mock: true,
    async run(mock) {
      console.log(`\nRun this; after the FIRST Ctrl-C shows "Gracefully shutting down", press Ctrl-C a SECOND time quickly:\n`)
      const env = `TF_HTTP_ADDRESS="${mock.base}" TF_HTTP_LOCK_ADDRESS="${mock.lockAddr}" TF_HTTP_UNLOCK_ADDRESS="${mock.unlockAddr}" LOCK_HOLD_SECONDS=25`
      console.log("  " + env + " \\\n    " + cmd("deploy --auto-approve", fixture("locking-http-ts")) + "\n")
      console.log("e2e asserts: 'Two interrupts received'; NO UNLOCK; lock left stale (next run fails to acquire).")
    },
  },
]

console.log(`\n=== Manual Ctrl-C verification — CLI_ID=${CLI_ID} (${cli.binName} ${cli.version}) ===`)
console.log(`Confirms the automated termless findings are factual. Answer P (pass) / F (fail) / S (skip).`)

const results = []
for (const sc of scenarios) {
  console.log(`\n────────────────────────────────────────────────────────\n## ${sc.title}`)
  let mock
  if (sc.mock) { mock = await startMock(); console.log(`(mock backend up; LOCK/UNLOCK will be reported after you run it)`) }
  await sc.run(mock)
  await ask("\nPress Enter once you've run it and observed the result… ")
  if (mock) {
    console.log(`\nMock lock events: ${mock.events.length ? mock.events.join("  |  ") : "(none received)"}`)
    console.log(`Lock currently held: ${mock.lock() ? "YES (stale)" : "no (released)"}`)
    mock.close()
  }
  const verdict = (await ask("Did reality match the e2e assertion above? [P/F/S]: ")).trim().toUpperCase()
  const notes = await ask("Notes (optional): ")
  results.push({ id: sc.id, title: sc.title, verdict: verdict || "S", notes, mockEvents: mock?.events ?? [] })
}

rl.close()
mkdirSync(join(ROOT, "reports"), { recursive: true })
const lines = [
  `# Manual Ctrl-C verification — ${CLI_ID}`,
  `CLI: ${cli.binName} ${cli.version}`,
  "",
  "| scenario | verdict | mock lock events | notes |",
  "| --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.title} | ${r.verdict} | ${(r.mockEvents || []).join("; ") || "-"} | ${r.notes || ""} |`),
]
const out = join(ROOT, "reports", `manual-verify-${CLI_ID}.md`)
writeFileSync(out, lines.join("\n") + "\n")
console.log(`\nWrote ${out}`)
const fails = results.filter((r) => r.verdict === "F")
if (fails.length) console.log(`⚠️  ${fails.length} scenario(s) did NOT match the e2e assertion — investigate before trusting that test.`)
else console.log(`✅ All run scenarios matched the e2e assertions (or were skipped).`)
