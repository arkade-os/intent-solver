import { describe, it, expect } from 'vitest'
import { guardedTick, sweep } from '@arkade-os/solver-core/util/sweep.js'

type Row = { id: string; v: number }

describe('sweep', () => {
  it('skips held-off and in-flight rows, and signals success only for rows that ran', async () => {
    const rows: Row[] = ['held', 'busy', 'ok', 'throws', 'gone'].map((id) => ({ id, v: 0 }))
    const events: string[] = []
    const store = {
      get: async (id: string): Promise<Row> => {
        if (id === 'gone') throw new Error('store down')
        return { id, v: 1 }
      },
    }
    const driven = await sweep(
      rows,
      {
        tick: async (id) => {
          if (id === 'throws' || id === 'gone') throw new Error(`tick ${id}`)
          return { id, v: 2 }
        },
        shouldSkipTick: (id) => id === 'held',
        onTickSuccess: (id) => events.push(`ok:${id}`),
        onTickError: (id) => events.push(`err:${id}`),
      },
      store,
      { inFlight: new Set(['busy']) },
    )
    expect(driven).toEqual([
      { id: 'held', v: 0 },
      { id: 'busy', v: 0 },
      { id: 'ok', v: 2 },
      { id: 'throws', v: 1 },
    ])
    expect(events).toEqual(['ok:ok', 'err:throws', 'err:gone'])
  })

  it('never runs more than `concurrency` ticks at once, and ticks each row once', async () => {
    let live = 0
    let peak = 0
    const ticked: string[] = []
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i), v: 0 }))
    await sweep(
      rows,
      {
        tick: async (id) => {
          peak = Math.max(peak, ++live)
          await new Promise((resolve) => setTimeout(resolve, 1))
          live--
          ticked.push(id)
          return { id, v: 1 }
        },
      },
      { get: async (id) => ({ id, v: 0 }) },
      { concurrency: 3 },
    )
    expect(peak).toBe(3)
    expect(ticked.sort()).toEqual(rows.map((r) => r.id).sort())
  })
})

describe('guardedTick', () => {
  it('steps until no progress, and answers a re-entrant call with the current row', async () => {
    const inFlight = new Set<string>()
    let v = 0
    const store = { get: async (id: string): Promise<Row> => ({ id, v }) }
    let reentrant: Row | undefined
    const done = await guardedTick('a', inFlight, store, async (row) => {
      if (row.v === 0) reentrant = await guardedTick('a', inFlight, store, async () => true)
      return ++v < 3
    })
    expect(done).toEqual({ id: 'a', v: 3 })
    expect(reentrant).toEqual({ id: 'a', v: 0 })
    expect(inFlight.size).toBe(0)
  })
})
