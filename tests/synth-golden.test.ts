import { describe, test, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { spawnCli, waitExit, exitedCleanly } from "../src/harness.js"
import { fixtureDir } from "../src/manifest.js"
import { currentCliId } from "../src/versions.js"

// Library-behaviour guard: synth the fixture and snapshot the *generated Terraform*
// (not the TTY). Version-volatile metadata is stripped so the snapshot only moves
// when construct-library output genuinely changes. Snapshots are per-CLI_ID, so
// each channel keeps its own golden — a diff between channels is a real regression.
const id = currentCliId()

function readSynth(fixture: string, stack: string): unknown {
  const out = join(fixtureDir(id, fixture), "cdktf.out", "stacks", stack, "cdk.tf.json")
  if (!existsSync(out)) throw new Error(`expected synth output at ${out}`)
  return normalize(JSON.parse(readFileSync(out, "utf8")))
}

/** Drop fields that legitimately change between versions/runs. */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      // "//" carries cdktf/cdktn metadata incl. the generator version.
      if (k === "//") continue
      if (k === "version" || k === "backend_version") continue
      out[k] = normalize(v)
    }
    return out
  }
  return node
}

describe(`synth golden output [${id}]`, () => {
  test("minimal-ts cdk.tf.json is stable (sensitive output stays declared)", async () => {
    const { term } = await spawnCli({ argv: ["synth"], fixture: "minimal-ts", mode: "non-tty" })
    expect(exitedCleanly(await waitExit(term, 90_000))).toBe(true)

    const synth = readSynth("minimal-ts", "hello") as Record<string, any>
    // Structural invariants that must hold regardless of version:
    expect(synth.output?.greeting).toBeTruthy()
    expect(synth.output?.secret?.sensitive).toBe(true)
    expect(synth.terraform?.backend?.local).toBeTruthy()

    // Full normalized snapshot — first run records the golden for this channel.
    expect(synth).toMatchSnapshot()
  })
})
