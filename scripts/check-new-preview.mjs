#!/usr/bin/env node
// Diff-detection for the nightly cron: only run the (expensive) matrix when the
// preview channel actually moved since the last successful run. The last-tested
// version is committed to state/last-tested.json by the workflow after a green run.
//
// Emits GitHub Actions outputs:  should_run=<true|false>  next_version=<x>
// and a human line on stderr. Honour FORCE=1 (manual dispatch) to always run.
//
//   node scripts/check-new-preview.mjs            # cdktn-cli@next
//   PACKAGE=cdktn-cli DIST_TAG=next node scripts/check-new-preview.mjs

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE = join(HERE, "..", "state", "last-tested.json")
const PACKAGE = process.env.PACKAGE ?? "cdktn-cli"
const DIST_TAG = process.env.DIST_TAG ?? "next"

function npmVersion(pkg, tag) {
  const out = execFileSync("npm", ["view", `${pkg}@${tag}`, "version"], { encoding: "utf8" })
  return out.trim()
}

function lastTested() {
  if (!existsSync(STATE)) return null
  try {
    return JSON.parse(readFileSync(STATE, "utf8"))?.[`${PACKAGE}@${DIST_TAG}`] ?? null
  } catch {
    return null
  }
}

function emit(key, value) {
  const f = process.env.GITHUB_OUTPUT
  if (f) appendFileSync(f, `${key}=${value}\n`)
}

const current = npmVersion(PACKAGE, DIST_TAG)
const previous = lastTested()
const forced = process.env.FORCE === "1" || process.env.FORCE === "true"
const changed = current !== previous
const shouldRun = forced || changed

console.error(
  `[check-preview] ${PACKAGE}@${DIST_TAG}: current=${current} last-tested=${previous ?? "<none>"} ` +
    `→ ${shouldRun ? "RUN" : "SKIP"}${forced ? " (forced)" : changed ? " (new version)" : " (unchanged)"}`,
)
emit("should_run", String(shouldRun))
emit("next_version", current)
