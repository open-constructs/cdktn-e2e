# E2E Testing Setup: cdktn-cli (PR #264) with termless

## Executive Summary

`termless` is a headless terminal-emulator testing framework: it spawns a real process over a PTY, feeds the output into a VT emulator (xterm.js by default), and exposes a Playwright-style **WHERE-then-WHAT** matcher API (`@termless/test`) for asserting on the rendered screen grid, cell styling, cursor, and raw output bytes. It fits PR #264 precisely because that PR rips out Ink+React and re-implements the TUI with `inquirer` (interactive prompts), `cli-spinners` (animated status bar), and `cli-table3` (provider tables) plus a hand-rolled `StreamRenderer` log-above/bar-below renderer — all behaviors that **only manifest under a real TTY** and that the existing e2e harness (which spawns with `stdio:"pipe"` + `CI=1`, stripping ANSI) cannot exercise. A PTY gives `process.stdout.isTTY === true` inside the child, so spinners, alt-screen prompts, arrow-key routing, and non-TTY fallbacks can all be asserted. **Recommended backend: `@termless/xtermjs`** (zero native deps, ships with `@termless/test`), with an optional `vt100` lane for constrained runners. **Recommended runtime: Node `>=23.6.0` for the test runner**, driving the CLI built for its `node22` target, with `node-pty` installed for PTY spawn (macOS/Linux only). Note the cdktn monorepo pins Node `22.22.3` via `.nvmrc`; `@termless/core` engines want `>=23.6.0`, so **verify** whether the test job needs a newer Node than the build, or run the termless test project under a separate Node version.

---

## 1. Architecture of the approach

```
┌────────────────────────────────────────────────────────────────────────────┐
│ vitest (Node test runner; itself NOT a TTY)                                │
│                                                                            │
│   expect(term.screen).toContainText(...)        ← WHAT (matcher)           │
│   expect(term.cell(r,c)).toHaveAttrs({inverse}) ← WHAT (cell style)        │
│   expect(term.out).not.toContainOutput("\x1b[") ← WHAT (raw bytes)         │
│        │                                                                   │
│        ▼                                                                   │
│  @termless/test  ── matchers + fixtures + snapshot serializer              │
│   (auto-registers via expect.extend on import)                             │
│        │                                                                   │
│        ▼                                                                   │
│  @termless/core   Terminal: feed() / spawn() / press() / type() / resize() │
│   region selectors: screen, row(n), cell(r,c), range(...), out             │
│        │                          ▲                                        │
│        │ onData(Uint8Array)       │ press()/type() → stdin                 │
│        ▼                          │                                        │
│  @termless/xtermjs  (@xterm/headless VT emulator — the "backend")          │
│        ▲                                                                   │
│        │ bytes                                                             │
│        │                                                                   │
│  node-pty  (Unix PTY; injects FORCE_COLOR=1, TERM=xterm-256color)          │
│        ▲          ← child sees isTTY=true → inquirer/cli-spinners enable   │
│        │                                                                   │
│  spawned cdktn binary                                                      │
│   node …/packages/cdktn-cli/bin/cdktn  → bundle/bin/cdktn.js               │
│        │                                                                   │
│        ▼                                                                   │
│  fixture cdktn app (cdktf.json + main.ts)  →  cdktf.out/stacks/<name>/…    │
└────────────────────────────────────────────────────────────────────────────┘
```

Data flows two ways: the child's stdout/stderr → node-pty → xterm.js backend → live screen grid that matchers poll; and `term.press()/type()` → node-pty stdin → the child's tty line discipline (so `Ctrl+c` becomes SIGINT on the wire). The "backend emulator" is swappable (`xtermjs` default, `vt100` for hermetic CI); everything above it is backend-agnostic.

---

## 2. Project setup

### Dependencies to add

Add to the **`cdktn-cli` package** `package.json` (these are peer deps in termless and are NOT hoisted automatically by pnpm — declare them explicitly):

```jsonc
{
  "devDependencies": {
    "@termless/core": "^0.6.0",     // engine: createTerminal, screenshotSvg, view types
    "@termless/test": "^0.3.1",     // vitest matchers, fixtures, serializer (npm name)
    "@termless/xtermjs": "*",       // default backend (@xterm/headless, zero native deps)
    "vitest": ">=2.0.0"             // peer dep of @termless/test
  },
  "optionalDependencies": {
    "node-pty": ">=1.0.0"           // REQUIRED for term.spawn() PTY tests; native addon
  }
}
```

