# cdktn-cli-e2e

Standalone, PTY-driven end-to-end regression suite for the **cdktn CLI**, built on
[termless](https://termless.dev). It spawns a *real released* `cdktn` / `cdktf`
binary over a pseudo-terminal, feeds the output into a headless xterm.js emulator,
and asserts on the rendered screen, cell styling, raw escape bytes, and exit codes.

It exists to run the **heavy TTY/UX checks the cdk-terrain per-PR CI deliberately
skips** — on a nightly schedule (and on demand), against published **preview
releases** (`cdktn-cli@next`, rebuilt on every merge to `main`) — without adding a
single minute to the upstream PR pipeline.

Primary motivation: the CLI is mid-overhaul — `node-pty` was removed, and the
Ink/React TUI is being replaced with `@inquirer/prompts` + `cli-spinners` +
`cli-table3` ([PR #264](https://github.com/open-constructs/cdk-terrain/pull/264)).
Those are exactly the behaviours that only manifest under a real TTY.

## How it works

```
vitest ─ @termless/test matchers ─ @termless/core Terminal ─ node-pty ─ cdktn binary ─ fixture app
                    (assert screen/bytes/exit)         (PTY: child sees isTTY=true)
```

A **version matrix** lets the same tests run against every channel, so regressions
show up as the same assertion flipping:

| `CLI_ID`         | what                                   | source                         |
| ---------------- | -------------------------------------- | ------------------------------ |
| `cdktf-prefork`  | `cdktf-cli@0.21.0` (pre-fork, Ink)     | npm                            |
| `cdktn-latest`   | `cdktn-cli@latest` (current release)   | npm                            |
| `cdktn-next`     | `cdktn-cli@next` (preview)             | npm — **primary nightly target** |
| `cdktn-prhead`   | unmerged PR head                       | local `pnpm pack` of a checkout |

## Quick start

```bash
mise install                       # Node 24 + terraform 1.7.5
pnpm install                       # postinstall fixes node-pty's spawn-helper bit
pnpm provision cdktn-next          # install a CLI into .sandboxes/cdktn-next/
CLI_ID=cdktn-next pnpm test        # run the suite against it
```

Validate an unmerged PR head (builds the monorepo via an in-process Verdaccio so all
workspace packages are the PR's code):

```bash
CDKTN_MONOREPO=../cdk-terrain pnpm provision cdktn-prhead
CLI_ID=cdktn-prhead pnpm test
```

→ **[guides/running-tests.md](./guides/running-tests.md)** — provisioning each channel,
single tests, the manual Ctrl-C runbook, the #283 lock tests, and troubleshooting.

## Layout

```
src/
  versions.ts          # the CLI version matrix
  manifest.ts          # tests read provisioned bin paths here (no network at test time)
  harness.ts           # spawnCli(), runPiped(), waitExit(), until(), TTY_ENV/NONTTY_ENV
  setup.ts             # matcher registration + SVG-screenshot-on-failure
  tf-http-backend.ts   # in-process Terraform HTTP backend mock (state-lock observation)
  raw-terraform.ts     # drive a raw terraform binary (the #283 SIGKILL positive control)
fixtures/              # minimal-ts, multi-stack-ts, locking-http-ts, provider-list-ts
tests/                 # smoke, tty-render, deploy-approve, non-tty, synth-golden, ctrl-c-teardown
scripts/
  provision.mjs        # install/build a CLI into .sandboxes/<id>/ (+ Verdaccio for prhead)
  fix-node-pty.mjs     # postinstall: restore node-pty's spawn-helper exec bit
  check-new-preview.mjs # cron diff-detection (skip when @next hasn't moved)
  report-issue.mjs     # open/update/close a dedup'd GitHub issue from a run
  step-summary.mjs     # per-run pass/fail table → GitHub step summary
  build-report.mjs     # one run's ci-report.json + artifacts → self-contained HTML
  build-index.mjs      # Pages landing page linking each matrix leg's report
  manual-verify.mjs    # human Ctrl-C runbook (ground-truth backstop)
.github/workflows/     # nightly.yml (cron + diff-detection + issue + Pages), pr-validation.yml
```

See **[guides/DESIGN.md](./guides/DESIGN.md)** for architecture, rationale, and the
run-once CI policy; **[guides/running-tests.md](./guides/running-tests.md)** for the
operator runbook; **[guides/roadmap.md](./guides/roadmap.md)** for open items.
