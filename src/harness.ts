// Test-facing helpers: spawn the CLI-under-test over a PTY-backed headless terminal
// and wait for it to exit. Everything a test needs is here so the *.test.ts files
// stay declarative.
import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { createTerminal, type Terminal } from "@termless/core"
import { createXtermBackend } from "@termless/xtermjs"
import { currentCliId, matrixEntry } from "./versions.js"
import { readManifest, fixtureDir, type ProvisionedCli } from "./manifest.js"

/**
 * Reset a fixture's terraform state between tests: remove `cdktf.out` (synth output,
 * tfstate, and the `.terraform.tfstate.lock.info` lock all live under it). Tests that
 * deploy/destroy/watch the same fixture otherwise contend on a leftover state lock
 * (e.g. from a Ctrl-C test that killed terraform mid-apply).
 */
export function resetFixtureState(id: string, fixture: string): void {
  rmSync(join(fixtureDir(id, fixture), "cdktf.out"), { recursive: true, force: true })
}

/**
 * Env that forces the CLI's *interactive TTY* render path.
 * The CLI gates its bar/spinner on `stdout.isTTY && !isCI` (tty-stream.ts), and
 * `isCI` is read at module import — so we must scrub every CI signal, not just CI.
 */
export const TTY_ENV: Record<string, string> = {
  CI: "",
  GITHUB_ACTIONS: "",
  GITLAB_CI: "",
  BUILDKITE: "",
  CONTINUOUS_INTEGRATION: "",
  FORCE_COLOR: "1",
  TERM: "xterm-256color",
}

/**
 * Env that forces the *non-interactive* path deterministically even though a PTY
 * makes isTTY true. The CLI suppresses ANSI/spinner when isCI is set.
 */
export const NONTTY_ENV: Record<string, string> = {
  CI: "1",
}

/** process.env with `undefined` values dropped, for node-pty (wants Record<string,string>). */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v
  return out
}

export interface SpawnArgs {
  /** CLI subcommand + flags, e.g. ["deploy", "--auto-approve"]. */
  argv: string[]
  /** Which fixture app to run in (its prepared dir becomes cwd). */
  fixture: string
  /** Extra env merged on top of the chosen base env. */
  env?: Record<string, string>
  /** TTY (default) vs forced non-TTY render path. */
  mode?: "tty" | "non-tty"
  cols?: number
  rows?: number
  /** Override the CLI under test; defaults to CLI_ID / DEFAULT_CLI_ID. */
  id?: string
  /** Wipe the fixture's terraform state (cdktf.out) before spawning. */
  freshState?: boolean
}

export interface CliSession {
  term: Terminal
  cli: ProvisionedCli
  /** The exact argv that was spawned (bin + args), for diagnostics. */
  command: string[]
}

/**
 * Terminals spawned in the current test, newest last. The afterEach hook in
 * src/setup.ts screenshots these to artifacts/ when a test fails.
 */
export const activeTerminals: Array<{ term: Terminal; command: string[] }> = []
export function resetActiveTerminals(): void {
  activeTerminals.length = 0
}

/**
 * Resolve the CLI-under-test, prepare a PTY-backed xterm terminal, and spawn the
 * command inside the requested fixture. Returns the live terminal to assert on.
 *
 * Always pair `term.press(...)`/`type(...)` with an auto-retry matcher afterwards
 * — input is fire-and-forget; never read the screen synchronously after sending.
 */
export async function spawnCli(args: SpawnArgs): Promise<CliSession> {
  const id = args.id ?? currentCliId()
  matrixEntry(id) // validates id early with a helpful error
  const cli = readManifest(id)
  const cwd = fixtureDir(id, args.fixture)
  if (args.freshState) resetFixtureState(id, args.fixture)

  // node-pty replaces the child environment with whatever we pass, so inherit
  // process.env (PATH/HOME/…) and let the mode/base overrides (CI, FORCE_COLOR, …)
  // win over it.
  const base = args.mode === "non-tty" ? NONTTY_ENV : TTY_ENV
  const env = { ...inheritedEnv(), ...base, ...(args.env ?? {}) }

  const term = createTerminal({
    backend: createXtermBackend(),
    cols: args.cols ?? 120,
    rows: args.rows ?? 40,
  })

  // Spawn `node <bin-js>` rather than the platform bin shim: cross-platform
  // (the .bin/*.cmd / sh shim isn't node-runnable on Windows) and independent of
  // the runner's PATH. `cli.binPath` is the package's resolved bin JS entry.
  const command = [process.execPath, cli.binPath, ...args.argv]
  activeTerminals.push({ term, command })
  await term.spawn(command, { cwd, env })
  return { term, cli, command }
}

/**
 * Poll until the child exits (termless exposes `exitInfo: string | null`, not a
 * promise). Returns the exit descriptor, or null on timeout — a null here is the
 * canonical "the CLI hung" signal the anti-hang regression tests assert against.
 */
export async function waitExit(
  term: Terminal,
  ms = 120_000,
): Promise<string | null> {
  const deadline = Date.now() + ms
  while (term.exitInfo === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return term.exitInfo
}

export interface PipedResult {
  stdout: string
  stderr: string
  code: number | null
}

/**
 * Run the CLI with stdout/stderr **piped** (no PTY) — the genuine non-interactive
 * path: the child sees `isTTY === false`, so cdktn suppresses its bar AND the
 * terraform subprocess emits no ANSI either. Use this (not a PTY + CI=1) to assert
 * the "piped output is ANSI-free" contract — over a PTY the child always sees a TTY.
 */
export async function runPiped(args: {
  argv: string[]
  fixture: string
  env?: Record<string, string>
  id?: string
  freshState?: boolean
  timeoutMs?: number
}): Promise<PipedResult> {
  const id = args.id ?? currentCliId()
  const cli = readManifest(id)
  const cwd = fixtureDir(id, args.fixture)
  if (args.freshState) resetFixtureState(id, args.fixture)
  const env = { ...inheritedEnv(), ...(args.env ?? {}) }

  return new Promise<PipedResult>((resolve) => {
    const child = spawn(process.execPath, [cli.binPath, ...args.argv], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"], // stdin closed → also exercises detached-stdin paths
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), args.timeoutMs ?? 120_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

/** Parse termless `exitInfo` ("exit=<code>" | null) into a numeric code, or null. */
export function exitCodeOf(info: string | null): number | null {
  const m = info?.match(/^exit=(-?\d+)$/)
  return m ? Number(m[1]) : null
}

/** True when termless reports a clean zero exit ("exit=0"). */
export function exitedCleanly(info: string | null): boolean {
  return exitCodeOf(info) === 0
}