Install (monorepo root, pnpm + corepack):

```bash
corepack enable
cd /Users/vincentdesmet/cdktn/cdk-terrain
pnpm install
```

`node-pty` is a **native addon** needing Python + a C/C++ compiler at install time. Pure `feed()` tests don't need it; only `spawn()` does. Call `await preloadNodePty()` once at suite boot to fail fast with a clear error if it's missing rather than at first spawn.

### vitest config

```ts
// packages/cdktn-cli/vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Keep PTY/e2e tests in their own glob so they run apart from fast unit tests.
    include: ["test/e2e/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    setupFiles: ["./test/e2e/vitest.setup.ts"], // registers matchers + serializer once
    environment: "node",   // default; do NOT use jsdom/browser for the xterm.js backend
    testTimeout: 30000,    // PTY + real cdktn synth/get is slow; bump from default
  },
})
```

The cdktn e2e harness today is **jest** (`test/jest.config.js`); termless integrates with **vitest** only. Either add a vitest project alongside jest, or migrate the new TTY suite to vitest — keep them separate from the existing jest e2e for now.

### Setup file (matcher + serializer registration)

```ts
// test/e2e/vitest.setup.ts
import "@termless/test/matchers"           // side-effect: expect.extend(terminalMatchers)
import { expect } from "vitest"
import { terminalSerializer } from "@termless/test"
expect.addSnapshotSerializer(terminalSerializer)   // human-readable terminal snapshots
```

Importing the matchers also pulls in the `declare module "vitest"` augmentation, so the setup file gives you both runtime matchers and their TS types — **as long as the setup file is inside the TS project's `include`**, or the matcher methods type-error despite working at runtime.

### tsconfig notes (Node / pnpm / nx — NOT bun)

- `@termless/*` packages are ESM-only (`"type": "module"`) and ship native `.ts` source in dev `exports`. Use `"moduleResolution": "bundler"` (or `"nodenext"`) and `"module": "esnext"`.
- `@termless/core` engines require **Node `>=23.6.0`**; the repo's `.nvmrc` is `22.22.3`. **Verify** the test runner Node version — the vitest TTY suite may need a newer Node than the CLI build target (`node22`). The xtermjs/test path does not need the Node-24-only `AsyncDisposableStack` features (those are only in upstream's rec-live-overlay tests, which upstream excludes).
- pnpm/nx: because the `@termless/*` packages are peers, add all three to `cdktn-cli`'s `package.json` directly; pnpm will not hoist them.
- This is a **Node.js + pnpm + nx** target (a supported termless consuming setup). Do **not** assume the bun PTY path — on Node, termless uses `node-pty` loaded lazily via `createRequire`.

---

## 3. Building & invoking the CLI under test

### Build the CLI (and its workspace deps)

```bash
cd /Users/vincentdesmet/cdktn/cdk-terrain
pnpm install
pnpm nx build cdktn-cli        # nx build has dependsOn ["^build"] → builds @cdktn/cli-core, cdktn, hcl* first
# or whole set: pnpm run build  (= lerna run --scope 'cdktn*' --scope @cdktn/* build)
```

The CLI is an esbuild CJS bundle (`build.ts` bundles `src/bin/cdktn.ts` + `handlers.ts` → `bundle/`, and copies `@cdktn/cli-core/templates` → `bundle/templates`). Several deps are left **external** (`cdktn`, `jsii`, `yargs`, `constructs`, `@cdktn/hcl2json`, `@cdktn/hcl-tools`, `@cdktn/hcl2cdk`) and resolve from `node_modules` at runtime — so the built bin only runs inside the monorepo (or a real install).

### Binary/bundle path to spawn

- **bin shim (spawn this through node):** `/Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bin/cdktn`
- **bundle it loads:** `/Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bundle/bin/cdktn.js`

```bash
node /Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bin/cdktn --version
```

So `term.spawn(["node", "/Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bin/cdktn", "synth"], { cwd: fixtureDir })`.

For packaging-fidelity (catches relative-path/externals bugs the in-place build misses), use the tarball path the repo's own e2e uses:

