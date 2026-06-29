# Design — cdktn-cli-e2e

The architecture and rationale for this suite. For the operator runbook
(provisioning, running, the manual Ctrl-C harness, troubleshooting) see
[running-tests.md](./running-tests.md); for open follow-ups see
[roadmap.md](./roadmap.md).

## Goal

A repository **separate from `open-constructs/cdk-terrain`** that continuously
validates CLI **behaviour** — TTY/UX rendering, prompt routing, the non-interactive
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

termless API used by the harness (`@termless/core@0.7.0`, `@termless/xtermjs@0.4.0`,
`@termless/test@0.4.0`): `createTerminal({backend,cols,rows})`,
`term.spawn(argv[], {cwd,env})`, `term.press("Ctrl+c"|"ArrowDown"|"Enter")`,
`term.type()`, `term.out`, `term.screen`/`row`/`cell`,
`term.exitInfo` (`"exit=<code>" | null`), `term.screenshotSvg()`. Matchers register
via the side-effect import `@termless/test/matchers` in `src/setup.ts`.

## Independence from cdk-terrain

This repo pins its **own** Node and toolchain, decoupled from cdk-terrain's
`.nvmrc` (22.22.3): we consume the CLI as a **prebuilt npm artifact** (its bundle
targets node22 at runtime but runs fine on newer Node), so the test runner's Node
is free to be whatever **termless** requires — and termless requires it. All
`@termless/*` packages declare `engines.node >= 23.6.0` (native TS + `using`
disposal), so `.nvmrc` is pinned to **24** (satisfies the floor).

`mise.toml` enables `.nvmrc` as the idiomatic Node version file
(`idiomatic_version_file_enable_tools = ["node", "pnpm"]`) and pins no `node` in
`[tools]`, so mise provisions Node from `.nvmrc`. It also pins `terraform = 1.7.5`,
which the synth/deploy/lock tests use. Run via `mise exec -- <cmd>` if the mise
shim isn't on PATH.

## Version matrix (regression comparison)

The same tests run against each channel by selecting `CLI_ID`; a regression is the
same assertion flipping between channels. (Resolved versions are snapshots that
drift as releases publish.)

| `CLI_ID`        | binary               | resolved at scaffold | bin   | library | purpose |
| --------------- | -------------------- | -------------------- | ----- | ------- | ------- |
| `cdktf-prefork` | `cdktf-cli`          | `0.21.0`             | cdktf | cdktf   | pre-fork Ink baseline — the UX the rewrite departs from |
| `cdktn-latest`  | `cdktn-cli@latest`   | last stable          | cdktn | cdktn   | "known good" the preview must not regress |
| `cdktn-next`    | `cdktn-cli@next`     | latest preview       | cdktn | cdktn   | **preview, primary nightly target** |
| `cdktn-prhead`  | local monorepo build | `0.0.0` via Verdaccio | cdktn | cdktn  | unmerged PR validated pre-merge |

Fixtures are framework-agnostic: `main.ts` imports from `__FRAMEWORK__`, which
`provision.mjs` rewrites to `cdktf` or `cdktn` so the *same* app validates across
the fork boundary. The four fixtures (`minimal-ts`, `multi-stack-ts`,
`locking-http-ts`, `provider-list-ts`) use the legacy `cdktf.json` config and a
local backend with no providers, so synth/deploy/destroy run fully offline.

### Provision/run split

`scripts/provision.mjs` is the **only** network/build step. It installs a CLI into
`.sandboxes/<id>/`, prepares fixtures, and writes `manifest.json`. Tests read the
manifest — they spawn an absolute bin path (`node <bin-js>`, never the `.bin` shim,
for Windows compat) and never hit the network. This keeps test execution pure,
fast, and trivially parallelisable across `CLI_ID`s in CI.

- **npm channels** (`cdktf-prefork`, `cdktn-latest`, `cdktn-next`) `npm install`
  the published `@latest`/`@next` artifacts into the sandbox.
- **`cdktn-prhead`** builds the full `cdk-terrain` monorepo (`CDKTN_MONOREPO=...`)
  under the monorepo's *own* mise/node-22 toolchain (`nx reset` cache-bust →
  `build` → `package:js`), then **publishes every workspace tarball at `0.0.0` to
  an in-process Verdaccio registry** and installs `cdktn-cli` (+ the `cdktn` lib
  for fixtures) from it. Because *all* `cdktn*`/`@cdktn/*` packages are served
  locally at their real `0.0.0` (no npm proxy for them), the PR head is exercised
  end-to-end — including changed sibling packages, not just `cdktn-cli`.

