/**
 * The seeded console behind `pnpm admin:dev`.
 *
 * Pinned because it rots silently: a route that starts reading a new `Services`
 * field 500s over the demo's stand-ins, and nobody runs the demo until they need it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { buildDemoConsole, type DemoConsole } from '@arkade-os/solver-app/ops/adminDemo.js'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

const endpointPaths = (): string[] => {
  const start = appSource.indexOf('const ENDPOINTS = {')
  const end = appSource.indexOf('\n}\n', start)
  if (start === -1 || end === -1) throw new Error('the ENDPOINTS table is gone from app.js')
  return [...new Set(appSource.slice(start, end).match(/\/api\/[a-z-]+/g))]
}

let demo: DemoConsole
let app: Hono

beforeAll(async () => {
  demo = await buildDemoConsole()
  app = buildAdminApp(demo.deps)
})

afterAll(async () => {
  await demo.close()
})

const get = async (path: string) => {
  const response = await app.fetch(new Request(`http://admin${path}`))
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('the demo console', () => {
  it('answers every page the client loads', async () => {
    const paths = [...endpointPaths(), '/api/overview', '/api/overview?balances=false']
    expect(paths.length).toBeGreaterThan(10)
    for (const path of paths) {
      const { status, body } = await get(path)
      expect({ path, status, body: status === 200 ? null : body }).toEqual({ path, status: 200, body: null })
    }
  })

  it('opens the detail of a swap in every corridor it lists', async () => {
    const { body } = await get('/api/swaps?limit=100')
    const rows = body.swaps as { id: string; corridor: string }[]
    const corridors = [...new Set(rows.map((row) => row.corridor))]
    expect(corridors.length).toBeGreaterThanOrEqual(5)
    for (const corridor of corridors) {
      const row = rows.find((candidate) => candidate.corridor === corridor)!
      const { status } = await get(`/api/swaps/${encodeURIComponent(corridor)}/${row.id}`)
      expect({ corridor, status }).toEqual({ corridor, status: 200 })
    }
  })

  // Seeded rows skip the orchestrators, so hold them to what the orchestrators verify before writing.
  it('seeds only rows the orchestrators could have written', async () => {
    const { body } = await get('/api/swaps?limit=100')
    let preimages = 0
    for (const row of body.swaps as { id: string; corridor: string }[]) {
      const { body: detail } = await get(`/api/swaps/${encodeURIComponent(row.corridor)}/${row.id}`)
      const raw = detail.raw as Record<string, unknown>
      if (typeof raw.preimage === 'string') {
        preimages++
        expect({ id: row.id, hash: hex.encode(sha256(hex.decode(raw.preimage))) }).toEqual({
          id: row.id,
          hash: raw.paymentHash,
        })
      }
      if (row.corridor === 'lightning:BTC->arkade:BTC' && raw.arkadeLockupValue != null) {
        expect({ id: row.id, lockup: raw.arkadeLockupValue }).toEqual({ id: row.id, lockup: raw.payoutSats })
      }
    }
    expect(preimages).toBeGreaterThan(10)
  })

  // The design rule is colour for risk only; a demo without risk would hide it.
  it('shows every phase the console colours, and work waiting on an operator', async () => {
    const { body } = await get('/api/swaps?limit=100')
    const phases = new Set((body.swaps as { phase: string }[]).map((row) => row.phase))
    expect([...phases].sort()).toEqual(expect.arrayContaining(['done', 'exposed', 'failed', 'open']))
    const overview = await get('/api/overview')
    const attention = overview.body.attention as { stuckCount: number; pendingApprovals: unknown[]; failing: unknown[] }
    expect(attention.stuckCount).toBeGreaterThan(0)
    expect(attention.pendingApprovals).not.toHaveLength(0)
    expect(attention.failing).not.toHaveLength(0)
  })
})