```bash
pnpm nx package cdktn-cli       # → packages/cdktn-cli/dist/js/cdktn-cli-0.0.0.tgz
# install into a throwaway project, then spawn $WORK/node_modules/.bin/cdktn
```

### Fixture cdktn app

The config file is still the legacy **`cdktf.json`** (not `cdktn.json`); the framework package is `cdktn`. A minimal self-contained TS fixture (no provider download):

`<fixture>/cdktf.json`
```json
{
  "language": "typescript",
  "app": "npx ts-node main.ts",
  "terraformProviders": [],
  "terraformModules": [],
  "context": {}
}
```

`<fixture>/main.ts`
```ts
import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput, LocalBackend } from "cdktn";

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    new LocalBackend(this, { path: "terraform.tfstate" });
    new TerraformOutput(this, "hello", { value: "world" });
  }
}
const app = new App();
new MyStack(app, "hello-terra");
app.synth();
```

```bash
cd <fixture>
npm i cdktn ts-node typescript constructs
node …/packages/cdktn-cli/bin/cdktn get      # then synth/deploy/etc.
# output: <fixture>/cdktf.out/stacks/hello-terra/cdk.tf(.json)
```

A multi-stack fixture is needed for the Dismiss/Stop routing tests (2.2/2.3); a sentinel-soft-fail fixture for 2.4/3.3. Reference real fixture: `/Users/vincentdesmet/cdktn/cdk-terrain/test/typescript/synth-app/`.

**Critical env note:** the TTY gate is `tty = Boolean(out.isTTY) && !isCI` (`tty-stream.ts:42`), and `isCI` is read from env at module import. To exercise the **TTY path** you must spawn with **`CI` unset** (and not `GITHUB_ACTIONS`, etc.). To exercise the **non-TTY path** deterministically, spawn with stdout piped or `CI=1`.

---

## 4. Test plan

Legend: keys via `term.press(...)` send the bytes in §`tl-pty-spawn` (`ArrowDown`→`\x1b[B`, `Enter`→`\r`, `Ctrl+c`→`\x03`).

