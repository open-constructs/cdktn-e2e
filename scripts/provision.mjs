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
//   monorepo → build the full cdk-terrain monorepo, publish every dist/js/*.tgz
//              to an in-process Verdaccio registry, then install cdktn-cli (and
//              the cdktn lib for fixtures) from it. Because every workspace
//              package is published at its real 0.0.0, the PR head is exercised
//              with full fidelity across ALL packages — not just cdktn-cli.
// Fixtures are copied in and their __FRAMEWORK__/__LIB_SPEC__ placeholders are
// filled to match the CLI, then their deps installed so `synth` can run.

import { execFileSync, spawn } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { runServer } from "verdaccio"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const SANDBOX_ROOT = join(ROOT, ".sandboxes")
const FIXTURES_SRC = join(ROOT, "fixtures")
const FIXTURES = ["minimal-ts", "multi-stack-ts", "locking-http-ts", "provider-list-ts"]

// Minimal mirror of src/versions.ts (kept in JS so this script needs no build).
const MATRIX = {
  "cdktf-prefork": { kind: "npm", cliPackage: "cdktf-cli", cliSpec: "0.21.0", bin: "cdktf", libPackage: "cdktf", libSpec: "0.21.0" },
  "cdktn-latest":  { kind: "npm", cliPackage: "cdktn-cli", cliSpec: "latest", bin: "cdktn", libPackage: "cdktn", libSpec: "latest" },
  "cdktn-next":    { kind: "npm", cliPackage: "cdktn-cli", cliSpec: "next",   bin: "cdktn", libPackage: "cdktn", libSpec: "next" },
  // Use the exact local workspace version for PR-head fixtures. A bare/latest
  // install can fall through to the public npm release if registry metadata is
  // resolved from the uplink, which would invalidate PR-head validation.
  "cdktn-prhead":  { kind: "monorepo", bin: "cdktn", libPackage: "cdktn", libSpec: "0.0.0" },
}

// On Windows, npm/pnpm are .cmd shims that execFileSync can't resolve bare.
const isWin = process.platform === "win32"
const NPM = isWin ? "npm.cmd" : "npm"
const PNPM = isWin ? "pnpm.cmd" : "pnpm"

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env, shell: isWin })

