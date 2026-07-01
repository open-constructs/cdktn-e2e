import { afterEach, describe, expect, test } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { spawnCli, waitExit, until } from "../src/harness.js"
import { currentCliId } from "../src/versions.js"

interface LockInfo {
  ID: string
  [k: string]: unknown
}

type BackendEvent = { type: "lock" | "unlock" | "get" | "post"; at: number }

interface SlowReadBackend {
  address: string
  lockAddress: string
  unlockAddress: string
  events: BackendEvent[]
  currentLock(): LockInfo | null
  unlockedSince(ts: number): boolean
  close(): Promise<void>
}

/**
 * Terraform's HTTP backend holds the state lock while it reads state and computes a
 * plan. Delaying GET after LOCK creates a deterministic window where a test can
 * press Ctrl-C while `terraform plan` owns the lock, without using cloud resources
 * or relying on provider timing.
 */
async function startSlowReadBackend(getDelayMs: number): Promise<SlowReadBackend> {
  let lock: LockInfo | null = null
  const events: BackendEvent[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    const body: Buffer[] = []
    req.on("data", (chunk: Buffer) => body.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(body).toString("utf8")
      if (path === "/tfstate/e2e/lock") {
        lock = safeJson<LockInfo>(raw) ?? { ID: "unknown" }
        events.push({ type: "lock", at: Date.now() })
        res.writeHead(200).end(JSON.stringify(lock))
        return
      }
      if (path === "/tfstate/e2e/unlock") {
        lock = null
        events.push({ type: "unlock", at: Date.now() })
        res.writeHead(200).end("{}")
        return
      }
      if (path === "/tfstate/e2e" && req.method === "GET") {
        events.push({ type: "get", at: Date.now() })
        setTimeout(() => res.writeHead(404).end(), getDelayMs)
        return
      }
      if (path === "/tfstate/e2e" && (req.method === "POST" || req.method === "PUT")) {
        events.push({ type: "post", at: Date.now() })
        res.writeHead(200).end()
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}/tfstate/e2e`
  return {
    address: base,
    lockAddress: `${base}/lock`,
    unlockAddress: `${base}/unlock`,
    events,
    currentLock: () => lock,
    unlockedSince: (ts) => events.some((e) => e.type === "unlock" && e.at >= ts),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function safeJson<T>(s: string): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

describe(`diff interrupt lock release [${currentCliId()}]`, () => {
  let backend: SlowReadBackend | undefined
  afterEach(async () => {
    await backend?.close()
    backend = undefined
  })

  test("Ctrl-C during diff waits for terraform plan to unlock the HTTP backend", async () => {
    const b = (backend = await startSlowReadBackend(25_000))
    const { term } = await spawnCli({
      argv: ["diff"],
      fixture: "locking-http-ts",
      mode: "tty",
      freshState: true,
      env: {
        TF_HTTP_ADDRESS: b.address,
        TF_HTTP_LOCK_ADDRESS: b.lockAddress,
        TF_HTTP_UNLOCK_ADDRESS: b.unlockAddress,
        LOCK_HOLD_SECONDS: "25",
      },
    })

    expect(await until(() => b.currentLock() !== null, 120_000), "diff never acquired the state lock").toBe(true)
    const interruptedAt = Date.now()
    term.press("Ctrl+c")

    const exit = await waitExit(term, 45_000)
    expect(exit, "diff hung after Ctrl-C while terraform held the state lock").not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(
      b.unlockedSince(interruptedAt),
      `diff left the state lock orphaned after Ctrl-C; events=${JSON.stringify(b.events)} currentLock=${JSON.stringify(b.currentLock())}`,
    ).toBe(true)
    expect(b.currentLock()).toBeNull()
  })
})
