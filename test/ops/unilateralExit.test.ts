/**
 * Resolving "exit swap X" to a plan, across whatever corridors this deployment
 * registered.
 *
 * REGISTRY-DRIVEN, never a closed list of corridors. The same lever offered on
 * every row has twice been keyed to one corridor's store here — `tick` and
 * `park-swap` both threw "not found" on rows that plainly existed — and an exit
 * is the most consequential of the three: the row it is reached for is a parked
 * one, on whichever leg the Arkade Service stopped answering.
 */
import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { CorridorReader } from '@arkade-os/solver-core/core/corridor.js'
import { planExitForSwap } from '@arkade-os/solver-app/ops/unilateralExit.js'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const RECEIVER = hex.encode(key(1))
const CLIENT = hex.encode(key(11))
const PREIMAGE_HEX = hex.encode(new Uint8Array(32).fill(7))
const PAYMENT_HASH = hex.encode(sha256(new Uint8Array(32).fill(7)))

const lockup = (id: string) => {
  const base = {
    id,
    receiverPubkey: RECEIVER,
    serverPubkey: hex.encode(key(3)),
    paymentHash: PAYMENT_HASH,
    refundLocktime: 1_800_000_000,
    claimDelay: 4096,
    emulatorPubkey: hex.encode(key(9)),
    refundPkScript: hex.encode(p2tr(key(5))),
    pkScript: '',
    clientRefundPubkey: CLIENT,
    refundWithoutReceiverDelay: 8192,
    refundDelay: 4096,
    receiverPkScript: hex.encode(p2tr(key(13))),
    nonInteractiveParameters: true,
  }
  const script = new CovenantSwapScript({
    receiver: hex.decode(base.receiverPubkey),
    server: hex.decode(base.serverPubkey),
    preimageHash: ripemd160(hex.decode(base.paymentHash)),
    refundLocktime: base.refundLocktime,
    claimDelay: base.claimDelay,
    client: hex.decode(base.clientRefundPubkey),
    clientRefundDelay: base.refundWithoutReceiverDelay,
    refundWithoutServerDelay: base.refundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(base.emulatorPubkey),
      receiverPkScript: hex.decode(base.receiverPkScript),
      senderPkScript: hex.decode(base.refundPkScript),
    },
  })
  return { ...base, pkScript: hex.encode(script.pkScript) }
}

const readerHolding = (pair: string, ids: Record<string, { preimage: string | null }>): CorridorReader =>
  ({
    descriptor: { pair, envStem: pair, payoutRail: 'arkade', states: { live: [], exposed: [], delivered: [] } },
    lockupFor: async (id: string) => (ids[id] ? { lockup: lockup(id), preimage: ids[id]!.preimage } : null),
  }) as unknown as CorridorReader

/** A corridor with no lockups of its own to describe — entitled to omit the method. */
const muteReader = (pair: string): CorridorReader =>
  ({
    descriptor: { pair, envStem: pair, payoutRail: 'arkade', states: { live: [], exposed: [], delivered: [] } },
  }) as unknown as CorridorReader

describe('planExitForSwap', () => {
  it('finds the row on whichever corridor holds it, not the first one registered', async () => {
    const corridors = [muteReader('a'), readerHolding('b', {}), readerHolding('c', { 'swap-9': { preimage: null } })]
    const found = await planExitForSwap(corridors, 'swap-9', { solverPubkey: CLIENT })
    expect(found.pair).toBe('c')
    expect(found.plan.leaf).toBe('unilateralRefundWithoutReceiver')
  })

  it('reads a corridor that omits lockupFor as "not mine", never as an error', async () => {
    const corridors = [muteReader('a'), readerHolding('b', { x: { preimage: null } })]
    await expect(planExitForSwap(corridors, 'x', { solverPubkey: CLIENT })).resolves.toMatchObject({ pair: 'b' })
  })

  it('refuses an id no registered corridor holds', async () => {
    await expect(planExitForSwap([muteReader('a')], 'ghost', { solverPubkey: CLIENT })).rejects.toThrow(
      /no corridor on this deployment holds swap ghost/,
    )
  })

  it('takes the preimage off the row for a claim leg, so an operator need not paste a secret', async () => {
    const corridors = [readerHolding('b', { x: { preimage: PREIMAGE_HEX } })]
    const found = await planExitForSwap(corridors, 'x', { solverPubkey: RECEIVER })
    expect(found.plan.leaf).toBe('unilateralClaim')
    expect(found.plan.preimage).toBe(PREIMAGE_HEX)
  })

  it('lets an explicit preimage win over the row’s, since supplying one is a deliberate override', async () => {
    const corridors = [readerHolding('b', { x: { preimage: 'ff'.repeat(32) } })]
    const found = await planExitForSwap(corridors, 'x', { solverPubkey: RECEIVER, preimage: PREIMAGE_HEX })
    expect(found.plan.preimage).toBe(PREIMAGE_HEX)
  })

  /**
   * The refusal comes from `planUnilateralExit`, which checks the preimage
   * against the row's own payment hash — so a row carrying a wrong one is
   * refused here rather than at the sweep, days into an exit.
   */
  it('refuses a claim leg whose row carries no preimage and none was supplied', async () => {
    const corridors = [readerHolding('b', { x: { preimage: null } })]
    await expect(planExitForSwap(corridors, 'x', { solverPubkey: RECEIVER })).rejects.toThrow(/needs the preimage/)
  })

  it('refuses a lockup whose shape a corridor got wrong, rather than building a script from it', async () => {
    const broken = {
      descriptor: { pair: 'b', envStem: 'b', payoutRail: 'arkade', states: { live: [], exposed: [], delivered: [] } },
      lockupFor: async () => ({ lockup: { id: 'x' }, preimage: null }),
    } as unknown as CorridorReader
    await expect(planExitForSwap([broken], 'x', { solverPubkey: CLIENT })).rejects.toThrow(/not a string/)
  })
})
