import { describe, test, expect, afterEach } from "vitest"
import { spawnCli, waitExit } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"
import { startMockBackend, type MockBackend } from "../src/tf-http-backend.js"

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

// #283 reproduction — hermetic, via the in-process Terraform HTTP backend mock.
// Drives a real terraform apply that holds the state lock (terraform_data + sleep),
// interrupts it mid-flight, and asserts terraform was allowed to release the lock.
describe(`#283 state-lock release [${currentCliId()}]`, () => {
  let backend: MockBackend | undefined
  afterEach(async () => {
    await backend?.close()
    backend = undefined
  })

  test("interrupting deploy mid-apply releases the lock (no stale lock)", async () => {
    backend = await startMockBackend()
    const env = {
      TF_HTTP_ADDRESS: backend.address,
      TF_HTTP_LOCK_ADDRESS: backend.lockAddress,
      TF_HTTP_UNLOCK_ADDRESS: backend.unlockAddress,
      LOCK_HOLD_SECONDS: "25",
    }

    const { term } = await spawnCli({
      argv: ["deploy", "--auto-approve"],
      fixture: "locking-http-ts",
      mode: "tty",
      env,
      freshState: true,
    })

    // Wait until terraform is actually applying (lock acquired + sleep started).
    await expect(term.screen).toContainText("Still creating", { timeout: 120_000 })
    expect(backend.currentLock(), "lock should be held during apply").not.toBeNull()
    const interruptedAt = Date.now()

    term.press("Ctrl+c")

    // The whole point of #283: terraform must shut down gracefully and UNLOCK.
    await expect(term.screen).toContainText("Gracefully shutting down", { timeout: 20_000 })
    const exit = await waitExit(term, 30_000)
    expect(exit, "deploy hung after Ctrl-C during apply").not.toBeNull()

    // Give the UNLOCK request a beat to arrive, then assert the lock was released.
    await new Promise((r) => setTimeout(r, 1_000))
    expect(
      backend.unlockedSince(interruptedAt),
      "terraform was killed without releasing the state lock (issue #283)",
    ).toBe(true)
    expect(backend.currentLock()).toBeNull()
  })
})