| # | Behavior | Command (spawn) | Input / keys | Expected terminal assertion | Matcher(s) |
|---|----------|-----------------|--------------|------------------------------|------------|
| T1 | Synth spinner → permanent summary (TTY) | `cdktn synth` (`CI` unset, PTY) | none | raw out has cursor-hide `\x1b[?25l` + an eraseLines seq + ≥1 spinner frame (`⠋`…); final line `Generated Terraform code for the stacks: …` | `term.out`→`toContainOutput("\x1b[?25l")`, `toContainOutput("⠋",{timeout})`; `term.screen`→`toContainText("Generated Terraform code")` |
| T2 | List spinner → 2-col Stack/Path table (TTY) | `cdktn list` (PTY) | none | spinner lifecycle, then bold `Stack name` / `Path` header, name col padded to `max(floor(cols*0.4), longestName+2)` | `term.row(n)`→`toContainText("Stack name")`; `term.cell(...)`→`toHaveAttrs({bold:true})` on header; `toMatchLines([...])` for layout |
| T3 | Provider list `cli-table3` table | `cdktn provider list` (works even piped/CI) | none | bordered box-drawing table; heads `Provider Name/Provider Version/CDKTF/CDKTN/Constraint/Package Name/Package Version` | `term.screen`→`toContainText("Provider Name")`, `toMatchLines([...])`; box chars via `toContainText("─")` |
| T4 | Provider list empty | `cdktn provider list` on empty fixture | none | literal `No providers found.` | `term.screen`→`toHaveText("No providers found.")`; unit: `renderProviderTable([])===""` |
| T5 | Provider list `--json` | `cdktn provider list --json` | none | raw JSON, no table/box chars | parse `term.screen.getText()` via `JSON.parse`; `term.out`→`not.toContainOutput("─")` |
| T6 | log-above / bar-below interleave (TTY) | `cdktn deploy --auto-approve` (PTY) | none | log lines scroll into scrollback **above** a pinned bottom bar; bar erased+repainted (`eraseLines(barLines+1)`) per log; colored bold stack-name prefix | `term.scrollback`→`toContainText(logtext)`; `term.row(term.rows-1)`→`toContainText(bartext)`; `toBeAtBottomOfScrollback()`; `toHaveScrollbackLines(n)` |
| T7 | Deploy bar counter text | `cdktn deploy --auto-approve`, multi-stack | none | bar reads `N Stacks deploying  M Stacks done  K Stacks waiting` (singular/plural) | `term.row(term.rows-1)`→`toContainText("Stacks deploying",{timeout})`; unit `renderExecution`/`localizeStacks` for 1 vs N |
| T8 | Cursor hygiene | `cdktn synth` (PTY) | none | exactly one `\x1b[?25l` and matching show `\x1b[?25h`; summary not overlapping bar | `term.out`→`toContainOutput("\x1b[?25h")`; count occurrences in `term.out`; final `term.screen` clean |
| T9 | Approve routing | `cdktn deploy` (PTY, `CI` unset, no `--auto-approve`) | `Enter` (Approve is first) | `select` titled `Please review the diff output above for <stack>` w/ Approve/Dismiss/Stop; apply proceeds | `term.screen`→`toContainText("Please review the diff output above")`; highlighted row `term.cell`→`toHaveAttrs({inverse:true})`; after Enter `toContainText(applylog,{timeout})` |
| T10 | Dismiss routing | `cdktn deploy` (PTY) multi-stack | `ArrowDown`,`Enter` (`\x1b[B\r`) | `status.dismiss()`: stack not applied, dependents blocked from planning | assert downstream stack never plans: `term.screen`→`not.toContainText(dependentPlanLog,{timeout})` |
| T11 | Stop routing | `cdktn deploy` (PTY) multi-stack | `ArrowDown`×2,`Enter` | `status.stop()`: running stacks finish, no new start | pending stack never starts: `not.toContainText(pendingStartLog)` |
| T12 | Sentinel soft-fail override (TTY) | `cdktn deploy` (PTY) sentinel fixture | arrow + `Enter` | `promptOverride` menu `Please review the above failures for <stack>` w/ Override/Reject → `override()`/`reject()` | `term.screen`→`toContainText("Please review the above failures")`; route via resulting behavior |
| T13 | `--auto-approve` unattended | `cdktn deploy --auto-approve` (piped or PTY) | none | **no** prompt rendered; runs to completion; `pause()`/`resume()` never invoked | `term.screen`→`not.toContainText("Please review")`; assert exit=0 |
| T14 | Non-TTY piped stdout is ANSI-free, no hang | `cdktn deploy --auto-approve`, stdout piped / `CI=1` | none | **no** `\x1b[`, no eraseLines, no cursor hide; each log exactly one `line\n`; process exits | `term.out`→`not.toContainOutput("\x1b[")`; poll `term.exitInfo` → `exit=0`; assert spinner interval `unref`'d (no loop hold) |
| T15 | Detached/piped stdin, no `--auto-approve` → clean stop | `cdktn deploy` with **stdin not a TTY** | none (stdin closed) | `requireTty()` throws `PROMPT_NEEDS_TTY`; caught via `isNonTtyError`; stderr `Approval required but stdin is not a TTY. Re-run with --auto-approve. Stopping.`; `status.stop()`; **no hang** | assert stderr match; poll `term.exitInfo` resolves within timeout; not applied |
| T16 | Sentinel non-TTY reject | `cdktn deploy` sentinel, piped stdin | none | stderr `Sentinel override required but stdin is not a TTY. Rejecting.` + `reject()` | stderr match; clean exit |
| T17 | Watch requires auto-approve | `cdktn watch` (no `--auto-approve`) | none | immediate stderr `ERROR: The watch command always automatically deploys and approves changes…` + `exit(1)` | `term.screen`/stderr→`toContainText`; `exitInfo`→`exit=1` |
| T18 | Watch bar states + spinner (TTY) | `cdktn watch --auto-approve` (PTY) | none | bar transitions `Waiting for changes…`(spinner on)→`Synthesizing…`→counter(spinner off)→`Watch was stopped` | `term.row(rows-1)`→`toContainText(...,{timeout})` per state; unit `renderWatchStatus` all branches |
| T19 | Watch Ctrl-C teardown | `cdktn watch --auto-approve` (PTY) | `Ctrl+c` (`\x03`) | `AbortController.abort()`; `finally` removes signal handlers, `stream.stop()` → cursor restored `\x1b[?25h`, bar erased; clean exit | `term.out`→`toContainOutput("\x1b[?25h")`; final `term.screen` no leftover bar; `exitInfo` resolves |
| **R1** | **RISK: inquirer Ctrl-C during approval hangs core-cli** | `cdktn deploy` (PTY, `CI` unset) | reach approval menu, then `Ctrl+c` | `@inquirer/prompts` throws `ExitPromptError` (NOT a non-TTY error); deploy `handleStatus` catch only handles `isNonTtyError`, so it re-throws into a `void`ed promise → unhandledRejection → cli-core deploy promise waits **forever**. Test asserts process **terminates** (resolves/rejects with clear message + restored cursor) within timeout, and **no `unhandledRejection`**. Sentinel `promptOverride` Ctrl-C is the analogous case. | poll `term.exitInfo` with deadline → must become `exit=…`; `term.out`→`toContainOutput("\x1b[?25h")`; register `process.on("unhandledRejection")` guard in test → must not fire. **This test is expected to FAIL against current code (documents the bug).** |
| **R2** | **RISK: helper unit-test gaps** | n/a (pure unit, fake `{isTTY:true,columns,write}` stream) | n/a | No tests exist for `StreamRenderer`, `promptApprove`, `renderProviderTable`, etc. (`helper/__tests__` has only `var-files.test.ts`). Cover: `format.ts` (`renderExecution`/`localizeStacks`, `renderStackList` col math, `renderProviderTable` incl. empty, `renderOutputs`/`renderNested` nesting + `<sensitive>` masking + depth cap, `renderWatchStatus`, `getColor` round-robin), `tty-stream.ts` (`visualRowCount` wrap/ANSI-strip, TTY-vs-non-TTY branch, pause/resume buffering, spinner `unref`, signal add/remove), `prompts.ts` (`isNonTtyError`, `requireTty` message). | plain vitest assertions on `write` call ordering (erase→write(line)→repaint); run with `CI` unset or mock `is-ci` |