The preview channel is live: every merge to `main` runs cdk-terrain's
`prepare-next` job (`standard-version --prerelease pre`) and publishes
`cdktn-cli@next` (+ `cdktn@next`, `@cdktn/*@next`) to npm via `publib-npm` (OIDC).

## Triggers

`nightly.yml`:
- **schedule** `0 3 * * *` → a `decide` job runs `check-new-preview.mjs`: queries
  `npm view cdktn-cli@next version`, compares to `state/last-tested.json`, and
  **skips the whole matrix when the preview hasn't moved** (cron diff-detection).
- **workflow_dispatch** → choose `cli_ids`; `force` defaults true (always run).
  **This is the flake-retrigger path**: a suspected-flaky failure is re-run by
  dispatching with `force=true` (bypasses the marker). The cron never auto-retries.

`pr-validation.yml` (manual): checks out a cdk-terrain PR head, builds + packs
`cdktn-cli`, provisions `cdktn-prhead`, runs the suite — the "validate a PR before
merge" path. Linux/macOS only (the PR-head path builds the jsii monorepo, which is
impractical on Windows).

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

The e2e matrix is `os: {ubuntu-latest, macos-latest, windows-latest} × cli_id:
{cdktn-next, cdktn-latest}` (extend with `cdktf-prefork` for cross-fork UX deltas).
**All three OSes run a real PTY**: Unix PTY on linux/macOS, **Windows ConPTY** via
node-pty 1.1 (Win10 1809+; winpty support was removed) — so the
inquirer/cli-spinners/cli-table3 rendering is validated on Windows terminals too.

Rationale for run-once: the residual flake surface here is small (no provider
downloads — local backend + `terraform_data`; deterministic spawn after the
`spawn-helper` chmod fix), so the genuinely transient cases (npm/registry blips,
slow-runner timeouts, runner death) are better handled by a human re-trigger than
by masking regressions.

## Regression targets this suite is built to catch

