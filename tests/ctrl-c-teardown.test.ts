import { describe, test, expect, afterEach } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnCli, waitExit, until } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"
import { startMockBackend, type MockBackend } from "../src/tf-http-backend.js"
import { writeLockingTf, terraformInit, terraformApply } from "../src/raw-terraform.js"

// Headline regression target. Two related Ctrl-C concerns:
//  (R1) inquirer's ExitPromptError on Ctrl-C at the approval menu is NOT a non-TTY
//       error; if the command's catch only handles non-TTY errors it re-throws into
//       a void'd promise and cli-core's deploy promise hangs forever. The contract:
//       the process must TERMINATE and restore the cursor.
//  (#283) interrupting diff/deploy while terraform runs must let terraform shut down
//       gracefully so the state lock is RELEASED — open-constructs/cdk-terrain#283.
describe(`ctrl-c teardown [${currentCliId()}]`, () => {
  test("R1: Ctrl-C at the approval menu terminates (does not hang) + restores cursor", async () => {
    const { term } = await spawnCli({ argv: ["deploy"], fixture: "minimal-ts", mode: "tty", freshState: true })
    await expect(term.screen).toContainText("Please review the diff output above", { timeout: 120_000 })

    term.press("Ctrl+c") // \x03 → inquirer raises ExitPromptError

    const exit = await waitExit(term, 30_000)
    expect(exit, "deploy hung after Ctrl-C at the approval prompt").not.toBeNull()
    await expect(term.out).toContainOutput("\x1b[?25h", { timeout: 5_000 })
  })

  test("watch --auto-approve: Ctrl-C tears down and restores the cursor", async () => {
    const { term } = await spawnCli({
      argv: ["watch", "--auto-approve"],
      fixture: "minimal-ts",
      mode: "tty",
      freshState: true,
    })
    await expect(term.screen).toContainText("Waiting for changes", { timeout: 120_000 })

    term.press("Ctrl+c")

    const exit = await waitExit(term, 30_000)
    expect(exit, "watch hung on Ctrl-C").not.toBeNull()
    await expect(term.out).toContainOutput("\x1b[?25h", { timeout: 5_000 })
  })
})

// #283 state-lock coverage — hermetic, via the in-process Terraform HTTP backend mock.
//
// Research finding (terraform 1.7.5, empirically verified): the old "two interrupts →
// orphaned lock" contract NO LONGER holds — modern terraform still calls UNLOCK even on
// 2×SIGINT (the immediate-exit only SIGKILLs the *provider plugin*; core unwinds far
// enough to release the backend lock). The ONLY thing that orphans an EXTERNAL lock is
// SIGKILL (uncatchable death). So:
//   • POSITIVE CONTROL — raw terraform + SIGKILL mid-apply → lock orphaned (proves the
//     mock + assertions can actually detect an orphan).
//   • cdktn REGRESSION — `cdktn deploy` + a faithful keyboard Ctrl-C must RELEASE the
//     lock. cdktn would only orphan if it SIGKILLed terraform's tree on interrupt — the
//     true #283 root cause to audit upstream.
// Gate on `backend.currentLock()` (UI-independent): cdktn's StreamRenderer reformats
// terraform's "Still creating"/"Gracefully shutting down" lines so they don't render.
const LOCK_HOLD_SECONDS = 25

describe(`#283 state-lock release [${currentCliId()}]`, () => {
  let backend: MockBackend | undefined
  afterEach(async () => {
    await backend?.close()
    backend = undefined
  })

  // POSITIVE CONTROL: prove the mock detects an orphaned lock. Raw terraform (no cdktn)
  // holds the lock, then we SIGKILL it mid-apply so its deferred UNLOCK never runs.
  test("positive control: SIGKILL mid-apply orphans the lock (mock detects orphans)", async () => {
    const b = (backend = await startMockBackend())
    const dir = join(tmpdir(), "cdktn-e2e-283-sigkill")
    writeLockingTf(dir, b, 15)
    await terraformInit(dir)
    const child = terraformApply(dir)

    expect(await until(() => b.currentLock() !== null, 60_000),
      "lock never acquired by raw terraform").toBe(true)
    const t0 = Date.now()
    child.kill("SIGKILL") // uncatchable — terraform dies without unlocking
    await until(() => child.exitCode !== null || child.signalCode !== null, 10_000)
    await new Promise((r) => setTimeout(r, 1_000))

    expect(b.unlockedSince(t0), "SIGKILL must NOT release the lock").toBe(false)
    expect(b.currentLock(), "expected an ORPHANED lock after SIGKILL").not.toBeNull()
  })

  // cdktn REGRESSION GATE: a faithful keyboard Ctrl-C during apply must let terraform
  // shut down gracefully and release the lock — cdktn must NOT hard-kill terraform's
  // tree (that would orphan the lock = #283). With the positive control above proving
  // the mock catches orphans, this assertion now has teeth.
  test("cdktn: single Ctrl-C during apply releases the lock (no orphan)", async () => {
    const b = (backend = await startMockBackend())
    const { term } = await spawnCli({
      argv: ["deploy", "--auto-approve"],
      fixture: "locking-http-ts",
      mode: "tty",
      freshState: true,
      env: {
        TF_HTTP_ADDRESS: b.address,
        TF_HTTP_LOCK_ADDRESS: b.lockAddress,
        TF_HTTP_UNLOCK_ADDRESS: b.unlockAddress,
        LOCK_HOLD_SECONDS: String(LOCK_HOLD_SECONDS),
      },
    })
    expect(await until(() => b.currentLock() !== null, 120_000),
      "apply never reached the lock-held state").toBe(true)
    const interruptedAt = Date.now()
    term.press("Ctrl+c")

    const exit = await waitExit(term, 40_000)
    expect(exit, "deploy hung after Ctrl-C during apply").not.toBeNull()
    await new Promise((r) => setTimeout(r, 1_000))
    expect(b.unlockedSince(interruptedAt),
      "cdktn left the lock orphaned after Ctrl-C (SIGKILLed terraform? — #283)").toBe(true)
    expect(b.currentLock()).toBeNull()
  })
})
