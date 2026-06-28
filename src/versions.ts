// The version matrix. The SAME test suite runs against each entry by selecting it
// via the CLI_ID env var, so behavioural differences across the fork boundary
// (cdktf, Ink-based) and across releases (cdktn current → preview → unmerged PR)
// surface as the same assertions passing/failing.
//
// Resolved npm facts at scaffold time (verify with `npm view <pkg> dist-tags`):
//   cdktf-cli  latest = 0.21.0   (pre-fork baseline, bin `cdktf`, Ink UI)
//   cdktn-cli  latest = 0.23.3   (current release,   bin `cdktn`)
//   cdktn-cli  next   = 0.24.x-pre.N  (preview; new every merge to main)

export type CliKind = "npm" | "monorepo"

export interface CliMatrixEntry {
  /** Stable id used as CLI_ID and as the sandbox directory name. */
  id: string
  /** Human label for reports. */
  label: string
  kind: CliKind
  /** npm package that provides the binary (npm kind only). */
  cliPackage?: "cdktf-cli" | "cdktn-cli"
  /** npm spec to install: an exact version, or a dist-tag like "latest"/"next". */
  cliSpec?: string
  /** Executable name on PATH inside the sandbox: `cdktf` or `cdktn`. */
  bin: "cdktf" | "cdktn"
  /** Construct-library package the fixture app imports from. */
  libPackage: "cdktf" | "cdktn"
  /** npm spec for the library (kept in lockstep with the CLI). */
  libSpec?: string
  /**
   * monorepo kind only: absolute path to a cdk-terrain checkout (a PR head).
   * provision.mjs builds + `pnpm pack`s cdktn-cli there and installs the tarball.
   * Defaults to the CDKTN_MONOREPO env var.
   */
  monorepoPath?: string
  /** Free-text note for the design doc / report. */
  note: string
}

export const MATRIX: Record<string, CliMatrixEntry> = {
  "cdktf-prefork": {
    id: "cdktf-prefork",
    label: "cdktf-cli (pre-fork baseline, Ink)",
    kind: "npm",
    cliPackage: "cdktf-cli",
    cliSpec: "0.21.0",
    bin: "cdktf",
    libPackage: "cdktf",
    libSpec: "0.21.0",
    note: "Original HashiCorp CDKTF, still Ink/React. Baseline to compare UX deltas the React→inquirer swap introduces.",
  },
  "cdktn-latest": {
    id: "cdktn-latest",
    label: "cdktn-cli (current release)",
    kind: "npm",
    cliPackage: "cdktn-cli",
    cliSpec: "latest",
    bin: "cdktn",
    libPackage: "cdktn",
    libSpec: "latest",
    note: "Last published stable. The 'known good' the preview must not regress against.",
  },
  "cdktn-next": {
    id: "cdktn-next",
    label: "cdktn-cli (preview / @next)",
    kind: "npm",
    cliPackage: "cdktn-cli",
    cliSpec: "next",
    bin: "cdktn",
    libPackage: "cdktn",
    libSpec: "next",
    note: "Preview built on every merge to main. The primary nightly target.",
  },
  "cdktn-prhead": {
    id: "cdktn-prhead",
    label: "cdktn-cli (local PR head)",
    kind: "monorepo",
    bin: "cdktn",
    libPackage: "cdktn",
    libSpec: "next",
    note: "Unmerged PR validated before merge: build + pnpm pack cdktn-cli from a local checkout. Set CDKTN_MONOREPO to the checkout path.",
  },
}

export const DEFAULT_CLI_ID = "cdktn-next"

export function currentCliId(): string {
  return process.env.CLI_ID ?? DEFAULT_CLI_ID
}

export function matrixEntry(id: string = currentCliId()): CliMatrixEntry {
  const entry = MATRIX[id]
  if (!entry) {
    throw new Error(
      `Unknown CLI_ID "${id}". Known: ${Object.keys(MATRIX).join(", ")}`,
    )
  }
  return entry
}
