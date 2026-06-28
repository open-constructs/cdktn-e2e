import { describe, test, expect } from "vitest"
import { spawnCli, waitExit, exitedCleanly } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"

// The approval router driven with real arrow-key + Enter bytes over the PTY.
// freshState wipes cdktf.out so a prior test's tfstate/lock can't contaminate.
describe(`deploy approval routing [${currentCliId()}]`, () => {
  test("Approve (Enter on first choice) → apply proceeds", async () => {
    const { term } = await spawnCli({ argv: ["deploy"], fixture: "minimal-ts", mode: "tty", freshState: true })

    await expect(term.screen).toContainText("Please review the diff output above", { timeout: 120_000 })
    expect(term.screen).toContainText("Approve")

    term.press("Enter") // Approve is first → confirm. Fire-and-forget; assert below.

    await expect(term.screen).toContainText("Apply complete", { timeout: 180_000 })
    expect(exitedCleanly(await waitExit(term, 180_000))).toBe(true)
  })

  test("Dismiss (Down,Enter) → stack is not applied, process exits", async () => {
    // Single stack keeps the routing assertion deterministic: choosing Dismiss must
    // skip the apply and let the process exit. (Multi-stack cascade-blocking needs a
    // real apply-time dependency between resources — a separate, future test; here
    // the output-only stacks have no such edge, so a dismissed stack doesn't gate.)
    const { term } = await spawnCli({ argv: ["deploy"], fixture: "minimal-ts", mode: "tty", freshState: true })

    await expect(term.screen).toContainText("Please review the diff output above", { timeout: 120_000 })

    term.press("ArrowDown") // Approve → Dismiss
    term.press("Enter")

    const exit = await waitExit(term, 60_000)
    expect(exit, "deploy hung after Dismiss").not.toBeNull()
    expect(term.screen).not.toContainText("Apply complete")
  })

  test("--auto-approve runs unattended (no prompt rendered)", async () => {
    const { term } = await spawnCli({
      argv: ["deploy", "--auto-approve"],
      fixture: "minimal-ts",
      mode: "tty",
      freshState: true,
    })
    await expect(term.screen).toContainText("Apply complete", { timeout: 180_000 })
    expect(term.screen).not.toContainText("Please review")
    expect(exitedCleanly(await waitExit(term, 180_000))).toBe(true)
  })
})
