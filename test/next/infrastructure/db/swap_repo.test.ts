import { beforeEach, describe, expect, it } from 'vitest'
import { Conflict, InvalidValue } from '@arkade-os/solver-next/domain/shared/error.js'
import { SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { ContractVersion } from '@arkade-os/solver-next/domain/swap/leg.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { decodeSwapEvent } from '@arkade-os/solver-next/infrastructure/db/swap_event_codec.js'
import { SqlSwapRepository } from '@arkade-os/solver-next/infrastructure/db/swap_repo.js'
import { bothLocked, btc, quoted, ref, SECRET, t, terms, usdt } from '../../domain/support.js'

let events: SqlSwapRepository

beforeEach(async () => {
  events = await SqlSwapRepository.open(betterSqliteDriver(':memory:'))
})

describe('swap events as the source of truth', () => {
  it('reads back the swap every command produced, value objects included', async () => {
    const swap = bothLocked()
    swap.claim('to', t(1_004), { claim: ref('txid-claim'), preimage: SECRET })
    swap.claiming('from', t(1_005))
    swap.reference('from', { claim: ref('settle-1') }, t(1_006))
    await events.add(swap)

    const loaded = await events.get(terms.id)
    expect(loaded?.snapshot).toEqual(swap.snapshot)
    expect(loaded?.version).toBe(swap.changes.length)
    expect(loaded?.changes).toEqual([])
    expect(await events.get(SwapId.of('nope'))).toBeNull()
  })

  it('keeps an offer, a failure and a resumption', async () => {
    const offer = quoted({
      hashlock: null,
      rfqId: null,
      quote: terms.quote,
      from: { rail: 'arkade', amount: usdt(5_000n), contract: 'offer', version: ContractVersion.of('offer-v3') },
      to: { rail: 'arkade', amount: btc(9_990n), contract: 'payment', version: null },
    })
    offer.lock('from', t(1_001), ref('deposit'))
    offer.locking('to', t(1_002))
    offer.fillOffer(t(1_003), ref('fill'))
    await events.add(offer)
    expect((await events.get(terms.id))?.snapshot).toEqual(offer.snapshot)

    const stuck = bothLocked()
    stuck.claim('to', t(1_004), { preimage: SECRET })
    stuck.fail('stuck', 'settle failing past E', t(1_005))
    stuck.resume(t(1_006))
    stuck.fail('stuck', 'again', t(1_007))
    const other = await SqlSwapRepository.open(betterSqliteDriver(':memory:'))
    await other.add(stuck)
    expect((await other.get(terms.id))?.snapshot).toEqual(stuck.snapshot)
  })

  it('appends what an update raised, and nothing when it raised nothing', async () => {
    await events.add(quoted())
    const updated = await events.update(terms.id, (swap) => {
      swap.lock('from', t(1_001), ref('txid-in'))
    })
    expect([updated.version, updated.from.state]).toEqual([2, 'locked'])
    expect((await events.update(terms.id, () => {})).version).toBe(2)
    await expect(events.update(SwapId.of('nope'), () => {})).rejects.toThrow(Conflict)
  })

  it('lets one of two writers from the same version win', async () => {
    await events.add(quoted())
    await expect(events.add(quoted())).rejects.toThrow(Conflict)
    await events.update(terms.id, (swap) => void swap.lock('from', t(1_001), ref('txid-in')))
    // A writer that loaded before that update still holds version 1.
    const stale = events.update(terms.id, async (swap) => {
      await events.update(terms.id, (other) => void other.locking('to', t(1_002)))
      swap.fail('stuck', 'raced', t(1_003))
    })
    await expect(stale).rejects.toThrow('changed by another writer since version 2')
    expect((await events.get(terms.id))?.to.state).toBe('locking')
  })

  it('hands a worker the events after its cursor, in stored order', async () => {
    await events.add(quoted())
    await events.add(quoted({ id: SwapId.of('swap-2'), rfqId: null }))
    await events.update(terms.id, (swap) => void swap.lock('from', t(1_001)))

    expect(await events.cursor('ledger')).toBe(0)
    const batch = await events.after(0, 2)
    expect(batch.map(({ event }) => `${event.id}:${event.type}`)).toEqual(['swap-1:SwapQuoted', 'swap-2:SwapQuoted'])
    await events.advance('ledger', batch.at(-1)!.seq)
    const rest = await events.after(await events.cursor('ledger'), 10)
    expect(rest.map(({ event }) => `${event.id}:${event.type}`)).toEqual(['swap-1:LegAdvanced'])
    await events.advance('ledger', 1)
    expect(await events.cursor('ledger')).toBe(2)
  })

  it('refuses to store an event it could not read back', async () => {
    const swap = quoted()
    swap.lock('from', t(1_001), '' as ReturnType<typeof ref>)
    await expect(events.add(swap)).rejects.toThrow(InvalidValue)
    expect(await events.get(terms.id)).toBeNull()
  })

  it('reads a body written before a field was added', () => {
    const old = decodeSwapEvent('swap-1', 'LegAdvanced', 1_001, JSON.stringify({ side: 'from', state: 'locked' }))
    expect(old).toMatchObject({ references: {}, preimage: null, expiresAt: null })
    expect(decodeSwapEvent('swap-1', 'OfferFilled', 1_001, '{}')).toMatchObject({ fill: null })
  })
})
