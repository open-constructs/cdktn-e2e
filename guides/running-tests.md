# Running the e2e tests

Everything you need to provision a CLI, run the suite, drive the manual Ctrl-C
verification, and troubleshoot. For the *why*, see [DESIGN.md](./DESIGN.md) and the
open follow-ups in [roadmap.md](./roadmap.md).

## 0. Setup (once)

```bash
mise install      # Node 24 (.nvmrc; @termless/* need >=23.6.0) + terraform 1.7.5
pnpm install      # postinstall chmods node-pty's spawn-helper (see Troubleshooting)
```

If the `mise` shim isn't auto-activated in your shell, prefix any command with
`mise exec --` (e.g. `mise exec -- pnpm test`).

## 1. The provision / run model

Tests never hit the network. A **provision** step installs a CLI-under-test into
`.sandboxes/<id>/` and writes a `manifest.json`; tests read that manifest and spawn
an absolute bin path. `CLI_ID` selects which sandbox a run uses.

```
.sandboxes/<id>/
  node_modules/cdktn-cli/bin/cdktn   ← the bin tests spawn (node <bin-js>)
  fixtures/<name>/                   ← prepared fixture apps (framework import rewritten)
  manifest.json                      ← { binPath, version, libVersion, … }
```

### CLI_ID channels (the version matrix)

| `CLI_ID`        | what                                   | source                         |
| --------------- | -------------------------------------- | ------------------------------ |
| `cdktf-prefork` | `cdktf-cli@0.21.0` (pre-fork, Ink)     | npm                            |
| `cdktn-latest`  | `cdktn-cli@latest` (current release)   | npm                            |
| `cdktn-next`    | `cdktn-cli@next` (preview)             | npm — primary nightly target   |
| `cdktn-prhead`  | a local PR-head build                  | Verdaccio (all workspace pkgs) |

## 2. Provision a channel

```bash
# npm channels (install published artifacts):
pnpm provision cdktn-next
pnpm provision cdktn-latest cdktf-prefork      # several at once

# PR head (builds the monorepo, publishes 0.0.0 to an in-process Verdaccio,
# installs from it so ALL workspace packages are the PR's code, not published siblings):
CDKTN_MONOREPO=../cdk-terrain pnpm provision cdktn-prhead
```

`cdktn-prhead` builds whatever commit `../cdk-terrain` is checked out at. To test a
specific commit, `git -C ../cdk-terrain checkout <sha>` first (detached is fine), then
re-provision. The build is cache-busted (`nx reset`) so A/B comparisons are clean.

## 3. Run the suite

```bash
CLI_ID=cdktn-next pnpm test                                    # full suite
CLI_ID=cdktn-next pnpm exec vitest run tests/smoke.test.ts     # one file
CLI_ID=cdktn-next pnpm exec vitest run tests/ctrl-c-teardown.test.ts -t "R1"   # one test
CLI_ID=cdktn-next pnpm exec vitest tests/tty-render.test.ts    # watch mode
pnpm typecheck
```

Every run writes `reports/ci-report.json` (vitest JSON) for the CI step-summary /
issue reporter. Passing `--reporter=...` on the CLI overrides that, so omit it if you
want the report file.

Failure artifacts (SVG + screen text of every spawned terminal) land in `artifacts/`.

### HTML report

```bash
pnpm report:html                                              # → reports/html/index.html
pnpm report:html -- --run-url "$ACTIONS_RUN_URL"             # link the GH Actions run
pnpm report:html -- --report path/to/ci-report.json \        # point at a specific run
  --artifacts path/to/svgs --out _site/index.html
```

`scripts/build-report.mjs` reads **one** run's `reports/ci-report.json` + the
`artifacts/` SVG/text and emits a single self-contained `reports/html/index.html`
(inline CSS/JS, SVGs embedded, no CDNs — works offline). It shows summary cards and
a per-test table grouped by file → describe, with collapsible ANSI-stripped failure
messages and inline terminal screenshots, plus status filters, duration sort, and a
dark/light toggle. `reports/manual-verify-<id>.md` (below) is folded in when present.
Under GitHub Actions the run link is auto-derived from `GITHUB_*` env if `--run-url`
is omitted.

It is **single-run by design** — no cross-channel aggregation. The nightly builds it
on a fresh checkout (nothing to merge); flags `--report` / `--artifacts` / `--out`
let CI point it at a specific downloaded leg. (A cross-channel matrix was removed
deliberately; if you want to compare channels, build each report separately.)

### GitHub Pages ("last run results")

