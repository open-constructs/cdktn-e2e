import { describe, test, expect } from "vitest"
import { spawnCli, waitExit, exitedCleanly } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"

// Cheapest gate: proves provision → spawn → matcher → exit works for the selected
// CLI before any heavy synth/deploy. Runs against every matrix entry.
describe(`smoke [${currentCliId()}]`, () => {
  test("--version prints a semver and exits 0", async () => {
    const { term } = await spawnCli({ argv: ["--version"], fixture: "minimal-ts" })
    await expect(term.screen).toContainText(".", { timeout: 30_000 })
    const exit = await waitExit(term, 30_000)
    expect(exitedCleanly(exit)).toBe(true)
    // sanity: looks like a version line
    expect(term.screen.getText()).toMatch(/\d+\.\d+\.\d+/)
  })

  test("synth produces Terraform output and exits cleanly", async () => {
    const { term } = await spawnCli({ argv: ["synth"], fixture: "minimal-ts" })
    await expect(term.screen).toContainText("Generated Terraform code", { timeout: 90_000 })
    const exit = await waitExit(term, 90_000)
    expect(exitedCleanly(exit)).toBe(true)
  })
})