---

## 5. Example test files (full code)

### 5a. TTY rendering — provider table + synth spinner

```ts
// test/e2e/render.slow.test.ts
import { describe, test, expect, beforeAll } from "vitest"
import { createTerminal, preloadNodePty } from "@termless/core"
import { createXtermBackend } from "@termless/xtermjs"
import "@termless/test/matchers"

const CDKTN = "/Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bin/cdktn"
const FIXTURE = "/Users/vincentdesmet/cdktn/cdk-terrain/test/typescript/synth-app"

// Spawn helper: PTY-backed terminal, CI unset so the TTY path (tty-stream.ts:42) is live.
function makeTerm(cols = 120, rows = 40) {
  return createTerminal({ backend: createXtermBackend(), cols, rows })
}
const ttyEnv = { CI: "", GITHUB_ACTIONS: "", FORCE_COLOR: "1" }

beforeAll(async () => {
  await preloadNodePty() // fail fast if node-pty native addon is missing
})

describe("TTY rendering", () => {
  test("provider list renders a cli-table3 bordered table", async () => {
    await using term = makeTerm()
    await term.spawn(["node", CDKTN, "provider", "list"], { cwd: FIXTURE, env: ttyEnv })

    // Box-drawing border + column headers from renderProviderTable.
    await expect(term.screen).toContainText("Provider Name", { timeout: 15000 })
    expect(term.screen).toContainText("Package Version")
    expect(term.screen).toContainText("─") // table border glyph
  })

  test("synth shows a spinner then a permanent summary line", async () => {
    await using term = makeTerm()
    await term.spawn(["node", CDKTN, "synth"], { cwd: FIXTURE, env: ttyEnv })

    // Spinner: cursor hidden + at least one cli-spinners 'dots' frame on the raw stream.
    await expect(term.out).toContainOutput("\x1b[?25l", { timeout: 15000 }) // cursor hide
    await expect(term.out).toContainOutput("⠋", { timeout: 15000 })         // a spinner frame

    // Bar is erased on completion; one permanent summary line remains on the grid.
    await expect(term.screen).toContainText(
      "Generated Terraform code for the stacks",
      { timeout: 60000 },
    )
    // Cursor restored at the end.
    await expect(term.out).toContainOutput("\x1b[?25h", { timeout: 60000 })
  })
})
```

