import { UniqueConstraintError, type SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import { Conflict, RuleViolated } from '../domain/shared/error.js'
import type { SwapId } from '../domain/shared/ids.js'
import { Swap } from '../domain/swap/swap.js'
import type { SwapEvent } from '../domain/swap/swap_event.js'
import type { SwapRepository } from '../domain/swap/swap_repo.js'
import { decodeSwapEvent, encodeSwapEvent } from './swapEventCodec.js'

// `seq` orders events across swaps for the workers that read them; `version` orders one swap's own.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS swap_event (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  body    TEXT NOT NULL,
  UNIQUE (swap_id, version)
);
CREATE TABLE IF NOT EXISTS swap_event_cursor (
  consumer TEXT PRIMARY KEY,
  seq      INTEGER NOT NULL
);
`

interface Raw {
  seq: number
  swap_id: string
  type: string
  at: number
  body: string
}

export interface StoredSwapEvent {
  readonly seq: number
  readonly event: SwapEvent
}

// D1 binds at most 100 values per statement, and one event takes five.
const MAX_EVENTS_PER_WRITE = 20

const decoded = (raw: Raw): SwapEvent => decodeSwapEvent(raw.swap_id, raw.type, Number(raw.at), raw.body)

/** The history of every swap, and the source of truth: every other table is derived from it by a worker. */
export class SwapEvents implements Pick<SwapRepository, 'add' | 'update' | 'get'> {
  private constructor(private readonly driver: SqlDriver) {}

  static async open(driver: SqlDriver): Promise<SwapEvents> {
    await driver.exec(SCHEMA)
    return new SwapEvents(driver)
  }

  async add(swap: Swap): Promise<void> {
    if (swap.version !== 0) throw new Conflict(`swap ${swap.id} is already stored`)
    await this.append(swap)
  }

  async update(id: SwapId, change: (swap: Swap) => void | Promise<void>): Promise<Swap> {
    const swap = await this.get(id)
    if (swap === null) throw new Conflict(`swap ${id} does not exist`)
    await change(swap)
    await this.append(swap)
    return Swap.fromEvents([...(await this.history(id))])
  }

  async get(id: SwapId): Promise<Swap | null> {
    const events = await this.history(id)
    return events.length === 0 ? null : Swap.fromEvents(events)
  }

  /** For a worker: everything stored after the last event it handled, in the order it was stored. */
  async after(seq: number, limit: number): Promise<readonly StoredSwapEvent[]> {
    const rows = await this.driver.all<Raw>(
      'SELECT seq, swap_id, type, at, body FROM swap_event WHERE seq > ? ORDER BY seq LIMIT ?',
      [seq, limit],
    )
    return rows.map((raw) => ({ seq: Number(raw.seq), event: decoded(raw) }))
  }

  async cursor(consumer: string): Promise<number> {
    const row = await this.driver.get<{ seq: number }>('SELECT seq FROM swap_event_cursor WHERE consumer = ?', [
      consumer,
    ])
    return Number(row?.seq ?? 0)
  }

  /** Never moves back: a worker that restarts and re-reports an old position must not replay what a newer one did. */
  async advance(consumer: string, seq: number): Promise<void> {
    await this.driver.run(
      `INSERT INTO swap_event_cursor (consumer, seq) VALUES (?, ?)
       ON CONFLICT (consumer) DO UPDATE SET seq = excluded.seq WHERE excluded.seq > swap_event_cursor.seq`,
      [consumer, seq],
    )
  }

  private async history(id: SwapId): Promise<readonly SwapEvent[]> {
    const rows = await this.driver.all<Raw>(
      'SELECT seq, swap_id, type, at, body FROM swap_event WHERE swap_id = ? ORDER BY version',
      [id],
    )
    return rows.map(decoded)
  }

  // One statement, so it is atomic even on a driver with no transactions: the compare-and-swap is
  // the unique (swap_id, version), which a second writer from the same version cannot satisfy.
  private async append(swap: Swap): Promise<void> {
    const events = swap.changes
    if (events.length === 0) return
    if (events.length > MAX_EVENTS_PER_WRITE) {
      throw new RuleViolated(`swap ${swap.id}: ${events.length} events in one write, at most ${MAX_EVENTS_PER_WRITE}`)
    }
    // Refuse now what could not be read back later: one unreadable event would block the swap and every worker.
    for (const event of events) decodeSwapEvent(swap.id, event.type, event.at, encodeSwapEvent(event))
    const rows = events.map(() => '(?, ?, ?, ?, ?)').join(', ')
    const params = events.flatMap((event, i) => [
      swap.id,
      swap.version + i + 1,
      event.type,
      event.at,
      encodeSwapEvent(event),
    ])
    try {
      await this.driver.run(`INSERT INTO swap_event (swap_id, version, type, at, body) VALUES ${rows}`, params)
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new Conflict(`swap ${swap.id} was changed by another writer since version ${swap.version}`)
      }
      throw error
    }
  }
}
