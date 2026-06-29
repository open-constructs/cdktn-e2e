# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **standalone, PTY-driven e2e regression suite** for the cdktn CLI, built on
[termless](https://termless.dev). It spawns a *real released* `cdktn`/`cdktf`
binary over a pseudo-terminal, feeds output into a headless xterm.js emulator, and
asserts on the rendered screen, raw escape bytes, and exit codes. It runs nightly
(and on demand) against **published preview releases** to catch TTY/UX + CLI-contract
regressions that the cdk-terrain per-PR CI deliberately skips. It is **not** part of
the cdk-terrain monorepo. See `guides/DESIGN.md` for the full rationale,
`guides/running-tests.md` for the operator runbook (provisioning, manual Ctrl-C
verification, #283 lock tests, troubleshooting), `guides/roadmap.md` for open items,
and `README.md` for the quickstart.

## Commands

Toolchain is via **mise** (`mise.toml` pins terraform 1.7.5; Node comes from `.nvmrc` = 24).
If the `mise` shim isn't on PATH, prefix everything with `mise exec --`.

```bash
mise install                       # Node 24 + terraform 1.7.5
pnpm install                       # postinstall chmods node-pty's spawn-helper (see gotchas)

# Provision a CLI channel into .sandboxes/<id>/ (the ONLY network/build step)
pnpm provision cdktn-next          # also: cdktn-latest, cdktf-prefork
CDKTN_MONOREPO=../cdk-terrain pnpm provision cdktn-prhead   # builds+packs a local PR head

# Run the suite against a provisioned channel (CLI_ID selects which)
CLI_ID=cdktn-next pnpm test

# Single file / single test (note: passing --reporter on the CLI overrides the
# config's json reporter, so reports/ci-report.json won't be written)
CLI_ID=cdktn-next pnpm exec vitest run tests/smoke.test.ts
CLI_ID=cdktn-next pnpm exec vitest run tests/deploy-approve.test.ts -t "Dismiss"

pnpm typecheck                     # tsc --noEmit
```

`terraform` must be on PATH for synth/deploy tests to do anything — it is, via mise.

## Architecture

```
vitest ── @termless/test (matchers) ── @termless/core Terminal ── node-pty (PTY) ── cdktn binary ── fixture app
   src/setup.ts registers matchers + SVG-screenshot-on-failure        child sees isTTY=true
```

- **Provision/run split** is the core design. `scripts/provision.mjs` is the *only*
  step that touches the network or builds anything: it installs a CLI into
  `.sandboxes/<id>/` and writes `manifest.json`. Tests read the manifest
  (`src/manifest.ts`) and spawn an absolute bin path — they never hit the network,
  so test execution is pure and parallelizable across `CLI_ID`s.
- **Version matrix** (`src/versions.ts`): the *same* tests run against each channel
  by selecting `CLI_ID`. `cdktf-prefork` (pre-fork Ink baseline), `cdktn-latest`,
  `cdktn-next` (preview), `cdktn-prhead` (local PR build). A regression shows up as
  the same assertion flipping between channels.
- **Harness** (`src/harness.ts`): `spawnCli()` (PTY), `runPiped()` (non-PTY),
  `waitExit()`, `resetFixtureState()`, `TTY_ENV`/`NONTTY_ENV`. Tests stay declarative.
- **Fixtures** (`fixtures/`) are framework-agnostic: `main.ts` imports from
  `__FRAMEWORK__`, which `provision.mjs` rewrites to `cdktf` or `cdktn` to match the
  channel. They use the legacy `cdktf.json` config and a **local backend** with no
  providers, so synth/deploy/destroy run fully offline.
- **CI** (`.github/workflows/`): `nightly.yml` (cron + diff-detection + run-once
  marker + GitHub-issue reporting + per-leg HTML report → GitHub Pages via
  `build-report.mjs`/`build-index.mjs` + step summary), `pr-validation.yml`
  (on-demand PR-head build). Matrix: 3 OS (ubuntu/macos/**windows**) × {cdktn-next,
  cdktn-latest}.

## Critical gotchas (learned the hard way)

- **node-pty `spawn-helper` exec bit.** pnpm strips the executable bit off node-pty's
  prebuilt `spawn-helper`, so every PTY spawn fails with `posix_spawnp failed`. The
  `postinstall` (`scripts/fix-node-pty.mjs`) chmods it. If you see that error, run
  `pnpm install` (or the script) again. Skipped on Windows (conpty needs no helper).
- **Spawn `node <bin-js>`, not the `.bin` shim.** `manifest.binPath` is the package's
  resolved bin JS entry; the harness spawns `[process.execPath, binPath, ...]`. The
  `.bin/*.cmd`/sh shim is not node-runnable on Windows.
- **Over a PTY the child ALWAYS sees `isTTY === true`.** To test the non-interactive
  "ANSI-free when piped" contract, use `runPiped()` (real `child_process` pipe,
  `isTTY=false`) — *not* a PTY with `CI=1` (that only gates cdktn's own bar; the
  terraform subprocess still emits ANSI over a PTY).
- **`freshState: true`** wipes `cdktf.out` (synth output + tfstate + lock) before a
  test. Required for deploy/destroy/watch/ctrl-c tests, or they contend on a leftover
  state lock (e.g. from a Ctrl-C test that killed terraform mid-apply).
- **`exitInfo` is `"exit=<code>" | null`.** `null` after `waitExit()` means the CLI
  **hung** — that's the assertion the anti-hang (Ctrl-C) tests rely on.
- **Don't snapshot animated spinner frames.** Assert with `toContainText(text, { timeout })`
  (auto-retry). Pin `cols`/`rows` for deterministic table layout.
- **Node version is independent of cdk-terrain.** This repo pins Node 24 (`.nvmrc`)
  because all `@termless/*` require `>=23.6.0`. cdk-terrain's `.nvmrc` (22.22.3) is
  irrelevant — we consume the CLI as a prebuilt npm artifact. Do not "align" it down.

## Key facts to know before testing

- **Published `cdktn-cli@next` is still the Ink CLI** — PR #264 (the inquirer/
  cli-table3/cli-spinners rewrite) is not published yet. To validate the rewrite, use
  `CLI_ID=cdktn-prhead` (build the PR head locally via `CDKTN_MONOREPO`). The published
  channels currently exercise the *old* TUI.
- **Multi-stack `deploy` needs explicit stack ids** (e.g. `deploy "*"`); a bare
  `deploy` errors when >1 stack exists.
- **termless API** used: `createTerminal({backend,cols,rows})`, `term.spawn(argv[],{cwd,env})`,
  `term.press("Ctrl+c"|"ArrowDown"|"Enter")`, `term.type()`, `term.out`, `term.screen`,
  `term.row(n)`, `term.cell(r,c)`, `term.exitInfo`, `term.screenshotSvg()`. Matchers
  register via the `@termless/test/matchers` side-effect import in `src/setup.ts`.

## When editing CI workflows

`.github/workflows/*.yml` are **SHA-pinned and least-privilege** (a security pass was
applied). Preserve that when editing: pin any new action to a SHA, scope elevated
permissions (`issues:`/`contents: write`) to the job that needs them, and flag for a
re-hardening review after structural changes. The nightly **run-once policy** advances
`state/last-tested.json` on pass *or* fail (no auto-retry); failures are surfaced via a
dedup'd GitHub issue (`scripts/report-issue.mjs`), and suspected flakes are re-run by
hand via `workflow_dispatch force=true`.
