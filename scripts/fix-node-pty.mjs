#!/usr/bin/env node
// pnpm's content-addressable store drops the executable bit on node-pty's prebuilt
// `spawn-helper` binary (and pnpm gates dependency build scripts by default), so
// node-pty fails at spawn time with `posix_spawnp failed` (EACCES on the helper).
// Restore +x after every install. Runs as this package's postinstall.
import { execSync } from "node:child_process"
import { platform } from "node:os"

if (platform() === "win32") process.exit(0) // Windows uses conpty, no spawn-helper

try {
  execSync(
    "find node_modules -type f -path '*node-pty*/prebuilds/*/spawn-helper' -exec chmod +x {} +",
    { stdio: "inherit" },
  )
} catch (err) {
  console.warn("[fix-node-pty] could not chmod spawn-helper:", err?.message ?? err)
}
