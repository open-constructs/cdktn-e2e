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
  let cli: ProvisionedCli
  try {
    cli = JSON.parse(readFileSync(p, "utf8")) as ProvisionedCli
  } catch {
    throw new Error(
      `No provisioned sandbox for "${id}" at ${p}.\n` +
        `Run:  pnpm provision ${id}\n` +
        `(or set CLI_ID and run the matching provision step in CI).`,
    )
  }
  assertManifestMatchesPrheadInstall(cli)
  return cli
}

function readPackageVersion(sandboxDir: string, pkg: string): string {
  const pkgJson = join(sandboxDir, "node_modules", pkg, "package.json")
  return JSON.parse(readFileSync(pkgJson, "utf8")).version as string
}

function assertManifestMatchesPrheadInstall(cli: ProvisionedCli): void {
  if (cli.id !== "cdktn-prhead") return

  const cliVersion = readPackageVersion(cli.sandboxDir, "cdktn-cli")
  const libVersion = readPackageVersion(cli.sandboxDir, cli.libPackage)
  const expectedManifestVersion = `${cliVersion}+prhead`

  if (cliVersion !== "0.0.0" || libVersion !== "0.0.0") {
    throw new Error(
      `cdktn-prhead sandbox is not using local PR-head artifacts: ` +
        `cdktn-cli@${cliVersion}, ${cli.libPackage}@${libVersion}. ` +
        `Run: pnpm provision cdktn-prhead`,
    )
  }

  if (cli.version !== expectedManifestVersion || cli.libVersion !== libVersion) {
    throw new Error(
      `cdktn-prhead manifest is stale or inconsistent: ` +
        `manifest cdktn-cli=${cli.version}, ${cli.libPackage}=${cli.libVersion}; ` +
        `installed cdktn-cli=${cliVersion}, ${cli.libPackage}=${libVersion}. ` +
        `Run: pnpm provision cdktn-prhead`,
    )
  }
}

/** Absolute path to a prepared fixture dir inside the CLI's sandbox. */
export function fixtureDir(id: string, fixture: string): string {
  return join(SANDBOX_ROOT, id, "fixtures", fixture)
}
