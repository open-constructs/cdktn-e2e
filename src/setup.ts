// Registers the termless Vitest matchers (toContainText, toHaveText, toMatchLines,
// toHaveAttrs, toContainOutput, cursor/style matchers, terminal/SVG snapshots, …)
// and their TypeScript augmentation of `expect`. Imported via vitest `setupFiles`.
import "@termless/test/matchers"

import { afterEach, beforeEach } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { activeTerminals, resetActiveTerminals } from "./harness.js"
import { REPO_ROOT } from "./manifest.js"
import { currentCliId } from "./versions.js"

const ARTIFACTS = join(REPO_ROOT, "artifacts")

beforeEach(() => resetActiveTerminals())

// On failure, dump an SVG screenshot + the raw screen text of every terminal the
// test spawned, so CI artifacts explain "what did the screen actually look like".
afterEach((ctx) => {
  if (ctx.task.result?.state !== "fail") return
  mkdirSync(ARTIFACTS, { recursive: true })
  const safe = ctx.task.name.replace(/[^\w.-]+/g, "_").slice(0, 80)
  activeTerminals.forEach(({ term, command }, i) => {
    const stem = join(ARTIFACTS, `${currentCliId()}__${safe}__${i}`)
    try {
      writeFileSync(`${stem}.svg`, term.screenshotSvg())
      writeFileSync(`${stem}.txt`, `$ ${command.join(" ")}\nexit=${term.exitInfo}\n\n${term.screen.getText()}`)
    } catch {
      /* best-effort: a dead terminal may refuse a screenshot */
    }
  })
})
