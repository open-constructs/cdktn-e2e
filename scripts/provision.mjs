#!/usr/bin/env node
// Provision one CLI-under-test into .sandboxes/<id>/ and write its manifest.json.
// This is the ONLY step that hits the network or builds anything; tests then run
// hermetically against the manifest. Idempotent: re-running re-installs cleanly.
//
//   node scripts/provision.mjs cdktn-next
//   node scripts/provision.mjs cdktn-latest cdktf-prefork      # several at once
//   CDKTN_MONOREPO=/path/to/cdk-terrain node scripts/provision.mjs cdktn-prhead
//
// Strategy per kind:
//   npm      → install <cliPackage>@<cliSpec> into the sandbox, capture the bin.
//   monorepo → `pnpm pack` cdktn-cli from a local checkout, install the tarball.
// Fixtures are copied in and their __FRAMEWORK__/__LIB_SPEC__ placeholders are
// filled to match the CLI, then their deps installed so `synth` can run.

import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const SANDBOX_ROOT = join(ROOT, ".sandboxes")
const FIXTURES_SRC = join(ROOT, "fixtures")
const FIXTURES = ["minimal-ts", "multi-stack-ts", "locking-http-ts"]

// Minimal mirror of src/versions.ts (kept in JS so this script needs no build).
const MATRIX = {
  "cdktf-prefork": { kind: "npm", cliPackage: "cdktf-cli", cliSpec: "0.21.0", bin: "cdktf", libPackage: "cdktf", libSpec: "0.21.0" },
  "cdktn-latest":  { kind: "npm", cliPackage: "cdktn-cli", cliSpec: "latest", bin: "cdktn", libPackage: "cdktn", libSpec: "latest" },
  "cdktn-next":    { kind: "npm", cliPackage: "cdktn-cli", cliSpec: "next",   bin: "cdktn", libPackage: "cdktn", libSpec: "next" },
  "cdktn-prhead":  { kind: "monorepo", bin: "cdktn", libPackage: "cdktn", libSpec: "next" },
}

// On Windows, npm/pnpm are .cmd shims that execFileSync can't resolve bare.
const isWin = process.platform === "win32"
const NPM = isWin ? "npm.cmd" : "npm"
const PNPM = isWin ? "pnpm.cmd" : "pnpm"

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env, shell: isWin })

/** Resolve a package's bin entry to its absolute JS file (spawned as `node <file>`). */
function resolveBinJs(sandbox, cliPackage, binName) {
  const pkgDir = join(sandbox, "node_modules", cliPackage)
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName]
  if (!rel) throw new Error(`${cliPackage} declares no bin "${binName}"`)
  return join(pkgDir, rel)
}

function provisionNpm(id, entry, sandbox) {
  mkdirSync(sandbox, { recursive: true })
  writeFileSync(
    join(sandbox, "package.json"),
    JSON.stringify({ name: `sandbox-${id}`, private: true, version: "0.0.0" }, null, 2),
  )
  // Install the CLI (its bin lands in node_modules/.bin) plus the matching library.
  sh(NPM, ["install", "--no-fund", "--no-audit",
    `${entry.cliPackage}@${entry.cliSpec}`,
    `${entry.libPackage}@${entry.libSpec}`,
    "constructs@^10.0.0"], sandbox)

  const installed = readInstalledVersion(sandbox, entry.cliPackage)
  const libVersion = readInstalledVersion(sandbox, entry.libPackage)
  return { version: installed, libVersion }
}

