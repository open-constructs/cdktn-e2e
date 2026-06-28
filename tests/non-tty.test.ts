import { describe, test, expect } from "vitest"
import { runPiped } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"

// Non-interactive contract: when stdout is NOT a TTY, output must be ANSI-free,
// one line per log, and must not hang. We spawn with stdout/stderr **piped** (no
// PTY) so the child genuinely sees isTTY=false — over a PTY it always sees a TTY,
// so CI=1-over-PTY can't prove this (the terraform subprocess still emits ANSI).
const ANSI = /\x1b\[/

describe(`non-tty (piped) behaviour [${currentCliId()}]`, () => {
  test("piped synth is ANSI-free and exits 0", async () => {
    const { stdout, code } = await runPiped({ argv: ["synth"], fixture: "minimal-ts", freshState: true })
    expect(code).toBe(0)
    expect(ANSI.test(stdout)).toBe(false)
    expect(stdout).toContain("Generated Terraform code")
  })

  test("piped deploy --auto-approve is ANSI-free, terminates, no prompt", async () => {
    const { stdout, code } = await runPiped({
      argv: ["deploy", "--auto-approve"],
      fixture: "minimal-ts",
      freshState: true,
      timeoutMs: 180_000,
    })
    expect(code).toBe(0) // resolved → no hang
    expect(ANSI.test(stdout)).toBe(false)
    expect(stdout).not.toContain("Please review") // no interactive prompt
  })

  test("piped diff terminates and is ANSI-free", async () => {
    const { stdout, code } = await runPiped({ argv: ["diff"], fixture: "minimal-ts", freshState: true })
    expect(code).not.toBeNull()
    expect(ANSI.test(stdout)).toBe(false)
  })
})
