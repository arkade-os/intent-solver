/**
 * A refund that lands should take the row out of the operator's queue.
 *
 * `stuck` is the state that means a person must look, and nothing retries it.
 * `refundNow` used to push the covenant refund, write `refund_outcome` and
 * `refund_ark_txid`, and leave the row exactly where it was — so a swap whose
 * client had been made whole went on reading "needs a human" forever, and the
 * count in the status bar never went down.
 *
 * The console had grown a workaround for it: `stuck` plus a refund outcome was
 * displayed as "client refunded — parked, nothing outstanding". That is a label
 * over a row the system still believed was outstanding.
 *
 * WHY THIS IS SAFE, because the previous behaviour was deliberate and said so.
 * `projection.ts` argued `stuck` must not be rewritten after a refund, since on
 * this corridor it means the solver may have paid out and refunding the client
 * says nothing about that. True — and it is an argument against REFUNDING such
 * a row, which is the documented double payout `read-payment` exists to
 * prevent. It is not an argument for leaving a correctly-refunded row in the
 * queue. The guard rails stay where they belong: `refund-now` is armed, marked
 * "not what the read supports" when the verdict disagrees, and the row lands in
 * `refused` — presented as `refunded`, phase `failed`, never `done` — so
 * nothing here can make a mistaken refund look like success.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LEGAL_EDGES_FOR_TEST } from '@arkade-os/solver-corridors/db/swaps.js'
import { phaseOf } from '../../src/admin/projection.js'

const source = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the lifecycle allows a refunded stuck row to close', () => {
  it('has an edge from stuck to refused', () => {
    expect(LEGAL_EDGES_FOR_TEST.stuck).toContain('refused')
  })

  it('keeps the operator claim edge alongside it', () => {
    // The two ways a human resolves a stuck row, and both must exist: claim
    // when the payment settled, refund when it did not.
    expect(LEGAL_EDGES_FOR_TEST.stuck).toContain('claiming')
  })

  it('stays forward-only — no path back into paying or paid', () => {
    // The invariant the whole table exists for. A row that reached `stuck` may
    // already have sent sats; an edge back into a payment state would let it
    // send them twice.
    expect(LEGAL_EDGES_FOR_TEST.stuck).not.toContain('paying')
    expect(LEGAL_EDGES_FOR_TEST.stuck).not.toContain('paid')
    expect(LEGAL_EDGES_FOR_TEST.refused).toEqual([])
  })
})

describe('a refunded row does not read as success', () => {
  it('presents as refunded, and refunded is not a delivered phase', () => {
    // `refused` + a refund outcome is presented as `refunded` by
    // `presentedState`, which is the word the other three corridors use. It
    // must land in `failed`: the swap ended safely, but it did not deliver.
    expect(phaseOf('arkade:BTC->lightning:BTC', 'refunded')).toBe('failed')
  })

  it('is not exposed and not live, so no sweep walks it again', () => {
    expect(phaseOf('arkade:BTC->lightning:BTC', 'refused')).toBe('failed')
  })
})

describe('refundNow closes the row only when it actually refunded', () => {
  const refunds = source('../../src/ops/refunds.ts')
  const body = refunds.slice(
    refunds.indexOf('export const refundNow'),
    refunds.indexOf('export const onchainRefundNow'),
  )

  it('transitions stuck -> refused after the push', () => {
    expect(body).toMatch(/transition\([^)]*'stuck',\s*'refused'/)
  })

  it('does NOT transition when there was nothing at the script', () => {
    // `nothing-at-script` means the lockup was already spent — by our own claim,
    // or by the client. No refund happened, so nothing was resolved, and the row
    // must stay where a human will see it.
    const earlyReturn = body.indexOf('NOTHING_AT_SCRIPT')
    const transition = body.search(/transition\([^)]*'stuck'/)
    expect(earlyReturn).toBeGreaterThan(-1)
    expect(transition).toBeGreaterThan(earlyReturn)
  })

  it('records the refund before closing the row, never after', () => {
    // If the process dies between the two, the surviving order must be the one
    // where the txid is on disk. A closed row with no recorded refund is
    // unrecoverable evidence; an open row with a recorded refund is merely
    // untidy.
    const patch = body.indexOf('refund_outcome')
    const transition = body.search(/transition\([^)]*'stuck'/)
    expect(patch).toBeGreaterThan(-1)
    expect(patch).toBeLessThan(transition)
  })

  it('only closes a row that IS stuck, leaving every other caller alone', () => {
    // `refundNow` is also run against `refused` rows and from the sweep. A
    // blind transition would throw on those, turning a successful refund into a
    // reported failure.
    expect(body).toMatch(/state === 'stuck'/)
  })
})
