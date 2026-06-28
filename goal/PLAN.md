# Plan: #283 two-Ctrl-C control test — and an honest audit of whether this e2e suite can validate Ctrl-C at all

## Context

Two things prompted this plan:

1. The existing Ctrl-C tests only ever send **one** `\x03` (`term.press("Ctrl+c")`). The "two Ctrl-C = hard kill" path central to #283 is never exercised. We want a second, complementary test that proves a *genuine* double-interrupt is required for a hard kill — so the single-Ctrl-C graceful test is meaningful, not luck.

2. A separate agent's prhead BEFORE/AFTER validation surfaced a **methodology finding** that forces us to answer a more fundamental question first: *can this PTY harness actually simulate a Ctrl-C the way manual testing would, and validate the CLI's response?* For one of the two Ctrl-C behaviors (the approval-prompt fix, "R1") the answer is currently **no** — and that misses the whole point of the suite. This plan flags that explicitly rather than hiding it behind "the unit tests cover it."

The suite's purpose is to **replace manual TTY testing**. Anywhere it can't, we say so loudly.

---

## Why two Ctrl-C? terraform/tofu's two-stage interrupt contract

This is the heart of #283. Terraform (and OpenTofu, an identical fork) deliberately treat the **first** and **second** interrupt differently. The CLI counts SIGINTs on its `ShutdownCh`:

- **1st SIGINT (one Ctrl-C) → graceful shutdown.** Terraform prints:
  > `Interrupt received.`
  > `Please wait for Terraform to exit or data loss may occur.`
  > `Gracefully shutting down...`
  
  It cancels the operation context and asks providers to `Stop`, but **lets the in-flight resource operation finish**, then **writes state and releases the backend lock (UNLOCK)** before exiting. This is the safe path: no orphaned lock.

- **2nd SIGINT (a second Ctrl-C, *while* the graceful shutdown is still in progress) → immediate hard exit.** Terraform prints:
  > `Two interrupts received. Exiting immediately.`
  > `Note that data loss may have occurred.`
  
  It terminates *now*, in the middle of the in-flight op — **skipping the state write and the UNLOCK**. The backend lock is left **held/orphaned**, so the next run fails with `Error acquiring the state lock` until a manual `force-unlock`.

So the lock-release outcome is a **direct function of how many SIGINTs reach terraform**: exactly one → released; two (or a SIGKILL) → orphaned. That is the entire mechanism of #283.

### How #283 (and its prior-art twin) breaks this

The bug is a **wrapper turning one user Ctrl-C into two signals to terraform.** cdktn #283: the CLI re-signalled terraform on abort, so a single user Ctrl-C escalated straight to the "Two interrupts received → exit immediately" path → orphaned lock.

