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
mise install                  # Node 24 (.nvmrc; termless needs >=23.6.0) + terraform 1.7.5
pnpm install
# (mise.toml pins terraform 1.7.5; or `brew install terraform` / setup-terraform in CI)

# Provision a CLI into .sandboxes/<id>/ (installs the binary + matching library + fixtures)
pnpm provision cdktn-next

# Run the suite against it
CLI_ID=cdktn-next pnpm test

# If mise isn't activated in your shell, prefix commands: `mise exec -- pnpm test`

# Compare channels
pnpm provision cdktn-latest cdktf-prefork
CLI_ID=cdktn-latest   pnpm test
CLI_ID=cdktf-prefork  pnpm test
```

### Validate an unmerged PR locally

```bash
CDKTN_MONOREPO=../cdk-terrain pnpm provision cdktn-prhead   # builds + packs cdktn-cli from the checkout
CLI_ID=cdktn-prhead pnpm test
```

## Layout

```
src/
  versions.ts     # the CLI version matrix
  provision …     # (scripts/) installs a CLI into .sandboxes/<id>/ + writes manifest.json
  manifest.ts     # tests read provisioned bin paths from here (no network at test time)
  harness.ts      # spawnCli(), waitExit(), TTY_ENV / NONTTY_ENV
  setup.ts        # matcher registration + SVG-screenshot-on-failure
  tf-http-backend.ts  # in-process Terraform HTTP backend mock (state lock testing, issue #283)
fixtures/
  minimal-ts/     # single provider-free stack (local backend)
  multi-stack-ts/ # infra→app dependency edge (deploy router: dismiss/stop)
  locking-http-ts/# http backend → the mock, for lock-release tests
tests/            # smoke, tty-render, deploy-approve, non-tty, synth-golden, ctrl-c-teardown
scripts/
  provision.mjs        # install/build a CLI under test
  check-new-preview.mjs # cron diff-detection (skip when @next hasn't moved)
.github/workflows/
  nightly.yml          # cron + manual dispatch + diff-detection
  pr-validation.yml    # on-demand PR-head validation
```

See [DESIGN.md](./DESIGN.md) for the architecture, rationale, and the regression
targets this suite is built to catch.
