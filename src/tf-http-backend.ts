// In-process mock of the Terraform HTTP backend, used to test state-lock behaviour
// (issue #283: interrupting diff/deploy must release the lock) fully hermetically —
// no AWS, no DynamoDB, no docker. Models the same REST surface as the Go reference
// at grid/cmd/gridapi/internal/server/tfstate.go:
//
//   GET    /tfstate/{guid}          → current state JSON (404 until first write)
//   POST   /tfstate/{guid}?ID=<id>  → persist state
//   LOCK   /tfstate/{guid}/lock     → acquire; 423 + lock-info JSON if already held
//   UNLOCK /tfstate/{guid}/unlock   → release
//   (PUT is accepted as a fallback for LOCK/UNLOCK, matching the Go impl)
//
// Every lock transition is recorded so a test can assert "an UNLOCK arrived after
// the Ctrl-C" (lock released) vs "no UNLOCK → stale lock" (the #283 bug).
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface LockInfo {
  ID: string
  Operation?: string
  Who?: string
  Created?: string
  [k: string]: unknown
}

export type BackendEvent =
  | { type: "lock"; at: number; info: LockInfo; granted: boolean }
  | { type: "unlock"; at: number; id: string }
  | { type: "get"; at: number }
  | { type: "post"; at: number; id: string | null }

export interface MockBackend {
  /** Base address for the `http` backend's `address` field. */
  address: string
  lockAddress: string
  unlockAddress: string
  /** Ordered log of every request that mutated/queried lock or state. */
  events: BackendEvent[]
  /** Current lock holder, or null. */
  currentLock(): LockInfo | null
  /** True iff an UNLOCK was received after the given timestamp. */
  unlockedSince(ts: number): boolean
  close(): Promise<void>
}

const GUID = "e2e"

export async function startMockBackend(): Promise<MockBackend> {
  let state: unknown = null
  let lock: LockInfo | null = null
  const events: BackendEvent[] = []
  const now = () => Date.now()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    const method = req.method ?? "GET"

    const body: Buffer[] = []
    req.on("data", (c) => body.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(body).toString("utf8")

      // LOCK / UNLOCK (custom verbs, with PUT/DELETE fallbacks)
      if (path === `/tfstate/${GUID}/lock`) {
        const info = safeJson<LockInfo>(raw) ?? { ID: "unknown" }
        if (lock) {
          events.push({ type: "lock", at: now(), info, granted: false })
          res.writeHead(423, { "content-type": "application/json" })
          res.end(JSON.stringify(lock)) // 423 Locked → existing holder
          return
        }
        lock = info
        events.push({ type: "lock", at: now(), info, granted: true })
        res.writeHead(200).end(JSON.stringify(info))
        return
      }
      if (path === `/tfstate/${GUID}/unlock`) {
        const info = safeJson<LockInfo>(raw)
        const id = info?.ID ?? lock?.ID ?? "unknown"
        lock = null
        events.push({ type: "unlock", at: now(), id })
        res.writeHead(200).end("{}")
        return
      }

      // State GET / POST
      if (path === `/tfstate/${GUID}`) {
        if (method === "GET") {
          events.push({ type: "get", at: now() })
          if (state == null) return void res.writeHead(404).end()
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(state))
          return
        }
        if (method === "POST" || method === "PUT") {
          state = safeJson(raw) ?? {}
          events.push({ type: "post", at: now(), id: url.searchParams.get("ID") })
          res.writeHead(200).end()
          return
        }
      }

      res.writeHead(404).end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}/tfstate/${GUID}`

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

function safeJson<T = unknown>(s: string): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}
