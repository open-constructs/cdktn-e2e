import { describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { spawnSync } from "node:child_process"
import { currentCliId } from "../src/versions.js"
import { readManifest } from "../src/manifest.js"

interface InitResult {
  cwd: string
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  pipfile: string
}

const cliId = currentCliId()
const testCase = cliId === "cdktn-prhead" ? test.skip : cliId.startsWith("cdktn-") ? test.fails : test

function writeExecutable(path: string, unixBody: string, cmdBody: string): void {
  writeFileSync(path, unixBody, { mode: 0o755 })
  writeFileSync(`${path}.cmd`, cmdBody.replace(/\n/g, "\r\n"), { mode: 0o755 })
}

function runPythonInitWithFakePython(id: string): InitResult {
  const cli = readManifest(id)
  const cwd = mkdtempSync(join(tmpdir(), `cdktn-python-init-${id}-`))
  const bin = mkdtempSync(join(tmpdir(), `cdktn-python-init-bin-${id}-`))

  writeExecutable(
    join(bin, "pipenv"),
    `#!/usr/bin/env bash\necho "[fake pipenv] $@" >&2\nexit 0\n`,
    `@echo off\necho [fake pipenv] %* 1>&2\nexit /b 0\n`,
  )
  writeExecutable(
    join(bin, "python"),
    `#!/usr/bin/env bash\necho "Python 3.14.4"\n`,
    `@echo off\necho Python 3.14.4\n`,
  )
  writeExecutable(
    join(bin, "python3"),
    `#!/usr/bin/env bash\necho "Python 3.14.4"\n`,
    `@echo off\necho Python 3.14.4\n`,
  )

  const result = spawnSync(
    process.execPath,
    [
      cli.binPath,
      "init",
      "--local",
      "--template=python",
      "--project-name=test-proj",
      "--project-description=Test Project",
      "--enable-crash-reporting=false",
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        CI: "1",
      },
    },
  )

  let pipfile = ""
  try {
    pipfile = readFileSync(join(cwd, "Pipfile"), "utf8")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }

  return {
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
    pipfile,
  }
}

// Issue #282 reports that the cdktn Python template hard-codes Python 3.11 in
// the generated Pipfile. A fresh machine with only newer Python (for example
// Python 3.14 on Ubuntu 26.04) then fails during `pipenv install` before users can
// synthesize the project. Stub pipenv so the test isolates the generated project
// contract without downloading Python packages.
describe(`python init Pipfile version [${cliId}]`, () => {
  testCase("does not hard-code Python 3.11 when only Python 3.14 is on PATH", () => {
    const result = runPythonInitWithFakePython(cliId)

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain("[fake pipenv] install")
    expect(result.pipfile).toContain("[requires]")
    expect(result.pipfile).not.toContain('python_version = "3.11"')
  })
})
