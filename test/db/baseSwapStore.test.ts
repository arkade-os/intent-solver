/**
 * The shared store behaviour, exercised directly over a throwaway table.
 *
 * The four swap stores duplicated these methods; a failure here points at the
 * base rather than at any one corridor, which is the whole reason this file
 * exists separately from `test/db/swaps.test.ts` and its three siblings.
 *
 * `transition` is the money-critical one: its `WHERE ... AND state = ?` is what
 * stops two sweeps acting on one row, and its edge check is what stops a retry
 * walking a swap backwards into re-paying. Both are mutation-checked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { BaseSwapStore, type RawRow, type StoreShape } from '@arkade-os/solver-corridors/db/baseSwapStore.js'

type ProbeState = 'quoted' | 'funded' | 'settled' | 'stuck' | 'refused'
interface ProbeRow {
  id: string
  state: ProbeState
  amountSats: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS probe_swap (
  id             TEXT PRIMARY KEY,
  state          TEXT NOT NULL,
  amount_sats    INTEGER NOT NULL,
  rfq_id         TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  failure_reason TEXT,
  note           TEXT
);
CREATE TABLE IF NOT EXISTS probe_swap_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
`

const SHAPE: StoreShape<ProbeRow, ProbeState> = {
  table: 'probe_swap',
  eventTable: 'probe_swap_event',
  noun: 'probe swap',
  lifecycleLabel: 'probe lifecycle',
  searchColumns: ['id'],
  legalEdges: {
    quoted: ['funded', 'refused'],
    funded: ['settled', 'stuck'],
    settled: [],
    stuck: [],
    refused: [],
  },
  transitionColumns: new Set(['failure_reason']),
  patchColumns: new Set(['note']),
  live: ['quoted', 'funded'],
  exposed: ['funded'],
  failStates: { exposed: 'stuck', clean: 'refused' },
  toRow: (raw: RawRow): ProbeRow => ({
    id: String(raw.id),
    state: String(raw.state) as ProbeState,
    amountSats: Number(raw.amount_sats),
  }),
}

class ProbeStore extends BaseSwapStore<ProbeRow, ProbeState> {
  protected readonly shape = SHAPE

  static async open(driver: SqlDriver): Promise<ProbeStore> {
    const store = new ProbeStore(driver, () => 1_700_000_000)
    await driver.exec(SCHEMA)
    return store
  }

  async seed(
    id: string,
    state: ProbeState,
    amountSats: number,
    createdAt = 1,
    rfqId: string | null = null,
  ): Promise<void> {
    await this.driver.run(
      'INSERT INTO probe_swap (id, state, amount_sats, rfq_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, state, amountSats, rfqId, createdAt, createdAt],
    )
  }
}

let store: ProbeStore

beforeEach(async () => {
  store = await ProbeStore.open(betterSqliteDriver(':memory:'))
})

describe('BaseSwapStore.transition', () => {
  it('moves a row along a legal edge and records the event', async () => {
    await store.seed('a', 'quoted', 1000)
    expect(await store.transition('a', 'quoted', 'funded')).toBe(true)
    expect((await store.get('a')).state).toBe('funded')
    expect(await store.history('a')).toEqual([{ at: 1_700_000_000, from: 'quoted', to: 'funded', detail: null }])
  })

  /** The forward-only ordering is a money invariant — it must throw, not return false. */
  it('refuses an edge outside the lifecycle, loudly', async () => {
    await store.seed('a', 'quoted', 1000)
    await expect(store.transition('a', 'quoted', 'settled')).rejects.toThrow(/not an edge of the probe lifecycle/)
  })

  /**
   * The compare-and-swap. Two sweeps racing the same row must not both act, so
   * a transition whose `from` no longer matches reports false and writes NOTHING
   * — including no event.
   */
  it('reports false and records nothing when the row has already moved', async () => {
    await store.seed('a', 'quoted', 1000)
    expect(await store.transition('a', 'quoted', 'funded')).toBe(true)
    expect(await store.transition('a', 'quoted', 'refused')).toBe(false)
    expect((await store.get('a')).state).toBe('funded')
    expect(await store.history('a')).toHaveLength(1)
  })

  it('refuses to set a column outside the transition allowlist', async () => {
    await store.seed('a', 'quoted', 1000)
    await expect(store.transition('a', 'quoted', 'funded', { note: 'x' })).rejects.toThrow(
      /transition\(\) may not set column 'note'/,
    )
  })
})

describe('BaseSwapStore.patch', () => {
  it('writes an allowed column without touching state or history', async () => {
    await store.seed('a', 'funded', 1000)
    await store.patch('a', { note: 'hello' })
    expect((await store.get('a')).state).toBe('funded')
    expect(await store.history('a')).toEqual([])
  })

  it('refuses a column outside the patch allowlist', async () => {
    await store.seed('a', 'funded', 1000)
    await expect(store.patch('a', { state: 'settled' })).rejects.toThrow(/patch\(\) may not set column 'state'/)
  })

  it('is a no-op on an empty field set', async () => {
    await store.seed('a', 'funded', 1000)
    await expect(store.patch('a', {})).resolves.toBeUndefined()
  })
})

describe('BaseSwapStore.fail', () => {
  it('parks an EXPOSED row as stuck, because a human has to look', async () => {
    await store.seed('a', 'funded', 1000)
    await store.fail('a', 'funded', 'backend died')
    expect((await store.get('a')).state).toBe('stuck')
  })

  it('refuses a row that was never exposed', async () => {
    await store.seed('a', 'quoted', 1000)
    await store.fail('a', 'quoted', 'declined')
    expect((await store.get('a')).state).toBe('refused')
  })
})

describe('BaseSwapStore reads', () => {
  it('sums only live rows into committedSats', async () => {
    await store.seed('a', 'funded', 1000)
    await store.seed('b', 'quoted', 250)
    await store.seed('c', 'settled', 9_999)
    expect(await store.committedSats()).toBe(1250)
  })

  it('returns every live row from findRecoverable, oldest first', async () => {
    await store.seed('b', 'funded', 1000, 2)
    await store.seed('a', 'funded', 1000, 1)
    await store.seed('c', 'settled', 1000, 3)
    expect((await store.findRecoverable()).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('answers an empty state list with no query at all', async () => {
    await store.seed('a', 'funded', 1000)
    expect(await store.findByStates([])).toEqual([])
  })

  it('throws on an id it does not have, rather than returning undefined', async () => {
    await expect(store.get('nope')).rejects.toThrow('probe swap nope not found')
  })

  /**
   * An rfq id is a CORRELATION id, not a key — a client that re-quotes reuses
   * it, so the table legitimately holds several rows for one. Without the
   * `ORDER BY created_at DESC` every caller gets whichever row SQLite reaches
   * first, which is a stale refused quote in place of the live one.
   */
  it('returns the MOST RECENT row for an rfq id, not whichever comes first', async () => {
    await store.seed('old', 'refused', 1000, 1, 'rfq-1')
    await store.seed('new', 'funded', 1000, 2, 'rfq-1')
    expect((await store.findByRfqId('rfq-1'))?.id).toBe('new')
  })

  it('answers null for an rfq id it has never seen', async () => {
    expect(await store.findByRfqId('absent')).toBeNull()
  })
})
