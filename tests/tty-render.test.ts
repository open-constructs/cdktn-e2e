import { describe, test, expect } from "vitest"
import { spawnCli, waitExit, exitedCleanly } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"

// TTY render path: the surface PR #264 rewrote from Ink/React to
// cli-spinners + cli-table3 + the StreamRenderer bar. We assert on the *bytes*
// (cursor hide/show, spinner frames) and on the *grid* (final summary, table).
describe(`tty rendering [${currentCliId()}]`, () => {
  test("synth: spinner lifecycle then a permanent summary line", async () => {
    const { term } = await spawnCli({ argv: ["synth"], fixture: "minimal-ts", mode: "tty" })

    // Interactive path hides the cursor while the spinner runs …
    await expect(term.out).toContainOutput("\x1b[?25l", { timeout: 30_000 })
    // … the permanent result line lands on the grid …
    await expect(term.screen).toContainText("Generated Terraform code", { timeout: 90_000 })
    // … and the cursor is restored before exit (no leaked hidden cursor).
    await expect(term.out).toContainOutput("\x1b[?25h", { timeout: 90_000 })

    expect(exitedCleanly(await waitExit(term))).toBe(true)
  })

  test("list: columned stack list with a bold header", async () => {
    const { term } = await spawnCli({ argv: ["list"], fixture: "multi-stack-ts", mode: "tty" })
    await expect(term.screen).toContainText("infra", { timeout: 90_000 })
    expect(term.screen).toContainText("app")
    expect(exitedCleanly(await waitExit(term))).toBe(true)
  })

  test("provider list: renders a bordered table box", async () => {
    // The minimal fixture has no providers, so the table is empty — cli-table3 still
    // draws the box corners (`┌`). Asserting the horizontal rule `─` is wrong for an
    // empty table (corner-only box). A provider-bearing fixture would strengthen this.
    const { term } = await spawnCli({ argv: ["provider", "list"], fixture: "minimal-ts", mode: "tty" })
    await expect(term.screen).toContainText("┌", { timeout: 60_000 })
    expect(exitedCleanly(await waitExit(term))).toBe(true)
  })
})
