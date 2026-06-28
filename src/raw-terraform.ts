// Helpers to drive a RAW terraform binary (no cdktn) against the in-process HTTP
// backend mock, with access to the child process so a test can SIGKILL it. Used for
// the #283 "positive control": prove the mock detects an orphaned lock when terraform
// is hard-killed mid-apply (research showed only SIGKILL — not 2×SIGINT — orphans an
// external lock on terraform ≥1.6).
import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { MockBackend } from "./tf-http-backend.js"

/**
 * Write a terraform config whose apply holds the state lock for ~`holdSeconds`
 * (a cross-platform `node -e setTimeout` local-exec), using `backend` as the HTTP
 * backend. terraform_data is built-in — no provider download.
 */
export function writeLockingTf(dir: string, backend: MockBackend, holdSeconds = 15): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "main.tf"),
    `terraform {
  backend "http" {
    address        = "${backend.address}"
    lock_address   = "${backend.lockAddress}"
    unlock_address = "${backend.unlockAddress}"
    lock_method    = "LOCK"
    unlock_method  = "UNLOCK"
  }
}
resource "terraform_data" "hold" {
  provisioner "local-exec" {
    interpreter = ["node", "-e"]
    command     = "setTimeout(() => {}, ${holdSeconds * 1000})"
  }
}
`,
  )
}

/** Run `terraform init` (async, so the in-process mock stays responsive). */
export function terraformInit(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn("terraform", ["init", "-input=false", "-no-color"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let err = ""
    c.stderr.on("data", (d) => (err += d))
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error("terraform init failed: " + err.slice(-300)))))
  })
}

/**
 * Spawn `terraform apply -auto-approve` and return the ChildProcess so the caller can
 * `child.kill("SIGKILL")` it mid-apply (the only thing that orphans an external lock on
 * terraform ≥1.6). The leftover local-exec `node` child is a harmless self-exiting
 * setTimeout.
 */
export function terraformApply(dir: string): ChildProcess {
  return spawn("terraform", ["apply", "-auto-approve", "-no-color"], {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  })
}
