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
