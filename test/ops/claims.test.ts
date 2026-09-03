import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { NON_TERMINAL, SwapStore, type QuoteRecord } from '@arkade-os/solver-corridors/db/swaps.js'
import { claimNow } from '@arkade-os/solver-app/ops/claims.js'
import { parkVia } from '@arkade-os/solver-core/core/corridor.js'
import type { SendHtlcState } from '@arkade-os/solver-core/ports/lightning.js'

const PREIMAGE = 'ab'.repeat(32)
const PAYMENT_HASH = hex.encode(sha256(hex.decode(PREIMAGE)))

const quote = (): QuoteRecord => ({
  id: 'swap-1',
  invoice: 'lnbc5u1p...',
  paymentHash: PAYMENT_HASH,
  amountSats: 500,
  invoiceExpiresAt: 1_003_600,
  refundLocktime: 1_007_200,
  senderPubkey: '01'.repeat(32),
  receiverPubkey: '02'.repeat(32),
  serverPubkey: '03'.repeat(32),
  claimDelay: 605184,
  refundDelay: 605696,
  refundWithoutReceiverDelay: 606208,
  pkScript: '5120' + 'ab'.repeat(32),
  lockupAddress: 'ark1qexample',
  nonInteractiveParameters: true,
})

let store: SwapStore

/** A row parked in `stuck` out of `paying` — the shape this command exists for. */
const stuckRow = async () => {
  await store.insertQuote(quote())
  await store.transition('swap-1', 'quoted', 'funded')
  await store.transition('swap-1', 'funded', 'paying')
  await store.fail('swap-1', 'paying', 'lightning payment failed terminally')
  expect((await store.get('swap-1')).state).toBe('stuck')
}

/** Only the two things `claimNow` reads; the rest of Services is irrelevant here. */
const services = (sendHtlc: SendHtlcState | null = null) =>
  ({ store, ln: { getSendHtlcState: async () => sendHtlc } }) as never

beforeEach(async () => {
  store = await SwapStore.open(':memory:', () => 1_000_000)
})
afterEach(() => store.close())

describe('claimNow', () => {
  it('moves a stuck row back onto the claim path with the preimage recorded', async () => {
    await stuckRow()

    const outcome = await claimNow(services(), 'swap-1', PREIMAGE)

    expect(outcome).toEqual({ state: 'claiming' })
    const row = await store.get('swap-1')
    expect(row.state).toBe('claiming')
    // On disk before anything is pushed: from `claiming` on, the claim needs
    // nothing external, so a crash here still resolves.
    expect(row.preimage).toBe(PREIMAGE)
  })

  it('REFUSES a preimage that does not match the payment hash', async () => {
    await stuckRow()

    await expect(claimNow(services(), 'swap-1', 'cd'.repeat(32))).rejects.toThrow(/does not match/)

    // Untouched. A wrong preimage cannot open the script, so admitting one
    // would strand the swap in `claiming` with nothing that can finish it.
    expect((await store.get('swap-1')).state).toBe('stuck')
  })

  it('reads the preimage off the backend when none is supplied', async () => {
    await stuckRow()

    const outcome = await claimNow(services({ status: 'settled', preimage: PREIMAGE }), 'swap-1')

    expect(outcome).toEqual({ state: 'claiming' })
    expect((await store.get('swap-1')).preimage).toBe(PREIMAGE)
  })

  it('refuses when neither the operator nor the backend can supply one', async () => {
    await stuckRow()

    await expect(claimNow(services({ status: 'committed' }), 'swap-1')).rejects.toThrow(/no preimage/)
    expect((await store.get('swap-1')).state).toBe('stuck')
  })

  it('refuses a row that is not stuck, rather than racing the sweep for it', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')

    await expect(claimNow(services(), 'swap-1', PREIMAGE)).rejects.toThrow(/is funded/)
  })
})

/**
 * The gap the d69041e8 incident exposed: a row stuck in a state whose every
 * tick throws had NO operator action that could stop it. Parking it took a
 * hand-written script against the live database, inside the container, during
 * an incident — the exact shape of thing that should be a button.
 *
 * These now drive `parkVia` with the SAME two lists `lightningSendCorridor.park`
 * passes it, so they exercise the production path rather than a copy of it. The
 * app-level `parkSwap` they used to call is gone: it reached this one store
 * directly while the console offered its button on every corridor.
 */
describe('Corridor.park, over the Lightning-send store', () => {
  const park = (id: string, reason: string, target: unknown = store) =>
    parkVia(target as never, { live: NON_TERMINAL, parked: ['stuck', 'refused'] }, id, reason)

  const payingRow = async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
  }

  it('moves an exposed row to stuck with the operator’s reason on it', async () => {
    await payingRow()

    const outcome = await park('swap-1', 'orphaned preimage request')

    expect(outcome).toEqual({ state: 'stuck' })
    const row = await store.get('swap-1')
    expect(row.state).toBe('stuck')
    expect(row.failureReason).toContain('orphaned preimage request')
  })

  it('REQUIRES a reason — a parked row with no explanation is a mystery later', async () => {
    await payingRow()

    await expect(park('swap-1', '  ')).rejects.toThrow(/reason/i)
    expect((await store.get('swap-1')).state).toBe('paying')
  })

  it('refuses to report success when the sweep raced the park', async () => {
    await payingRow()
    // `store.fail` delegates to a compare-and-swap and DISCARDS its result, so a
    // row the sweep advanced between the read and the write is silently not
    // parked. Reporting the state we then read back would tell an operator
    // `PARKED -> paid`, which is nonsense at the exact moment it matters.
    const racing = {
      get: (id: string) => store.get(id),
      fail: async (id: string, from: 'paying', reason: string) => {
        await store.transition(id, 'paying', 'paid')
        await store.fail(id, from, reason)
      },
    }

    await expect(park('swap-1', 'because', racing)).rejects.toThrow(/raced/i)

    expect((await store.get('swap-1')).state).toBe('paid')
  })

  it('refuses a row that is already terminal', async () => {
    await payingRow()
    await store.fail('swap-1', 'paying', 'already done')

    await expect(park('swap-1', 'again')).rejects.toThrow(/stuck/)
  })

  it('parks from quoted and funded too, where nothing is exposed', async () => {
    await store.insertQuote(quote())

    const outcome = await park('swap-1', 'client vanished')

    // `fail` routes a non-exposed state to `refused`, not `stuck` — the row
    // never moved money, so it needs no operator afterwards.
    expect(outcome).toEqual({ state: 'refused' })
    expect((await store.get('swap-1')).state).toBe('refused')
  })
})