| Area | Test | What it pins |
| ---- | ---- | ------------ |
| Spinner/cursor hygiene | `tty-render` | cursor hide `\x1b[?25l` → permanent summary → cursor restore `\x1b[?25h` |
| Table rendering | `tty-render` | cli-table3 border glyphs; columned `list` |
| Approval routing | `deploy-approve` | Approve / Dismiss / `--auto-approve` via real arrow+Enter bytes |
| Non-TTY contract | `non-tty` | piped synth/deploy/diff ⇒ zero ANSI, no hang, clean exit (the old Ink "Raw mode" crash) |
| Library output | `synth-golden` | normalized `cdk.tf.json` snapshot per channel; sensitive-output redaction |
| Smoke | `smoke` | `--version` semver + clean exit; `synth` summary line over PTY |
| Ctrl-C at approval prompt (R1) | `ctrl-c-teardown` | inquirer ExitPromptError must terminate + restore cursor, not hang core-cli |
| Ctrl-C during `watch` | `ctrl-c-teardown` | clean teardown + cursor restore |
| State-lock release (#283) | `ctrl-c-teardown` | interrupting apply must let terraform shut down gracefully and **UNLOCK** |

## Testing state-lock release (#283) hermetically

[Issue #283](https://github.com/open-constructs/cdk-terrain/issues/283): a Ctrl-C
during `diff`/`deploy` could kill terraform without a graceful shutdown, leaving the
state lock held so the next run fails to acquire it. Faithful coverage needs a
backend with **real locking** — which the in-process mock provides.

`src/tf-http-backend.ts` is a small Node HTTP server implementing the genuine
Terraform HTTP-backend lock protocol — `GET/POST /tfstate/{guid}`, `LOCK`/`UNLOCK`,
**`423 Locked` + the holder's lock-info JSON when already held** — the same shape as
the Go reference at `grid/cmd/gridapi/internal/server/tfstate.go`. **The round-trip
is genuine, not mocked:** terraform runs its real HTTP-backend driver and makes real
HTTP requests over a TCP socket to `127.0.0.1:<port>`; the server returns real
200/404/423 responses with real lock-info JSON. From terraform's side this is the
actual backend client code exercising a real socket — and the HTTP REST backend is
itself a first-class terraform backend (the one most TACOS expose for remote state),
so this is a real backend, not a stand-in for one. Other backends (S3+DynamoDB,
Postgres) differ only in the storage substrate behind the same advisory,
protocol-level lock. The lock record lives in the **test-runner process,
independent of terraform**, so when terraform dies the lock stays held and is
observable. The `locking-http-ts` fixture points an `http` backend at the mock and
uses a built-in `terraform_data` + `local-exec sleep` to hold the lock during apply
(no provider download, no cloud); the mock exposes `currentLock()` /
`unlockedSince(ts)` for UI-independent assertions (cdktn's StreamRenderer reformats
terraform's `Still creating` / `Gracefully shutting down` lines so they don't render
reliably).

**Research finding (terraform 1.7.5, empirically verified):** the classic
"two interrupts → orphaned lock" contract **no longer holds** — modern terraform
still calls UNLOCK on `2×SIGINT` (the immediate-exit only SIGKILLs the *provider
plugin*; core unwinds far enough to release the backend lock). The only thing that
orphans an *external* lock is an uncatchable **SIGKILL**. The two tests are built
around that:

1. **Positive control** — raw terraform (`src/raw-terraform.ts`, no cdktn) holds the
   mock lock, then is `SIGKILL`ed mid-apply so its deferred UNLOCK never runs → lock
   orphaned. This proves the mock + assertions can actually *detect* an orphan (the
   teeth a release-only assertion otherwise lacks).
2. **cdktn regression gate** — `cdktn deploy` + a faithful keyboard Ctrl-C must
   **release** the lock. A regression where cdktn SIGKILLs terraform's process tree
   on interrupt (the true #283 mechanism on modern terraform) would orphan the lock
   and fail the gate.

There is **no backend-fidelity gap** to close — the HTTP backend code path and its
round-trip are already genuine. The only piece left is upstream of this repo: a cdktn
unit test asserting it signals terraform **exactly once** on interrupt (the actual
#283 contract at the source level). `scripts/manual-verify.mjs` is the human
ground-truth backstop today (see [roadmap.md](./roadmap.md)).

## Known limitations

1. **Sending Ctrl-C is a raw byte, not a signal — and that is faithful.** termless
   exposes no `kill(signal)`; `press("Ctrl+c")` writes `\x03` to the PTY,
   byte-for-byte what a keyboard sends. The outcome depends on the program's terminal
   mode, exactly as on a real terminal:
   - **At the inquirer prompt (raw mode):** `\x03` is delivered as a keypress; Node
     `readline` fires `rl.on('SIGINT')`, which `@inquirer/core` wires to
     `reject(new ExitPromptError(...))`.
   - **During `deploy --auto-approve` (cooked mode):** node-pty hardcodes the slave
     PTY to cooked/ISIG-on/`VINTR=3`, so `\x03` → line discipline → group SIGINT,
     which cdktn intercepts (its own `AbortError`) to tear terraform down cleanly.
2. **R1 (Ctrl-C at the approval prompt) currently fails — by design.** The e2e gate
   asserts clean termination + cursor restore; against the prhead *fix* build it
   stays red because cdktn's `StreamRenderer.start()` registers a
   `process.once('SIGINT', cursorRestore)` that only shows the cursor (never exits,
   never settles the void'd deploy promise) and absorbs the interrupt before
   `select()` can raise `ExitPromptError` — so the patched `catch` in
   `deploy.ts`/`destroy.ts` is never reached. **This is the suite catching a
   non-working fix — its core purpose.** Confirmed manually via
   `scripts/manual-verify.mjs` / a real terminal. The gate stays red until the fix
   actually lands upstream.

## HTML report + GitHub Pages

`scripts/build-report.mjs` turns **one** run's `reports/ci-report.json` (+
`artifacts/` SVG/text) into a single self-contained HTML report (inline CSS/JS,
embedded SVGs, no CDNs). The nightly `pages` job builds one such report **per matrix
leg** (`_site/<os>-<cli_id>/index.html`) and a generated landing page
(`scripts/build-index.mjs` → `_site/index.html`) that links to each leg with a
pass/fail summary, then deploys the whole `_site/` to GitHub Pages via the **Actions
build mode** on every cron/manual run. See [running-tests.md](./running-tests.md)
for usage and the one-time Pages setting.

**No cross-leg data aggregation — by design.** Each report is built independently on
a fresh CI artifact (nothing to merge), because an earlier cross-channel aggregation
silently resurfaced stale runs (an old `posix_spawnp`-broken run overrode a fresh
pass). The landing page *links* the per-leg reports rather than merging their data,
so comparison stays per-leg and honest.

**Why a custom builder.** On Vitest 4.1 (our pin) no built-in option covers our
combination: the `html` reporter needs `@vitest/ui`, emits a multi-file dev-server
bundle (not one offline file), and inline-attachment + single-file support landed
only in Vitest 5.0. termless ships no vitest reporter (only per-recording playback
viewers). Migrating to the native single-file reporter once Vitest 5.0 is GA is
tracked in [roadmap.md](./roadmap.md).