The nightly workflow's `pages` job publishes **one self-contained report per matrix
leg** plus a landing page, on every cron run and manual re-trigger, so Pages always
shows the latest run:

```
_site/index.html                          ← landing: a card per leg (pass/fail summary), built by build-index.mjs
_site/<os>-<cli_id>/index.html            ← that leg's full report, built by build-report.mjs
```

No cross-leg *data* aggregation — each leg's report is built independently from its
own downloaded `ci-report.json` (+ `svg-<leg>` screenshots); the landing page only
links to them. It uses the **Actions build mode** (`upload-pages-artifact` +
`deploy-pages`), not a legacy branch build. To preview the landing page locally:

```bash
node scripts/build-index.mjs --reports-dir _dl --site _site   # _dl holds report-<leg>/ci-report.json dirs
```

**One-time setup:** repo Settings → Pages → Source = "GitHub Actions". Never POST to
the `pages/builds` API (forces a legacy Jekyll build of the branch root).

## 4. Manual Ctrl-C verification (the human ground-truth)

Some Ctrl-C behaviours are confirmed by a human pressing the key. The guided runbook
boots the lock-mock, prints the exact command per scenario, tells you when to press
Ctrl-C (once / twice), shows the mock's LOCK/UNLOCK events, and records P/F/S to
`reports/manual-verify-<id>.md`:

```bash
CLI_ID=cdktn-prhead node scripts/manual-verify.mjs
```

### Raw manual R1 repro (decisive)

```bash
BIN="$PWD/.sandboxes/cdktn-prhead/node_modules/cdktn-cli/bin/cdktn"
FX="$PWD/.sandboxes/cdktn-prhead/fixtures/minimal-ts"
( cd "$FX" && rm -rf cdktf.out && node "$BIN" deploy )
# At "Please review the diff output above for hello", press Ctrl-C once.
#   HANGS / arrows echo as ^[[B / 2nd Ctrl-C crashes  → the fix is NOT working
#   exits cleanly, cursor restored                    → fix works (harness fidelity gap)
```

## 5. The #283 state-lock tests

`tests/ctrl-c-teardown.test.ts` covers the orphaned-lock scenario two ways:

- **Positive control** — raw terraform (`src/raw-terraform.ts`) holds the mock lock,
  then is `SIGKILL`ed mid-apply → orphaned. Proves the mock detects orphans. (On
  terraform ≥1.6, only SIGKILL orphans an external lock; 2×SIGINT still UNLOCKs.)
- **cdktn regression gate** — `cdktn deploy` + a faithful Ctrl-C must *release* the
  lock; a regression where cdktn SIGKILLs terraform's tree would orphan it and fail.

These need `terraform` on PATH (mise provides it). No cloud creds. The mock is a
genuine backend (terraform's real HTTP-backend driver over a real socket; the HTTP
REST backend is the one most TACOS expose), so there is **no fidelity reason** to
reach for a cloud backend — see [DESIGN.md](./DESIGN.md).

### A real-AWS probe is not needed (cleanup, in case one was run)

A `aws_instance` probe was tried once and does **not** reach the orphan path anyway
(terraform honours context-cancel in <350ms), so it adds nothing over the hermetic
tests. If anyone ever runs one, tag every resource `Purpose=cdktn-e2e-283-prototype`
and clean up by tag:

```bash
AV="AWS_REGION=us-east-1 aws-vault exec tcons-vincent --no-session --"
IDS=$($AV aws ec2 describe-instances \
  --filters Name=tag:Purpose,Values=cdktn-e2e-283-prototype \
            Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
[ -n "$IDS" ] && $AV aws ec2 terminate-instances --instance-ids $IDS
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `posix_spawnp failed` on every test | pnpm dropped node-pty's `spawn-helper` exec bit. Re-run `pnpm install` (postinstall chmods it) or `node scripts/fix-node-pty.mjs`. |
| `No provisioned sandbox for "<id>"` | Run `pnpm provision <id>` first. |
| prhead build fails with `ETARGET semver` | Stale npm "corgi" cache. `npm cache clean --force`, then re-provision. |
| synth/deploy/lock tests error with no terraform | `terraform` not on PATH. Use `mise exec --`, or install terraform. |
| `cdktn provider list` → "Could not determine cdktf/cdktn version" | Run it inside a fixture that has the library installed (the provisioned fixtures do). |
| Windows | node-pty uses ConPTY (Win10 1809+); the suite spawns `node <bin-js>` so the `.cmd` shim isn't needed. The posix `spawn-helper` chmod is skipped. |
