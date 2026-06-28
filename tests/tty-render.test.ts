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

  test("provider list: renders a cli-table3 with the declared providers", async () => {
    // provider-list-ts declares hashicorp/random + hashicorp/null in cdktf.json;
    // `provider list` reads the config directly (no download), so we get a real,
    // non-empty bordered table with header + one row per provider.
    const { term } = await spawnCli({ argv: ["provider", "list"], fixture: "provider-list-ts", mode: "tty" })
    await expect(term.screen).toContainText("Provider Name", { timeout: 60_000 })
    expect(term.screen).toContainText("random")
    expect(term.screen).toContainText("null")
    expect(term.screen).toContainText("─") // horizontal rule — proves a non-empty table
    expect(exitedCleanly(await waitExit(term))).toBe(true)
  })
})