// Async variant: REQUIRED for any child process that talks to the in-process
// Verdaccio (publish, installs while the registry is up). A synchronous
// execFileSync would block this script's event loop, starving the Verdaccio
// HTTP server in the same process and deadlocking the request.
const shAsync = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env, shell: isWin })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`)),
    )
  })

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
  // constructs floor MUST satisfy the lib's peer (cdktn@next → ^10.6.0; cdktf 0.21 →
  // ^10.4.2). With ^10.0.0 some npm builds floor-pin to 10.0.0 and ERESOLVE against
  // cdktn's ^10.6.0 peer (observed on the Windows runner; ubuntu/macOS picked latest
  // 10.x and passed). ^10.6.0 makes the floor itself satisfy the peer on every npm.
  sh(NPM, ["install", "--no-fund", "--no-audit",
    `${entry.cliPackage}@${entry.cliSpec}`,
    `${entry.libPackage}@${entry.libSpec}`,
    "constructs@^10.6.0"], sandbox)

  const installed = readInstalledVersion(sandbox, entry.cliPackage)
  const libVersion = readInstalledVersion(sandbox, entry.libPackage)
  return { version: installed, libVersion }
}

// Resolve the mise binary so subprocesses run under the monorepo's OWN toolchain
// (its mise.toml + .nvmrc pin go/java/node-22). `command -v mise` from a login
// shell is unavailable to execFileSync, so probe the known Homebrew path first.
function miseBin() {
  for (const c of ["/opt/homebrew/bin/mise", "/usr/local/bin/mise"]) {
    if (existsSync(c)) return c
  }
  return "mise" // fall back to PATH
}

// Run a command inside the monorepo under its mise toolchain. cwd=<repo> makes
// mise pick up that repo's mise.toml/.nvmrc (node 22), independent of the host
// e2e toolchain (node 24) this script runs under.
function runInMonorepo(repo, args) {
  execFileSync(miseBin(), ["exec", "--", ...args], {
    cwd: repo,
    stdio: "inherit",
    env: process.env,
  })
}

/**
 * Boot an in-process Verdaccio registry on an ephemeral port. cdktn** / @cdktn/*
 * are served WITHOUT a proxy so the locally-published 0.0.0 wins; everything else
 * proxies npmjs. Storage is a fresh temp dir, cleaned on close.
 *
 * @returns {Promise<{url:string, port:number, authArg:string, close:()=>Promise<void>}>}
 */
async function startRegistry(id) {
  const dir = mkdtempSync(join(tmpdir(), `cdktn-verdaccio-${id}-`))
  const config = {
    // Required by @verdaccio/config even for an object config; used only to
    // resolve relative paths (storage is absolute, so the value is inert).
    configPath: join(dir, "config.yaml"),
    storage: join(dir, "storage"),
    max_body_size: "100mb",
    web: { enable: false },
    self_update: false,
    // htpasswd auth plugin (publishes are anonymous via $all, but verdaccio
    // expects an auth plugin to be configured).
    auth: { htpasswd: { file: join(dir, "htpasswd") } },
    uplinks: { npmjs: { url: "https://registry.npmjs.org/" } },
    packages: {
      // No proxy → local 0.0.0 wins.
      "cdktn**": { access: "$all", publish: "$all", unpublish: "$all" },
      "@cdktn/*": { access: "$all", publish: "$all", unpublish: "$all" },
      // Everything else (constructs, tsx, jsii deps, …) proxies npmjs.
      "**": { access: "$all", publish: "$all", unpublish: "$all", proxy: "npmjs" },
    },
    log: { type: "stdout", format: "pretty", level: "warn" },
  }
  const app = await runServer(config)
  // Bind explicitly to 127.0.0.1 (IPv4). The default `listen(0)` binds IPv6
  // `::`, which the npm client fails to reach (its fetch agent hangs), so npm
  // would time out talking to the registry.
  const server = await new Promise((res, rej) => {
    const s = app.listen(0, "127.0.0.1", () => res(s)) // port 0 → OS picks a free port
    s.once("error", rej)
  })
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/`
  // npm refuses to publish (ENEEDAUTH) without a token for the target registry
  // even though Verdaccio allows anonymous publish — pass a dummy one inline.
  const authArg = `--//127.0.0.1:${port}/:_authToken=dummy`
  return {
    url,
    port,
    authArg,
    close: async () => {
      await new Promise((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function provisionMonorepo(id, entry, sandbox) {
  const repo = entry.monorepoPath || process.env.CDKTN_MONOREPO
  if (!repo) throw new Error(`${id}: set CDKTN_MONOREPO to a cdk-terrain checkout (PR head).`)
  const cli = join(repo, "packages", "cdktn-cli")
  if (!existsSync(cli)) throw new Error(`${id}: ${cli} not found — is CDKTN_MONOREPO a cdk-terrain checkout?`)

  // 1. Build + JS-package the WHOLE monorepo under its own toolchain. `nx reset`
  //    is a critical cache-bust: nx can otherwise serve a stale bundle carried
  //    across checkouts, silently validating the wrong code.
  console.log(`[${id}] building monorepo at ${repo} (mise toolchain) …`)
  const t0 = Date.now()
  runInMonorepo(repo, [PNPM, "install", "--frozen-lockfile=false"])
  runInMonorepo(repo, [PNPM, "nx", "reset"])
  runInMonorepo(repo, [PNPM, "run", "build"])
  runInMonorepo(repo, [PNPM, "run", "package:js"]) // → <repo>/dist/js/*.tgz
  console.log(`[${id}] build done in ${((Date.now() - t0) / 1000).toFixed(0)}s`)

  const distJs = join(repo, "dist", "js")
  const tarballs = readdirSync(distJs).filter((f) => f.endsWith(".tgz")).map((f) => join(distJs, f))
  if (tarballs.length === 0) throw new Error(`${id}: no tarballs in ${distJs} after package:js`)

  // 2. Boot Verdaccio and publish every workspace tarball (all at 0.0.0) to it.
  const registry = await startRegistry(id)
  try {
    console.log(`[${id}] publishing ${tarballs.length} tarball(s) to ${registry.url}`)
    // Async (shAsync): these run against the in-process Verdaccio — see shAsync.
    for (const tarball of tarballs) {
      await shAsync(NPM, ["publish", `--registry=${registry.url}`, registry.authArg, "--force", tarball])
    }

    // 3. Install cdktn-cli (+ the cdktn lib) from the local registry. Everything
    //    cdktn* is 0.0.0=latest there; constructs proxies from npmjs. No version
    //    overrides needed — Verdaccio serves the real 0.0.0.
    mkdirSync(sandbox, { recursive: true })
    writeFileSync(
      join(sandbox, "package.json"),
      JSON.stringify({ name: `sandbox-${id}`, private: true, version: "0.0.0" }, null, 2),
    )
    // cdktn-cli peer-deps cdktn@0.0.0; legacy-peer-deps avoids ERESOLVE.
    // Install local tarballs directly so npm cannot satisfy bare/latest/exact
    // specs from the public uplink. Installing every workspace tarball top-level
    // also satisfies internal @cdktn/* 0.0.0 dependencies from local artifacts.
    writeRegistryNpmrc(sandbox, registry)
    await shAsync(NPM, ["install", "--no-fund", "--no-audit",
      ...tarballs, "constructs@^10.6.0"], sandbox)
    assertPrheadLocalInstall(sandbox, "cdktn-cli")
    assertPrheadLocalInstall(sandbox, entry.libPackage)
  } catch (err) {
    await registry.close()
    throw err
  }

  const version = readInstalledVersion(sandbox, "cdktn-cli")
  const libVersion = readInstalledVersion(sandbox, entry.libPackage)
  // Keep the registry UP so prepareFixtures can install dependencies while it is
  // still available; the caller closes it afterwards.
  return {
    version: `${version}+prhead`,
    libVersion,
    registry,
    localLibTarball: tarballForPackage(tarballs, entry.libPackage),
  }
}

// Point a sandbox/fixture dir at the local Verdaccio registry, with the dummy
// publish token and legacy-peer-deps (cdktn-cli peer-deps cdktn@0.0.0). The
// host (127.0.0.1) must match the registry URL so npm applies the token.
function writeRegistryNpmrc(dir, registry) {
  writeFileSync(
    join(dir, ".npmrc"),
    [
      `registry=${registry.url}`,
      `//127.0.0.1:${registry.port}/:_authToken=dummy`,
      "legacy-peer-deps=true",
      "",
    ].join("\n"),
  )
}

function readInstalledVersion(sandbox, pkg) {
  try {
    const p = join(sandbox, "node_modules", pkg, "package.json")
    return JSON.parse(readFileSync(p, "utf8")).version
  } catch {
    return "unknown"
  }
}

function lockResolution(sandbox, pkg) {
  try {
    const lock = JSON.parse(readFileSync(join(sandbox, "package-lock.json"), "utf8"))
    return lock.packages?.[`node_modules/${pkg}`]?.resolved || ""
  } catch {
    return ""
  }
}

function assertPrheadLocalInstall(sandbox, pkg, expectedVersion = "0.0.0") {
  const version = readInstalledVersion(sandbox, pkg)
  if (version !== expectedVersion) {
    throw new Error(`${pkg}: expected local PR-head version ${expectedVersion}, got ${version}`)
  }

  const resolved = lockResolution(sandbox, pkg)
  if (resolved.includes("registry.npmjs.org")) {
    throw new Error(`${pkg}: package-lock resolved to public npm (${resolved}); refusing to treat this as PR-head`)
  }
}

function tarballForPackage(tarballs, pkg) {
  const found = tarballs.find((tarball) => {
    const name = basename(tarball)
    return pkg === "cdktn"
      ? name.startsWith("cdktn@0.0.0") || name === "cdktn-0.0.0.tgz"
      : name === `${pkg}-0.0.0.tgz`
  })
  if (!found) throw new Error(`no local tarball found for ${pkg}`)
  return found
}

async function prepareFixtures(id, entry, sandbox, registry, localLibTarball = null) {
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
    // For the monorepo (prhead) kind, install the local lib tarball directly so
    // fixture code also exercises the PR-head 0.0.0 build rather than npm's
    // published release. shAsync: installs may talk to the in-process Verdaccio
    // for transitive workspace dependencies (see shAsync).
    if (registry) writeRegistryNpmrc(to, registry)
    if (localLibTarball) {
      await shAsync(NPM, ["install", "--no-fund", "--no-audit", localLibTarball,
        "constructs@^10.6.0", "tsx@^4.19.0", "typescript@^5.7.0"], to)
      assertPrheadLocalInstall(to, entry.libPackage)
    } else {
      await shAsync(NPM, ["install", "--no-fund", "--no-audit"], to)
    }
    // The fixture's deps are now installed; drop the .npmrc so it no longer
    // references the ephemeral registry (gone after provisioning).
    if (registry) rmSync(join(to, ".npmrc"), { force: true })
  }
}

async function provisionOne(id) {
  const base = MATRIX[id]
  if (!base) throw new Error(`Unknown id "${id}". Known: ${Object.keys(MATRIX).join(", ")}`)
  const entry = { ...base, monorepoPath: process.env.CDKTN_MONOREPO }
  const sandbox = join(SANDBOX_ROOT, id)
  console.log(`\n=== provisioning ${id} (${entry.kind}) ===`)
  rmSync(sandbox, { recursive: true, force: true })

  // monorepo provisioning keeps a local Verdaccio registry up until fixtures are
  // prepared so any transitive workspace package lookups can still resolve locally.
  let registry = null
  let version, libVersion, localLibTarball
  if (entry.kind === "monorepo") {
    const r = await provisionMonorepo(id, entry, sandbox)
    ;({ version, libVersion, registry, localLibTarball } = r)
  } else {
    ;({ version, libVersion } = provisionNpm(id, entry, sandbox))
  }

  try {
    await prepareFixtures(id, entry, sandbox, registry, localLibTarball)
  } finally {
    if (registry) await registry.close()
  }

  // Finalise the sandbox .npmrc: the ephemeral registry is gone now, so keep only
  // legacy-peer-deps (cdktn-cli peer-deps cdktn@0.0.0) and drop the dead registry.
  if (registry) {
    writeFileSync(join(sandbox, ".npmrc"), "legacy-peer-deps=true\n")
  }

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
for (const id of ids) await provisionOne(id)