### 5b. Interactive deploy-approval — arrow keys + Enter

```ts
// test/e2e/deploy-approve.slow.test.ts
import { describe, test, expect, beforeAll } from "vitest"
import { createTerminal, preloadNodePty } from "@termless/core"
import { createXtermBackend } from "@termless/xtermjs"
import "@termless/test/matchers"

const CDKTN = "/Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bin/cdktn"
const FIXTURE = "/Users/vincentdesmet/cdktn/cdk-terrain/test/typescript/synth-app"
const ttyEnv = { CI: "", GITHUB_ACTIONS: "", FORCE_COLOR: "1" }

beforeAll(async () => { await preloadNodePty() })

describe("interactive deploy approval", () => {
  test("arrow-down to a choice, Enter, and the menu routes correctly", async () => {
    await using term = createTerminal({ backend: createXtermBackend(), cols: 120, rows: 40 })
    // No --auto-approve, CI unset: inquirer select prompt should render under a real TTY.
    await term.spawn(["node", CDKTN, "deploy"], { cwd: FIXTURE, env: ttyEnv })

    // Wait for the @inquirer select titled by deploy.ts.
    await expect(term.screen).toContainText(
      "Please review the diff output above",
      { timeout: 90000 },
    )

    // Approve is the first choice; the highlighted line is inverse-styled.
    // (Find the pointer row by its glyph, then assert styling at the cell level.)
    await expect(term.screen).toContainText("Approve", { timeout: 5000 })

    // Select "Approve" (it is first → just press Enter). Input is fire-and-forget:
    // always assert with an auto-retry matcher afterwards, never read synchronously.
    term.press("Enter") // sends "\r"

    // Routing assertion: Approve → status.approve() → deploy proceeds to apply.
    await expect(term.screen).toContainText("Apply complete", { timeout: 120000 })

    // Process should exit cleanly; poll exitInfo (there is no public exit promise).
    const deadline = Date.now() + 120000
    while (!term.exitInfo && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(term.exitInfo).toContain("exit=")
  })

  // To Dismiss: term.press("ArrowDown"); term.press("Enter")  → "\x1b[B\r"
  // To Stop:    term.press("ArrowDown"); term.press("ArrowDown"); term.press("Enter")
})
```

### 5c. Non-TTY pipe — ANSI-free output + clean exit (and the R1 hang guard)

```ts
// test/e2e/non-tty.slow.test.ts
import { describe, test, expect, beforeAll } from "vitest"
import { createTerminal, preloadNodePty } from "@termless/core"
import { createXtermBackend } from "@termless/xtermjs"
import "@termless/test/matchers"

const CDKTN = "/Users/vincentdesmet/cdktn/cdk-terrain/packages/cdktn-cli/bin/cdktn"
const FIXTURE = "/Users/vincentdesmet/cdktn/cdk-terrain/test/typescript/synth-app"

beforeAll(async () => { await preloadNodePty() })

async function waitExit(term: { exitInfo: string | null }, ms = 60000) {
  const deadline = Date.now() + ms
  while (!term.exitInfo && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return term.exitInfo
}

describe("non-TTY behavior", () => {
  test("CI=1 piped run emits no ANSI escapes and exits without hanging", async () => {
    // NOTE: even over a PTY the child sees isTTY=true; to force the non-TTY render path
    // we set CI=1 (tty gate is `out.isTTY && !isCI`), which is the deterministic switch.
    await using term = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 30 })
    await term.spawn(["node", CDKTN, "deploy", "--auto-approve"], {
      cwd: FIXTURE,
      env: { CI: "1" },
    })

    await expect(term.screen).toContainText("Apply complete", { timeout: 120000 })

    // Raw output stream must be ANSI-free: no CSI, no cursor hide, no eraseLines.
    expect(term.out).not.toContainOutput("\x1b[")
    // No interactive prompt under --auto-approve.
    expect(term.screen).not.toContainText("Please review")

    const exit = await waitExit(term, 120000)
    expect(exit).toContain("exit=") // resolved → no hang (spinner interval is unref'd)
  })

  test("R1: Ctrl-C at the approval menu must terminate, not hang", async () => {
    // Documents the project-runner.ts void-dispatch risk: inquirer ExitPromptError on
    // Ctrl-C is NOT a non-TTY error, so handleStatus re-throws into a void promise and
    // cli-core's deploy promise can wait forever. EXPECTED TO FAIL against current code.
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on("unhandledRejection", onUnhandled)
    try {
      await using term = createTerminal({ backend: createXtermBackend(), cols: 100, rows: 30 })
      await term.spawn(["node", CDKTN, "deploy"], {
        cwd: FIXTURE,
        env: { CI: "", GITHUB_ACTIONS: "" }, // TTY path → real inquirer prompt
      })
      await expect(term.screen).toContainText("Please review the diff output above", {
        timeout: 90000,
      })

      term.press("Ctrl+c") // "\x03" → child tty turns this into ExitPromptError

      const exit = await waitExit(term, 20000)
      expect(exit, "deploy hung after Ctrl-C at approval menu").toContain("exit=")
      // Cursor must be restored even on abrupt cancel.
      await expect(term.out).toContainOutput("\x1b[?25h", { timeout: 5000 })
      expect(unhandled, "swallowed prompt rejection became unhandledRejection").toHaveLength(0)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})
```

