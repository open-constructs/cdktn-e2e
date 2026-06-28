# Design — cdktn-cli-e2e

## Goal

A repository **separate from `open-constructs/cdk-terrain`** that continuously
validates CLI **behaviour** — TTY/UX rendering, prompt routing, non-interactive
contract, and library synth output — against **published preview releases**, on a
**nightly schedule and on demand**, so this expensive coverage never weighs down
the upstream per-PR pipeline (which was deliberately trimmed from 4h+ to <1h via
conditional execution and parallelism).

It is the destination for "heavy testing moved to nightly": CLI behaviour first
(driven by the `node-pty` removal and the Ink/React → inquirer TUI rewrite), with
room to absorb more upstream CI over time.

## Why termless

The rewrite ([PR #264](https://github.com/open-constructs/cdk-terrain/pull/264))
changed behaviour that **only exists under a real TTY**: a `cli-spinners` status
bar, a `StreamRenderer` log-above/bar-below repaint, `cli-table3` tables, and
`@inquirer/prompts` arrow-key approval menus. The upstream suite spawns the CLI
with `stdio: "pipe"` + `CI=1`, which strips all of that — so these regressions are
invisible to it by construction.

termless spawns the binary over a **PTY** (so the child sees `isTTY === true`),
feeds bytes into a headless xterm.js emulator, and exposes Playwright-style
`expect(where).matcher()` assertions over the screen grid, cell styling, cursor,
and the raw escape stream. That is the missing capability.

```
vitest ── @termless/test (matchers) ── @termless/core Terminal ── node-pty (PTY)
                                                                      │ isTTY=true
                                                          cdktn binary ─ fixture app
   assert: term.screen / term.out / term.cell / term.exitInfo        │
                                                          cdktf.out/…/cdk.tf.json
```

Verified termless API used by the harness (`@termless/core@0.7.0`,
`@termless/xtermjs@0.4.0`, `@termless/test@0.4.0`):
`createTerminal({backend,cols,rows})`, `term.spawn(argv[], {cwd,env})`,
`term.press("Ctrl+c"|"ArrowDown"|"Enter")`, `term.type()`, `term.out`,
`term.screen`/`row`/`cell`, `term.exitInfo` (`"exit=<code>" | null`),
`term.screenshotSvg()`. Matchers import side-effect: `@termless/test/matchers`.

## Independence from cdk-terrain

This repo pins its **own** Node and toolchain, decoupled from cdk-terrain's
`.nvmrc` (22.22.3): we consume the CLI as a **prebuilt npm artifact** (its bundle
targets node22 at runtime but runs fine on newer Node), so the test runner's Node
is free to be whatever **termless** requires — and termless requires it. All
`@termless/*` packages declare `engines.node >= 23.6.0` (native TS + `using`
disposal), so `.nvmrc` is pinned to **24** (current LTS, satisfies the floor).

The dropped-in `mise.toml` enables `.nvmrc` as the idiomatic Node version file
(`idiomatic_version_file_enable_tools = ["node", "pnpm"]`) and pins no `node` in
`[tools]`, so mise provisions Node from `.nvmrc`. It also pins `terraform = 1.7.5`,
which the synth/deploy/lock tests use. Run via `mise exec -- <cmd>` if the mise
shim isn't on PATH.

## Version matrix (regression comparison)

The same tests run against each channel by selecting `CLI_ID`; a regression is the
same assertion flipping between channels.

| `CLI_ID`        | binary               | resolved at scaffold | bin   | library | purpose |
| --------------- | -------------------- | -------------------- | ----- | ------- | ------- |
| `cdktf-prefork` | `cdktf-cli`          | `0.21.0`             | cdktf | cdktf   | pre-fork Ink baseline — the UX the rewrite departs from |
| `cdktn-latest`  | `cdktn-cli@latest`   | `0.23.3`             | cdktn | cdktn   | last stable — "known good" the preview must not regress |
| `cdktn-next`    | `cdktn-cli@next`     | `0.24.0-pre.60`      | cdktn | cdktn   | **preview, primary nightly target** |
| `cdktn-prhead`  | local checkout       | `pnpm pack` of PR    | cdktn | cdktn   | unmerged PR validated pre-merge |

Fixtures are framework-agnostic: `main.ts` imports from `__FRAMEWORK__`, which
`provision.mjs` rewrites to `cdktf` or `cdktn` so the *same* app validates across
the fork boundary.

### Provision/run split

`scripts/provision.mjs` is the **only** network/build step. It installs a CLI into
`.sandboxes/<id>/` (npm install, or `pnpm pack` for a PR head), prepares fixtures,
and writes `manifest.json`. Tests read the manifest — they spawn an absolute bin
path and never hit the network. This keeps test execution pure, fast, and trivially
parallelisable across `CLI_ID`s in CI.

The preview channel was confirmed live: every merge to `main` runs cdk-terrain's
`prepare-next` job (`standard-version --prerelease pre`) and publishes
`cdktn-cli@next` (+ `cdktn@next`, `@cdktn/*@next`) to npm via `publib-npm` (OIDC).

## Triggers

`nightly.yml`:
- **schedule** `0 3 * * *` → `decide` job runs `check-new-preview.mjs`: queries
  `npm view cdktn-cli@next version`, compares to `state/last-tested.json`, and
  **skips the whole matrix when the preview hasn't moved** (the requested cron
  diff-detection).
- **workflow_dispatch** → choose `CLI_ids`; `force` defaults true (always run).
  **This is the flake-retrigger path**: a suspected-flaky failure is re-run by
  dispatching with `force=true` (bypasses the marker). The cron never auto-retries.

### Run-once policy

Each `@next` version is tested **once**. `record-state` advances the marker
whether tests **passed or failed** (so long as the suite ran), so the cron does not
re-run a failed version every night — a real regression would otherwise reproduce
nightly forever, indistinguishable from a flake. Instead:
- The `report` job opens/updates **one dedup'd GitHub issue per `cli_id`**
  (`scripts/report-issue.mjs`, via `gh`) listing the failing tests + run link, and
  **auto-closes** it when a later version goes green.
- Every leg writes a pass/fail **step summary** (`scripts/step-summary.mjs`).
- Suspected flakes are re-run by hand via `workflow_dispatch force=true`.

Rationale: the residual flake surface here is small (no provider downloads — local
backend + `terraform_data`; deterministic spawn after the `spawn-helper` chmod fix),
so the genuinely transient cases (npm/registry blips, slow-runner timeouts, runner
death) are better handled by a human re-trigger than by masking regressions.
- Matrix: `{ubuntu-latest, macos-latest} × {cdktn-next, cdktn-latest}` (add
  `cdktf-prefork` for cross-fork UX deltas). **All three OSes** run a real PTY:
  Unix PTY on linux/macOS, **Windows ConPTY** via node-pty 1.1 (Win10 1809+;
  winpty support was removed) — so the inquirer/cli-spinners/cli-table3 rendering
  is validated on Windows terminals too. `cdktf-prefork` is excluded on Windows
  (old `cdktf-cli@0.21.0` on Node 24/Windows is a noise source; the cross-fork UX
  baseline is a linux/macOS concern). `pr-validation.yml` stays linux/macOS only
  because the PR-head path builds the jsii monorepo, which is impractical on Windows.

`pr-validation.yml` (manual): checks out a cdk-terrain PR head, builds + packs
`cdktn-cli`, provisions `cdktn-prhead`, runs the suite. This is the "validate a PR
before merge" path the brief calls for.

## Regression targets this suite is built to catch

| Area | Test | What it pins |
| ---- | ---- | ------------ |
| Spinner/cursor hygiene | `tty-render` | cursor hide `\x1b[?25l` → permanent summary → cursor restore `\x1b[?25h` |
| Table rendering | `tty-render` | cli-table3 border glyphs; columned `list` |
| Approval routing | `deploy-approve` | Approve/Dismiss/`--auto-approve` via real arrow+Enter bytes |
| Non-TTY contract | `non-tty` | `CI=1` ⇒ zero ANSI, no hang, clean exit (the old Ink "Raw mode" crash) |
| Library output | `synth-golden` | normalized `cdk.tf.json` snapshot per channel; sensitive-output redaction |
| **Ctrl-C hang (R1)** | `ctrl-c-teardown` | inquirer ExitPromptError must terminate + restore cursor, not hang core-cli. Addressed by a follow-up PR — this is the regression gate. |
| **State-lock release (#283)** | `ctrl-c-teardown` | interrupting apply must let terraform `Gracefully shutting down` and UNLOCK |

## Testing state-lock release (#283) hermetically

[Issue #283](https://github.com/open-constructs/cdk-terrain/issues/283): Ctrl-C
during `diff`/`deploy` kills terraform without a graceful shutdown, leaving the
state lock held so the next run fails to acquire it. Faithful reproduction needs a
**locking** backend. Three options, cheapest first:

1. **In-process Terraform HTTP backend mock (default, implemented).**
   `src/tf-http-backend.ts` is a ~120-line Node HTTP server modelling the same REST
   surface as the Go reference at
   `grid/cmd/gridapi/internal/server/tfstate.go` —
   `GET/POST /tfstate/{guid}`, `LOCK`/`UNLOCK .../lock|unlock` (PUT fallback), 423 +
   lock-info JSON when held. The `locking-http-ts` fixture points an `http` backend
   at it and uses a built-in `terraform_data` + `local-exec sleep` to hold the lock
   during apply (no provider download, no cloud). The test interrupts mid-apply and
   asserts an **UNLOCK arrived after the interrupt** (`backend.unlockedSince`) — the
   bug shows up as a missing UNLOCK / lingering lock. Fully deterministic in CI.
2. **docker-compose Postgres backend.** Terraform's `pg` backend gives real lock
   semantics. Heavier (a service container) but exercises a production backend path.
3. **Real AWS (S3 + DynamoDB lock).** Highest fidelity, needs creds + cleanup;
   reserve for a periodic deep run, not every nightly.

## Open items to verify on first live run

These are asserted from the PR description / docs and should be confirmed against
real output, then tightened into exact matchers/snapshots:

- Exact prompt/result strings: `"Please review the diff output above"`,
  `"Generated Terraform code"`, `"Apply complete"`, `"Waiting for changes"`,
  terraform's `"Still creating"` / `"Gracefully shutting down"`.
- Whether `cdktf-prefork` (Ink) emits equivalent strings — if not, gate the
  cross-fork lane to the byte-level/cursor assertions it shares.
- `HttpBackend` option names (`lockMethod`/`unlockMethod`) across cdktf vs cdktn.
- node-pty native build on the macOS runner (Linux runners have build-essential).
- Windows ConPTY: node-pty ships win32 prebuilds (no compiler needed). The bin is
  spawned as `node <bin-js>` (not the `.bin/*.cmd` shim) for cross-platform spawn;
  the `postinstall` chmod of the posix `spawn-helper` is skipped on Windows.

## Known limitations (to fix later)

1. **`cdktn-prhead` sibling fidelity.** `pnpm pack` of `cdktn-cli` yields a tarball
   whose workspace deps (`@cdktn/cli-core`, `@cdktn/hcl*`, …) are pinned at `0.0.0`,
   which isn't on npm; provision overrides them to the published `@next` line so the
   standalone install resolves. This is faithful **only for changes inside
   `cdktn-cli` itself** (where PR #264's UI rewrite lives). If a PR also changes a
   sibling `@cdktn/*` package, the prhead run silently tests the published sibling,
   not the PR's. Fix later: pack+install all changed workspace packages, or run the
   bin directly out of the monorepo's own `node_modules` (workspace-resolved).
2. **Sending Ctrl-C is a raw byte, not a signal — and that is faithful.** termless
   exposes no `kill(signal)`; `press("Ctrl+c")` writes `\x03` to the PTY, byte-for-byte
   what a keyboard sends. The outcome depends on the program's terminal mode, exactly
   as on a real terminal:
   - **At the inquirer prompt (raw mode):** `\x03` is delivered as a keypress; Node
     `readline` fires `rl.on('SIGINT')`, which `@inquirer/core` wires to
     `reject(new ExitPromptError(...))`. **Confirmed by isolated repro** — a plain
     `@inquirer/prompts` `select` spawned over termless, then `press("Ctrl+c")`, exits
     with `ExitPromptError`. So **R1 _is_ validatable** by the harness; the earlier
     "can't validate" was an nx-cache-contaminated prhead build (stale AFTER bundle).
   - **During `deploy --auto-approve` (cooked mode):** node-pty hardcodes the slave
     PTY to cooked/ISIG-on/`VINTR=3`, so `\x03` → line-discipline → **group SIGINT**.
     But cdktn **intercepts** that SIGINT (its own `AbortError`) and tears terraform
     down cleanly, so terraform always reaches UNLOCK.
3. **The in-process HTTP-backend mock does NOT reproduce #283.** Verified: a single
   Ctrl-C during apply releases the lock on `cdktn-next` AND on `cdktn-latest@0.23.3`
   (the exact version #283 was reported against) — and even a *double* Ctrl-C releases
   it (cdktn's SIGINT interception never lets terraform hit the two-interrupt hard-kill
   path). So the mock-based "#283 gate" has **no discrimination power** for the orphaned
   lock and was re-scoped to an honest **clean-teardown smoke** (Ctrl-C during apply
   must terminate without hanging and release the lock); the two-Ctrl-C control is
   `test.skip`. Faithful #283 reproduction needs a **real locking backend** where
   terraform can be hard-killed before unlocking (docker Postgres `pg` backend, or AWS
   S3+DynamoDB) — that, plus `scripts/manual-verify.mjs`, is the way to verify #283.
   (Earlier "stalls at Initializing the backend" was a *test* bug — waiting on
   `"Still creating"` screen text cdktn never renders; fixed by gating on the mock's
   `currentLock()`.)

## HTML report + GitHub Pages

`scripts/build-report.mjs` turns **one** run's `reports/ci-report.json` (+
`artifacts/` SVG/text) into a single self-contained HTML report (inline CSS/JS,
embedded SVGs, no CDNs). The nightly `pages` job builds one such report **per matrix
leg** (`_site/<os>-<cli_id>/index.html`) and a generated landing page
(`scripts/build-index.mjs` → `_site/index.html`) that links to each leg with a
pass/fail summary, then deploys the whole `_site/` to GitHub Pages via the **Actions
build mode** on every cron/manual run. See `guides/running-tests.md` for usage and
the one-time Pages setting.

**No cross-leg data aggregation — by design.** An earlier version aggregated every
`reports/raw/<id>/*.json` into a single cross-channel matrix; that was removed. Each
report is built independently on a fresh CI artifact (nothing to merge), because the
aggregation silently resurfaced stale runs (an old `posix_spawnp`-broken run overrode
a fresh pass). The Pages landing page *links* the per-leg reports rather than merging
their data, so comparison stays per-leg and honest.

**Why a custom builder (and when to retire it).** On Vitest 4.1 (our pin) no
out-of-the-box option covered our combination: the built-in `html` reporter needs
`@vitest/ui`, emits a multi-file dev-server bundle (not one offline file), and
inline-attachment + single-file support landed only in Vitest 5.0. termless itself
ships no vitest reporter (only per-recording playback viewers). So the builder is
justified for now.

> **TODO (track): migrate to the native Vitest HTML reporter when 5.0 ships.**
> Vitest 5.0 (currently **beta-only** — `npm dist-tags vitest` shows `latest: 4.1.x`)
> adds `['html', { singleFile: true }]` (one self-contained file) and the
> `context.annotate(msg, type, { body, contentType })` attachment API (Vitest 3.2+)
> renders inline in that reporter. When 5.0 is GA, wire `src/setup.ts`'s
> screenshot-on-failure to `context.annotate(...)` and drop most of
> `build-report.mjs`. termless permits it today (`@termless/test` peers
> `vitest >=2.0.0`); the only blocker is 5.0's beta status. We do **not** pin a beta
> in a nightly regression harness.

## Validation findings (2026-06-28, clean Verdaccio builds)

The first real end-to-end validation produced two load-bearing results:

1. **R1 fix does not work.** The harness is faithful for Ctrl-C at an inquirer prompt
   (isolated repro: plain `@inquirer/prompts` `select` over termless + `press("Ctrl+c")`
   → `ExitPromptError`). Against clean Verdaccio-built prhead at **both** `970e06d2`
   and the fix commit **`27c12db2`**, R1 **hangs identically** — so `27c12db2` does
   **not** resolve the Ctrl-C-at-approval-prompt hang. Bundle-level root cause: cdktn's
   `StreamRenderer.start()` registers `process.once('SIGINT', cursorRestore)` that only
   shows the cursor (no exit, never settles the void'd deploy promise) and absorbs the
   interrupt before `select()` can raise `ExitPromptError` — so the patched catch in
   `deploy.ts`/`destroy.ts` is never reached. That StreamRenderer code is identical in
   both commits. **This is the suite catching a non-working fix** — its core purpose.
   Confirm via `manual-verify.mjs` / a real terminal before reporting upstream.
2. **#283 orphaned lock is not automatable via Ctrl-C.** A real-AWS prototype
   (`aws_instance` t3.micro, created + hard-interrupted + tag-terminated) showed
   terraform respects context-cancel near-instantly (graceful shutdown <350ms), so a
   human-timed second Ctrl-C never reaches the "Two interrupts → skip unlock → orphan"
   window. #283 is a wrapper signal-escalation race (or SIGKILL), not reproducible by
   faithful keyboard input. The mock test is a clean-teardown smoke; faithful #283 is
   `manual-verify.mjs` (real locking backend) + a cdktn unit test asserting it signals
   terraform exactly once.

## Update — #283 made testable + R1 manually confirmed (2026-06-28, pm)

**R1 fix confirmed broken (manual ground-truth).** A human ran `cdktn deploy` on the
prhead **fix build** (27c12db2) and pressed Ctrl-C at the approval prompt: the prompt
did NOT cancel, subsequent arrow keys echoed literally (`^[[B`/`^[[A` — inquirer's
keypress handler detached but the prompt promise never resolved → hung), and a 2nd
Ctrl-C threw an **uncaught `AbortError`** (`handlers.js:229`, `process.i`) crashing the
process. So commit 27c12db2's `ExitPromptError` catch is inert; the real failure is the
StreamRenderer/AbortController path. The R1 e2e test stays red until truly fixed — a
valid regression gate, now corroborated by manual testing.

**#283 is testable after all (research-driven redesign).** Empirically on terraform
1.7.5, the "two interrupts → orphaned lock" contract no longer holds (core still UNLOCKs
on 2×SIGINT; only the provider plugin is SIGKILLed). The ONLY thing that orphans an
*external* lock is SIGKILL. New `tests/ctrl-c-teardown.test.ts` #283 design:
- **Positive control** (`src/raw-terraform.ts` + SIGKILL): raw terraform holds the mock
  lock, we `kill("SIGKILL")` it mid-apply → lock orphaned. **Verified passing** — proves
  the mock + assertions detect an orphan (the teeth the old design lacked).
- **cdktn regression gate**: `cdktn deploy` + faithful Ctrl-C must RELEASE the lock; a
  regression where cdktn SIGKILLs terraform's tree (the true #283 mechanism on modern
  terraform) flips it to orphaned and fails.
Faithful #283 root cause for upstream: on terraform ≥1.6 an orphaned lock requires a
SIGKILL-equivalent — so if cdktn still orphans, it is killing terraform's process tree,
not sending two SIGINTs. (The #283 reporter used terraform 1.5.5, possibly pre-change.)
