# Roadmap — open items

What this suite does **not** cover yet. Everything else (the four Ctrl-C/#283
tests, the in-process HTTP backend mock + SIGKILL positive control, the Verdaccio
prhead path, the HTML report + Pages deploy) is implemented — see
[DESIGN.md](./DESIGN.md) and [running-tests.md](./running-tests.md).

## 1. R1: the Ctrl-C-at-approval-prompt fix is still broken upstream

The e2e gate (`tests/ctrl-c-teardown.test.ts` → "Ctrl-C at the deploy approval
prompt …") asserts clean termination + cursor restore and currently **fails**
against the prhead fix build: cdktn's `StreamRenderer` `process.once('SIGINT', …)`
absorbs the interrupt before inquirer can raise `ExitPromptError`, so the patched
`catch` never runs (details in [DESIGN.md](./DESIGN.md#known-limitations)). The gate
stays red until the fix actually lands upstream. **Action:** keep watching; flip from
red→green is the signal the upstream fix works.

## 2. Upstream: assert cdktn signals terraform exactly once

The in-process HTTP backend already provides **real locking** over a **genuine
round-trip** — terraform runs its real HTTP-backend driver against a real socket
(real 200/404/423 + lock-info JSON), and the HTTP REST backend is itself a
first-class terraform backend (the one most TACOS expose). An orphan is detectable
(proven by the SIGKILL positive control), so there is **no backend-fidelity gap** —
swapping in S3+DynamoDB or Postgres would only change the storage substrate, not what
terraform sees.

The reason #283 can't be reproduced via keyboard input is terraform's signal
semantics, not the backend: on terraform ≥1.6 a faithful Ctrl-C (even `2×SIGINT`)
still UNLOCKs — only an uncatchable **SIGKILL** orphans the lock. So with a
correctly-behaving cdktn there's nothing the keyboard can do to orphan the lock; the
suite already covers this as a clean-teardown regression gate plus the SIGKILL
positive control.

The only piece left is **upstream of this repo**: a cdktn unit test asserting it
signals terraform **exactly once** on interrupt (the actual #283 contract at the
source level). `scripts/manual-verify.mjs` is the human ground-truth backstop today.

## 3. Migrate the HTML report to the native Vitest reporter (when 5.0 is GA)

`scripts/build-report.mjs` exists because Vitest 4.1 (our pin) has no single-file
offline HTML reporter. Vitest 5.0 adds `['html', { singleFile: true }]` and the
`context.annotate(msg, type, { body, contentType })` attachment API (3.2+) renders
inline. When 5.0 is **GA** (not beta — we don't pin a beta in a nightly regression
harness), wire `src/setup.ts`'s screenshot-on-failure to `context.annotate(...)` and
drop most of `build-report.mjs`. `@termless/test` already peers `vitest >=2.0.0`.

## 4. Confirm what cdktn-cli's own unit tests simulate

The upstream PR added unit tests for the Ctrl-C handling. Confirm whether they drive
a **real `\x03` keypress** through inquirer or merely throw `ExitPromptError`
directly. If the latter, the "keyboard Ctrl-C → ExitPromptError" link is validated
nowhere — worth flagging upstream.

## Parking lot

- **termless feature request:** expose `pid` + `sendSignal(signal)` on `Terminal`
  (today only `press()` / `close()` exist). Would enable a real-SIGINT *diagnostic*
  for fidelity probes. Rated not-needed for the current tests — `press("Ctrl+c")` is
  the faithful primary mechanism — so this is a parking-lot note, not a task.