> `await using term = …` uses `Symbol.asyncDispose` for cleanup; if your Node/TS target doesn't support it, fall back to `try { … } finally { await term.close() }`. `close()` does SIGTERM → wait 2s → SIGKILL, so it's safe even if the child hung.

---

## 6. CI integration & debugging

### node-pty on CI

- `term.spawn()` needs a Unix PTY → **macOS and Linux runners only, not Windows**. Gate PTY/e2e tests to `ubuntu-latest`/`macos-latest`. Keep any `feed()`-only unit tests (R2 helper tests) on all OSes including Windows.
- node-pty is a native addon: ensure the runner has Python + a C/C++ toolchain (Ubuntu GitHub runners have build-essential; otherwise `apt-get install -y build-essential python3`). Call `preloadNodePty()` in a global `beforeAll` so a missing addon fails the job with the clear actionable error instead of mid-test.
- **Backend choice for CI:** default to **`@termless/xtermjs`** (zero native deps, ships with `@termless/test`). For a leaner hermetic lane, add a **`vt100`** backend (pure TS, zero deps/WASM) — but note it lacks reflow-on-resize/OSC 8, so don't use it for resize-dependent layout tests. **Avoid** all Rust/Zig/Emscripten/native backends (`alacritty`, `wezterm`, `vt100-rust`, `ghostty-native`, `libvterm`, `kitty` — `kitty` is GPL-3.0, non-distributable) in the required gate. Termless is fully headless: no `DISPLAY`, no xvfb, no GPU.
- Example step: `- run: pnpm vitest run -c packages/cdktn-cli/vitest.config.ts` (after `pnpm nx build cdktn-cli`).

### Recording sessions & screenshots on failure

- **SVG (recommended artifact):** `term.screenshotSvg()` — zero deps, vector, diffable as text. In an `afterEach` on failure, write it to the scratchpad/artifacts dir and upload.
- **PNG without the native canvas binding:** `term.screenshotPng()` forces the dependency-light `@resvg/resvg-js` path (cross-platform, no native module). Reserve `term.screenshotCanvasPng()` (ghostty WASM renderer) for byte-stable visual baselines only.
- Also dump `term.screen.getText()` to the log and enable `DEBUG=termless:*` for internal tracing.
- For flaky visual bugs: capture `termless record --frames` and upload the `.rec` / generated `viewer.html` (scrubbable timeline with in-browser pixel-diff — answers "the bar disappeared after frame N, which input caused it?").
- For deterministic, hand-authored regression steps you can drive from a `.tape` (VHS-style `Type`/`Enter`/`Sleep`) and replay with `termless play demo.tape -o out.svg`. Cross-backend parser regressions: `termless compare demo.tape -b vterm,ghostty --compare diff`.

Failure-screenshot hook sketch:

```ts
import { afterEach } from "vitest"
import { writeFileSync } from "node:fs"
// keep a module-level `currentTerm` set by each test, or use a fixture wrapper
afterEach((ctx) => {
  if (ctx.task.result?.state === "fail" && currentTerm) {
    writeFileSync(`./artifacts/${ctx.task.name}.svg`, currentTerm.screenshotSvg())
  }
})
```