function provisionMonorepo(id, entry, sandbox) {
  const repo = entry.monorepoPath || process.env.CDKTN_MONOREPO
  if (!repo) throw new Error(`${id}: set CDKTN_MONOREPO to a cdk-terrain checkout (PR head).`)
  const cli = join(repo, "packages", "cdktn-cli")
  if (!existsSync(cli)) throw new Error(`${id}: ${cli} not found — is CDKTN_MONOREPO a cdk-terrain checkout?`)

  // Build + pack the PR-head CLI. `package.sh` => dist/js/cdktn-cli-<v>.tgz.
  console.log(`[${id}] building + packing cdktn-cli from ${repo} …`)
  sh(PNPM, ["install", "--frozen-lockfile=false"], repo)
  sh(PNPM, ["nx", "build", "cdktn-cli"], repo)
  sh(PNPM, ["--filter", "cdktn-cli", "package"], repo)
  const distJs = join(cli, "dist", "js")
  const tgz = readdirSync(distJs).find((f) => f.endsWith(".tgz"))
  if (!tgz) throw new Error(`${id}: no tarball in ${distJs}`)
  const tarball = join(distJs, tgz)

  mkdirSync(sandbox, { recursive: true })
  // The packed tarball pins workspace deps (@cdktn/*) at "0.0.0", which isn't on
  // npm; override them to the published `next` line so the install resolves. The
  // PR fix lives in cdktn-cli's bundle, not these native helpers, so this is faithful.
  const CDKTN_PUBLISHED = process.env.CDKTN_PUBLISHED_VERSION || "0.24.0-pre.60"
  writeFileSync(
    join(sandbox, "package.json"),
    JSON.stringify({
      name: `sandbox-${id}`, private: true, version: "0.0.0",
      overrides: {
        "@cdktn/hcl-tools": CDKTN_PUBLISHED,
        "@cdktn/hcl2json": CDKTN_PUBLISHED,
        "@cdktn/hcl2cdk": CDKTN_PUBLISHED,
      },
    }, null, 2),
  )
  // Install the packed PR-head CLI tarball. Its externalised deps (cdktn, @cdktn/*,
  // jsii, yargs, constructs) resolve from npm per cdktn-cli's own ranges — the PR's
  // changes live inside cdktn-cli, so this faithfully exercises the PR head.
  sh(NPM, ["install", "--no-fund", "--no-audit", tarball,
    `${entry.libPackage}@${entry.libSpec}`, "constructs@^10.0.0"], sandbox)

  const version = readInstalledVersion(sandbox, "cdktn-cli")
  const libVersion = readInstalledVersion(sandbox, entry.libPackage)
  return { version: `${version}+prhead`, libVersion }
}

function readInstalledVersion(sandbox, pkg) {
  try {
    const p = join(sandbox, "node_modules", pkg, "package.json")
    return JSON.parse(readFileSync(p, "utf8")).version
  } catch {
    return "unknown"
  }
}

function prepareFixtures(id, entry, sandbox) {
  const dest = join(sandbox, "fixtures")
  rmSync(dest, { recursive: true, force: true })
  for (const name of FIXTURES) {
    const from = join(FIXTURES_SRC, name)
    const to = join(dest, name)
    cpSync(from, to, { recursive: true })

    // Rewrite the framework import to match the CLI under test.
    const main = join(to, "main.ts")
    writeFileSync(main, readFileSync(main, "utf8").replaceAll("__FRAMEWORK__", entry.libPackage))

    // Materialise package.json from the template and install the lib so synth runs.
    const tmpl = join(to, "package.json.tmpl")
    const pkg = readFileSync(tmpl, "utf8")
      .replaceAll("__FRAMEWORK__", entry.libPackage)
      .replaceAll("__LIB_SPEC__", entry.libSpec)
    writeFileSync(join(to, "package.json"), pkg)
    rmSync(tmpl, { force: true })
    sh(NPM, ["install", "--no-fund", "--no-audit"], to)
  }
}

function provisionOne(id) {
  const base = MATRIX[id]
  if (!base) throw new Error(`Unknown id "${id}". Known: ${Object.keys(MATRIX).join(", ")}`)
  const entry = { ...base, monorepoPath: process.env.CDKTN_MONOREPO }
  const sandbox = join(SANDBOX_ROOT, id)
  console.log(`\n=== provisioning ${id} (${entry.kind}) ===`)
  rmSync(sandbox, { recursive: true, force: true })

  const { version, libVersion } =
    entry.kind === "monorepo"
      ? provisionMonorepo(id, entry, sandbox)
      : provisionNpm(id, entry, sandbox)

  prepareFixtures(id, entry, sandbox)

  // Resolve the bin's JS entry (spawned cross-platform as `node <file>`), not the
  // platform .bin shim (a non-node-runnable .cmd/sh on Windows).
  const cliPackage = entry.kind === "monorepo" ? "cdktn-cli" : entry.cliPackage
  const binPath = resolveBinJs(sandbox, cliPackage, entry.bin)
  if (!existsSync(binPath)) throw new Error(`${id}: expected bin js at ${binPath} after install`)

  const manifest = {
    id,
    binPath,
    binName: entry.bin,
    version,
    libPackage: entry.libPackage,
    libVersion,
    sandboxDir: sandbox,
    provisionedAt: new Date().toISOString(),
  }
  writeFileSync(join(sandbox, "manifest.json"), JSON.stringify(manifest, null, 2))
  console.log(`[${id}] ready → ${entry.bin} ${version} (lib ${entry.libPackage}@${libVersion})`)
}

const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error("usage: provision.mjs <id> [<id> ...]   ids: " + Object.keys(MATRIX).join(", "))
  process.exit(2)
}
for (const id of ids) provisionOne(id)