This is not novel — **Terragrunt had the identical bug** and it's the clearest external confirmation of the mechanism:
- [terragrunt#2120 "Send ctrl+c one time but terragrunt send twice to terraform"](https://github.com/gruntwork-io/terragrunt/issues/2120): one Ctrl-C → terragrunt forwarded SIGINT twice → terraform hit "Two interrupts received" → **state lock left locked** (and state hash mismatches). Fixed in terragrunt PR #2559.
- [terragrunt#5170](https://github.com/gruntwork-io/terragrunt/issues/5170) / [#5167](https://github.com/gruntwork-io/terragrunt/issues/5167): a variant where context-cancel sent **SIGKILL within ~3ms** of "Gracefully shutting down...", before tofu could release the lock → orphaned GCS/S3 lock. Same outcome, different escalation.

A subtle but important point about signal delivery over a real terminal: a single Ctrl-C in **cooked mode** is delivered by the line discipline as **one** SIGINT to the **whole foreground process group** — so terraform (a child in that group) already receives exactly one. A correct wrapper does nothing extra. The #283 bug is the wrapper *adding* a signal on top of that group delivery.

### Why the test sends Ctrl-C twice on purpose

The single-Ctrl-C test (existing) asserts the **graceful** outcome (UNLOCK). But on its own it can't tell *graceful because terraform got exactly one SIGINT* from *graceful by luck / a lenient environment*. The two-Ctrl-C **control** test pins the other half of terraform's documented contract:

1. **Establishes the baseline** that two genuine interrupts *do* produce the hard-kill + orphaned-lock outcome in this hermetic harness — proving the single-Ctrl-C graceful result is meaningful, not coincidental, and that the harness can actually reach the hard-kill path.
2. **Reproduces the #283 failure mode deliberately** (stale lock) so the mock's `unlockedSince`/`currentLock` assertions are exercised in both directions.
3. **Guards an over-correction:** a "fix" that swallowed *all* interrupts to protect the lock would also be wrong — the user must still be able to force-quit with a second Ctrl-C. The two-Ctrl-C test fails if that ability regresses.

Timing matters: terraform only escalates to "Two interrupts received" if the second SIGINT lands **while it is still gracefully shutting down** (finishing the in-flight op). That's why the test sequences the second Ctrl-C *after* the `"Gracefully shutting down"` line appears and while the fixture's `local-exec` sleep is still holding the lock — exactly the window the bug lives in.

Sources: [terraform#30918](https://github.com/hashicorp/terraform/issues/30918), [terragrunt#2120](https://github.com/gruntwork-io/terragrunt/issues/2120), [terragrunt#5170](https://github.com/gruntwork-io/terragrunt/issues/5170), [terragrunt#5167](https://github.com/gruntwork-io/terragrunt/issues/5167).

---

## Primer: what "Ctrl-C" actually is (plain terms)

A real keyboard Ctrl-C sends **one byte: `0x03`** ("ETX") into the terminal. A PTY (pseudo-terminal) has a kernel **line discipline** between that byte and the program, with a switch called **ISIG**:

- **ISIG on = "cooked" mode (the default).** The line discipline *eats* the `\x03` and instead delivers a **SIGINT signal** to the foreground process group. This is the classic "Ctrl-C interrupts the program (and its children)."
- **ISIG off = "raw" mode.** Programs that read individual keystrokes (menus, prompts, editors) flip ISIG off so they can *see* the `\x03` byte themselves. Now Ctrl-C generates **no signal** — it's just a byte, and it's entirely up to the program to notice it and decide to quit.

Two ways a test could "send Ctrl-C", and they are **not equivalent**:

- **`term.press("Ctrl+c")`** writes exactly the one `\x03` byte to the PTY master — **byte-identical to a real keyboard.** What happens next (SIGINT vs. raw byte) is decided by whatever mode the program is in, *exactly as on a real terminal.* This is the faithful simulation.
- **A direct `process.kill(pid, "SIGINT")`** skips the byte and the line discipline and *forces* the signal. A keyboard never does this; it only matches the cooked-mode *outcome*. Useful as a **diagnostic**, but dangerous as a way to make a raw-mode test "pass" — it would be a false green (a real user's Ctrl-C wouldn't take that path).

`src/harness.ts:116` spawns over a node-pty-backed terminal; `term.press("Ctrl+c")` → `\x03`. There is **no** signal/pid API in the harness today.

---

## Determination: CAN we simulate Ctrl-C over PTY? (yes — with one important caveat)

**Yes, `press("Ctrl+c")` is a faithful Ctrl-C** — it sends the same byte the keyboard sends. The outcome then depends on the command's terminal mode, *just like a real terminal*:

| Scenario | Mode during the command | `press("Ctrl+c")` result | Can e2e validate it? |
| --- | --- | --- | --- |
| **#283** — interrupt mid `deploy --auto-approve` (terraform apply streaming, no prompt) | **cooked** unless the CLI itself flips raw (it isn't reading keystrokes) | `\x03` → line discipline → **group SIGINT** → terraform "Gracefully shutting down" + UNLOCK | **Yes** (default mode confirmed; one live run to confirm the CLI doesn't flip raw) |
| **R1** — Ctrl-C at the inquirer approval menu | **raw** (inquirer calls `setRawMode(true)`, ISIG off) | `\x03` delivered as a byte; this inquirer bundle ignores it (raises `ExitPromptError` only from a *process* SIGINT, which raw mode suppresses) → **hang in both BEFORE/AFTER builds** | **Not currently** — see the flagged gap |

So the setup is **not "wrong"** for sending Ctrl-C. It faithfully reproduces what the keyboard does. The split is real terminal behavior: cooked-mode interrupts work over PTY; raw-mode prompts depend on the app, and this app's prompt doesn't act on the `\x03` byte.

> **Validated against installed source.** `@termless/core@0.7.0` spawns via **node-pty 1.1.0** (`forkpty`), and node-pty hardcodes the slave PTY to **cooked mode with `ISIG` on and `VINTR = 3` (`\x03`)** (`node_modules/.pnpm/node-pty@1.1.0/.../src/unix/pty.cc:316-333`). termless never calls `setRawMode`/`cfmakeraw`. So unless the *child* (cdktn/inquirer) flips raw mode, a written `\x03` **is** turned into a group SIGINT by the line discipline — exactly the #283 cooked-mode assumption, now confirmed at the source level. The only residual unknown is whether cdktn enables raw mode during `apply` (verification Q1).

---

## ⚠️ FLAG: the e2e suite does NOT currently validate the R1 (Ctrl-C-at-prompt) fix

This is a coverage gap that defeats the suite's purpose for one behavior, and it must be called out — not silently delegated to unit tests:

- `press("Ctrl+c")` faithfully sends `\x03`, but inquirer's raw mode means no SIGINT, and this bundle's `ExitPromptError` is wired only to a *process* SIGINT — so the prompt hangs in **both** the fixed and unfixed builds. The fix's `catch` in `deploy.ts` is never reached by the harness.
- The agent also tried a **real** SIGINT to the child: it exits (~3s) but via an **AbortController** path, *still not* the `ExitPromptError` catch. So in this environment **no external interrupt reaches the code the fix changed.**
- Therefore: **switching R1 to a forced SIGINT just to make it green would be a false pass** — it would assert termination via a path a real keyboard Ctrl-C does not take in raw mode. We will not do that.

We do **not yet know** which of these is true, and the difference matters:

- **(a) The harness is unfaithful** — a real terminal/Node would turn the prompt's Ctrl-C into something the CLI handles, and our node-pty/Node wiring doesn't reproduce it. → Fix the harness so R1 becomes a real gate.
- **(b) The harness is faithful** — a real user pressing Ctrl-C at this prompt *also* hangs, meaning the fix doesn't cover keyboard Ctrl-C at the prompt. → The e2e correctly caught a remaining product gap; report it.

Until this is resolved, **DESIGN.md must not claim the e2e suite is the R1 regression gate**, and we must state plainly that R1's prompt-Ctrl-C behavior is, for now, **unvalidated black-box**. (The cdktn-cli commit added unit tests, but we must also confirm whether those simulate a real `\x03` keypress or merely throw `ExitPromptError` directly — if the latter, the "keyboard Ctrl-C → ExitPromptError" link is validated *nowhere*.)

---

## Verification questions to resolve (in order, before/at implementation)

1. **Does #283 single-Ctrl-C work today?** Run the existing `#283 state-lock release` test on `cdktn-next`. Confirm the screen shows `"Gracefully shutting down"` and the mock records an UNLOCK (`backend.unlockedSince` true, `currentLock()` null). 
   - **Yes** → cooked-mode `\x03` is faithful and sufficient; build the two-Ctrl-C test as designed below with `press("Ctrl+c")`.
   - **No / hangs** → apply may not be cooked; fall back to the diagnostic SIGINT helper and re-evaluate faithfulness (same investigation as R1).
2. **R1 reality check (one manual run, unavoidable here):** on the AFTER build, run `cdktn deploy` in a real terminal and press Ctrl-C at the approval prompt. Exits cleanly + restores cursor, or hangs?
   - **Exits** → production handles it; our PTY is unfaithful → investigate Node `readline` SIGINT re-raise / raw-mode handling / node-pty termios; fix the harness, then R1 e2e becomes a true gate.
   - **Hangs** → fix is incomplete for keyboard Ctrl-C; file the finding. e2e was right.
3. **What do the cdktn-cli unit tests actually drive?** A real `\x03` keypress through inquirer, or a hand-thrown `ExitPromptError`? If the latter, flag that the keyboard→ExitPromptError path is untested at every level.

---

## #283 two-Ctrl-C control test (the additive work, gated on Q1 = yes)

All changes inside the existing `describe(\`#283 state-lock release [${currentCliId()}]\`)` block in `tests/ctrl-c-teardown.test.ts`. No mock changes — `backend.currentLock()` / `backend.unlockedSince(ts)` already suffice. Use **faithful `press("Ctrl+c")`** (the realistic cooked-mode keyboard interrupt), *not* a forced SIGINT.

### 1. Hoist the hold constant + extract the shared prefix

```ts
const LOCK_HOLD_SECONDS = 25

// Spawn an apply that holds the lock, reach mid-apply, send ONE Ctrl-C (faithful
// \x03 → group SIGINT in cooked mode), and wait until terraform reports it is
// shutting down gracefully. The two tests diverge after this point.
async function applyThenInterruptOnce(backend: MockBackend) {
  const env = {
    TF_HTTP_ADDRESS: backend.address,
    TF_HTTP_LOCK_ADDRESS: backend.lockAddress,
    TF_HTTP_UNLOCK_ADDRESS: backend.unlockAddress,
    LOCK_HOLD_SECONDS: String(LOCK_HOLD_SECONDS),
  }
  const { term } = await spawnCli({
    argv: ["deploy", "--auto-approve"], fixture: "locking-http-ts",
    mode: "tty", env, freshState: true,
  })
  await expect(term.screen).toContainText("Still creating", { timeout: 120_000 })
  expect(backend.currentLock(), "lock should be held during apply").not.toBeNull()
  const interruptedAt = Date.now()
  term.press("Ctrl+c") // 1st SIGINT → terraform begins graceful shutdown
  await expect(term.screen).toContainText("Gracefully shutting down", { timeout: 20_000 })
  return { term, interruptedAt }
}
```

### 2. Existing single-Ctrl-C test → consume the helper (functionally unchanged; it stays the #283 gate)

```ts
test("single Ctrl-C lets terraform shut down gracefully and release the lock (#283)", async () => {
  backend = await startMockBackend()
  const { term, interruptedAt } = await applyThenInterruptOnce(backend)
  const exit = await waitExit(term, 30_000)
  expect(exit, "deploy hung after Ctrl-C during apply").not.toBeNull()
  await new Promise((r) => setTimeout(r, 1_000))
  expect(backend.unlockedSince(interruptedAt),
    "terraform was killed without releasing the state lock (issue #283)").toBe(true)
  expect(backend.currentLock()).toBeNull()
})
```

### 3. New two-Ctrl-C hard-kill control test (minimal scope per earlier decision)

Second `press("Ctrl+c")` is sequenced **after** `"Gracefully shutting down"`, so it lands while terraform is still finishing the in-flight op — exactly when a second interrupt forces hard termination.

```ts
test("two Ctrl-C hard-kills terraform mid-shutdown and leaves the lock held (control)", async () => {
  backend = await startMockBackend()
  const { term, interruptedAt } = await applyThenInterruptOnce(backend)

  term.press("Ctrl+c") // 2nd SIGINT during shutdown → hard terminate

  const exit = await waitExit(term, 15_000)
  expect(exit, "second Ctrl-C did not terminate the CLI").not.toBeNull()
  // Hard kill aborts mid-sleep, far faster than the ~LOCK_HOLD_SECONDS graceful path.
  expect(Date.now() - interruptedAt,
    "exit too slow to be a hard kill (looks like graceful completion)")
    .toBeLessThan(LOCK_HOLD_SECONDS * 1000)
  // No UNLOCK should ever arrive; lock left stale (terraform's 2×-interrupt behavior).
  await new Promise((r) => setTimeout(r, 1_000))
  expect(backend.unlockedSince(interruptedAt),
    "lock was unexpectedly released after a hard kill").toBe(false)
  expect(backend.currentLock(), "expected a stale lock after the hard kill").not.toBeNull()
})
```

No exit-code/signal assertion (env-dependent; DESIGN.md already flags string uncertainty). `.not.toBeNull()` + the timing bound is the robust discriminator.

---

## Harness change (diagnostic only — NOT the primary interrupt mechanism)

**Validated against the installed `@termless/core@0.7.0` source** (`node_modules/@termless/core/dist/backends-*.mjs`):

- `term.press("Ctrl+c")` writes **exactly one byte, `0x03`**, to the PTY master via node-pty's `ptyProcess.write` (`parseKey` → `keyToAnsi`: `'c'.charCodeAt(0)-96 = 3` → `String.fromCharCode(3)`). This is byte-identical to a keyboard — **the faithful Ctrl-C is confirmed.**
- The child is spawned with **node-pty** (`pty.spawn`, lazy `require("node-pty")`); on Bun, `Bun.spawn({terminal})`. No `detached`/`setsid` is set by termless — node-pty's `forkpty` makes the child a new-session controlling-terminal leader inherently.
- **There is NO pid and NO signal API on the public `Terminal` (or its internal `ptyHandle`).** node-pty's `IPty.pid` / `IPty.kill(signal)` exist one layer deeper but are **not surfaced** by termless. The only kill path is `term.close()`, which is hardcoded to **SIGTERM, then SIGKILL after 2s**, aimed at the **direct child only** (the node CLI), not configurable, not the process group.

**Consequence:** a diagnostic "send a real SIGINT" helper **cannot be added in `harness.ts` alone** — termless gives us no pid and no signal method. Options, in order of preference:

1. **Don't add it.** Rely on `press("Ctrl+c")` (faithful) for all interrupt tests; this is correct for the cooked-mode #283 path. (Preferred if Q1 confirms `\x03`→graceful works.)
2. If a real-SIGINT diagnostic is genuinely needed (Q1-fallback / R1 fidelity probe), reach node-pty directly — e.g. a thin termless patch/fork exposing `pid`, or load `node-pty` in the harness and capture the `IPty` to call `.kill("SIGINT")` / `process.kill(-pid, "SIGINT")` for group delivery. This is the reach-around the prhead agent had to do, and it's a **harness/termless limitation to raise upstream** (feature request: expose `pid` + `sendSignal(signal)` on `Terminal`).

This confirms the plan's core stance: `\x03` is the faithful primary mechanism; a forced signal is a non-trivial, diagnostic-only escape hatch — never a way to make a raw-mode test green.

---

## DESIGN.md updates (honest, no glossing)

- **State-lock release (#283)** row: note both directions — single Ctrl-C ⇒ `Gracefully shutting down` + UNLOCK; **two** Ctrl-C ⇒ hard kill + stale lock (control).
- **Ctrl-C hang (R1)** row: **downgrade** from "the regression gate" to an explicit gap statement — the prompt's Ctrl-C runs in inquirer raw mode, so `\x03` produces no SIGINT and even a forced SIGINT misses the `ExitPromptError` catch; **the e2e suite cannot currently validate this fix**, and forcing a SIGINT to go green would be a false pass. Cross-reference the verification questions.
- **Open items**: add (1) confirm `\x03`→graceful on a live #283 run; (2) resolve whether R1's prompt-Ctrl-C hang is a harness-fidelity bug or a real product gap; (3) confirm what the cdktn-cli unit tests actually simulate.

---

## Verification (of this change)

1. `pnpm test tests/ctrl-c-teardown.test.ts` against `cdktn-next` (provision first; `manifest.json` must exist — `scripts/provision.mjs`).
2. #283 single test: `"Gracefully shutting down"` + UNLOCK (`unlockedSince` true, `currentLock()` null). **If this fails, stop — the whole `\x03` approach for #283 needs the fidelity investigation before the two-Ctrl-C test is meaningful.**
3. #283 control test: exits fast (≪ 25s), `currentLock()` non-null, no UNLOCK.
4. Optional directional check: a #283-buggy build (e.g. `cdktf-prefork`) should fail the **single** test (stale lock) while the control test still passes.
5. R1: do **not** mark validated until Q2 is answered.