### Determinism tips

- **Never sleep** between input and assert — startup varies (100ms local vs 500ms CI). Always use auto-retry matchers (`{ timeout }`, polls every 50ms) or `waitForStable()`. The one polling exception is exit-code: there is no public exit promise, so poll `term.exitInfo` against a deadline.
- **Pin `cols`/`rows`** explicitly (deterministic layout, column-width math, and screenshots). The `renderStackList` padding depends on `columns`, so a fixed width makes T2 stable.
- **Output arrives in chunks** over PTY — don't assert on intermediate spinner frames except via `toContainText(frame, { timeout })`; **never snapshot animated spinner glyphs** (non-deterministic). Use `toMatchTerminalSnapshot` for structure (tables, final prompt states), `toMatchSvgSnapshot` only when color/style is the thing under test.
- Control the TTY/non-TTY branch via env (`CI` set vs unset) since `isCI` is captured at module import — make it explicit per test, never inherit the runner's ambient `CI`.
- Prefer the narrowest region (`term.row(n)`/`term.cell(r,c)`) over `term.screen`, and `toHaveText` (exact) over `toContainText` only where the line is stable.

---

## 7. Recommended rollout

Place the new tests inside the **`cdktn-cli` package** so they live with the code they cover:

```
packages/cdktn-cli/
  vitest.config.ts
  test/e2e/
    vitest.setup.ts            # matcher + serializer registration
    render.slow.test.ts        # T1–T8 TTY rendering (spinner, table, bar)
    deploy-approve.slow.test.ts# T9–T12 prompt routing
    non-tty.slow.test.ts       # T14–T16 piped/detached + R1 hang guard
    watch.slow.test.ts         # T17–T19 watch + Ctrl-C teardown
    fixtures/                  # minimal + multi-stack + sentinel cdktn apps
  src/bin/cmds/helper/__tests__/
    format.test.ts             # R2: renderExecution/localizeStacks/renderStackList/...
    tty-stream.test.ts         # R2: visualRowCount, pause/resume buffering, unref, signals
    prompts.test.ts            # R2: isNonTtyError, requireTty message
```

Naming PTY tests `*.slow.test.ts` keeps them separable from the fast unit suite (run them via a distinct vitest project / CI lane). The R2 helper unit tests use a fake `{ isTTY:true, columns, write }` stream and need **`CI` unset** (or `is-ci` mocked) for the TTY branch — they need no PTY and run everywhere including Windows.

Phased plan:

1. **Phase 0 — helper unit tests (R2), no PTY.** Cheapest, deterministic coverage of the pure functions (`format.ts`, `tty-stream.ts` renderer ordering/buffering/`unref`/signal add-remove, `prompts.ts`). Land these first; they need no build of the CLI and run on all OSes. They also pin the exact behaviors the e2e tests later assert at the screen level.
2. **Phase 1 — smoke e2e.** `--version`, `provider list` table (T3/T4/T5, work even piped), and one TTY synth-spinner test (T1). Proves the build → spawn → matcher pipeline and node-pty install on CI.
3. **Phase 2 — prompt routing.** Approve/Dismiss/Stop (T9–T11), sentinel override (T12), `--auto-approve` (T13), non-TTY clean-stop (T15/T16), watch guard + teardown (T17–T19). **Include the R1 Ctrl-C hang guard here** — expect it to fail against current code; it documents the `project-runner.ts` void-dispatch bug and becomes the regression gate once fixed.
4. **Phase 3 — snapshot regressions.** Add `toMatchTerminalSnapshot` for stable table/prompt layouts and final summaries (T2/T6/T7), and SVG snapshots only where spinner/bar/highlight **color** is the contract. Avoid snapshotting animated frames.

Note where API certainty is lower: the exact apply/plan log strings used as routing assertions (T9–T11), the spinner frame glyph set (`cli-spinners` 'dots' → `⠋⠙…`, **verify** the configured spinner), and whether the vitest test-runner Node version must exceed the repo's `22.22.3` for `@termless/core` (`>=23.6.0`) — **verify** all three against the actual PR #264 source before locking snapshots.