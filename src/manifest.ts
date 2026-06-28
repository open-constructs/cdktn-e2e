// The provisioning step (scripts/provision.mjs) installs each CLI under test into
// .sandboxes/<id>/ and records the result here. Tests read this — they never touch
// the network or build anything, so test execution stays pure and fast.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, "..")
export const SANDBOX_ROOT = join(REPO_ROOT, ".sandboxes")

export interface ProvisionedCli {
  id: string
  /** Absolute path to the executable to spawn (e.g. .sandboxes/<id>/node_modules/.bin/cdktn). */
  binPath: string
  /** "cdktf" | "cdktn" — also the argv[0] basename. */
  binName: string
  /** Resolved concrete version actually installed (e.g. "0.24.0-pre.60"). */
  version: string
  /** Construct-library package the fixtures import from. */
  libPackage: string
  libVersion: string
  /** Absolute path to the sandbox dir holding prepared fixtures. */
  sandboxDir: string
  provisionedAt: string
}

export function manifestPath(id: string): string {
  return join(SANDBOX_ROOT, id, "manifest.json")
}

export function readManifest(id: string): ProvisionedCli {
  const p = manifestPath(id)
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProvisionedCli
  } catch {
    throw new Error(
      `No provisioned sandbox for "${id}" at ${p}.\n` +
        `Run:  pnpm provision ${id}\n` +
        `(or set CLI_ID and run the matching provision step in CI).`,
    )
  }
}

/** Absolute path to a prepared fixture dir inside the CLI's sandbox. */
export function fixtureDir(id: string, fixture: string): string {
  return join(SANDBOX_ROOT, id, "fixtures", fixture)
}
