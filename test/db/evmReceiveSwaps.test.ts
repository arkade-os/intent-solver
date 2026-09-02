/**
 * The receive store's own invariants — the send store has `evmSendSwaps.test.ts`
 * and this side had nothing.
 *
 * Focused on the two properties that are specific to THIS leg rather than
 * re-testing the transition machinery both stores share.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EvmReceiveSwapStore, type EvmReceiveQuoteRecord } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'

let now = 1_000_000
const clock = () => now
let store: EvmReceiveSwapStore

const SOLVER_EVM = '0x' + '11'.repeat(20)
const CLIENT_EVM = '0x' + '22'.repeat(20)

/** Above 2^63, so an INTEGER column would silently mangle it. */
const BIG_AMOUNT = '98765432109876543210987'

const quote: EvmReceiveQuoteRecord = {
  id: 'swap-1',
  paymentHash: 'aa'.repeat(32),
  amountSats: 50_000,
  payoutSats: 49_500,
  evmAmount: BIG_AMOUNT,
  tokenAddress: '0x' + '77'.repeat(20),
  evmContractAddress: '0x' + '66'.repeat(20),
  evmChainId: 42161,
  evmTimeout: 500_000_000,
  validUntil: now + 60,
  minConfirmations: 12,
  minAgeSeconds: 720,
  // The solver claims; the client refunds. See the round-trip test below.
  evmClaimAddress: SOLVER_EVM,
  evmRefundAddress: CLIENT_EVM,
  refundLocktime: now + 3600,
  providerPubkey: 'bb'.repeat(32),
  serverPubkey: 'cc'.repeat(32),
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1536,
  pkScript: 'dd'.repeat(34),
  lockupAddress: 'tark1example',
  refundPkScript: 'ee'.repeat(34),
  emulatorPubkey: 'ff'.repeat(33),
  clientRefundPubkey: '44'.repeat(32),
  receiverPkScript: '55'.repeat(34),
  nonInteractiveParameters: true,
  payoutPubkey: '33'.repeat(32),
  rfqId: null,
}

beforeEach(async () => {
  now = 1_000_000
  store = await EvmReceiveSwapStore.open(':memory:', clock)
})

afterEach(async () => {
  await store.close()
})

describe('EvmReceiveSwapStore', () => {
  /**
   * THE FAILURE THIS LEG HAS AND THE SEND LEG DOES NOT. `ERC20Swap` keys a lock
   * by `keccak(preimageHash, amount, token, claim, refund, timelock)`, and on
   * THIS leg the roles are inverted: the SOLVER is `claimAddress` and the CLIENT
   * is `refundAddress`.
   *
   * Stored the wrong way round, the six hash to a swapKey naming no lock at all.
   * The solver's claim reverts, the client refunds at the timeout, and the sats
   * were already paid out — there is no recovery, because the money moved on the
   * strength of a row that was already wrong.
   */
  it('keeps the solver as claimant and the client as refunder, not the reverse', async () => {
    await store.insertQuote(quote)
    const row = await store.get('swap-1')
    expect(row.evmClaimAddress).toBe(SOLVER_EVM)
    expect(row.evmRefundAddress).toBe(CLIENT_EVM)
  })

  it('round-trips nonInteractiveParameters through the real store, both ways', async () => {
    // The same encode/decode path ('1'/null on the wire, boolean|null in the
    // row) the other corridors assert — an inconsistency here is a silent
    // address divergence for this corridor alone.
    const on = await store.insertQuote(quote)
    expect(on.nonInteractiveParameters).toBe(true)

    const off = await store.insertQuote({
      ...quote,
      id: 'swap-2',
      paymentHash: 'ab'.repeat(32),
      nonInteractiveParameters: false,
    })
    expect(off.nonInteractiveParameters).toBeNull()
  })

  it('round-trips every field the swapKey is built from', async () => {
    await store.insertQuote(quote)
    const row = await store.get('swap-1')
    expect([
      row.paymentHash,
      row.evmAmount,
      row.tokenAddress,
      row.evmClaimAddress,
      row.evmRefundAddress,
      row.evmTimeout,
    ]).toEqual([quote.paymentHash, BIG_AMOUNT, quote.tokenAddress, SOLVER_EVM, CLIENT_EVM, 500_000_000])
  })

  it('keeps a token amount a 64-bit column would mangle', async () => {
    // Read back through an INTEGER column this comes back rounded, and the
    // solver claims — or fails to — against an amount hashing to a different
    // swapKey than the one on chain. Which is to say, to no lock.
    await store.insertQuote(quote)
    expect((await store.get('swap-1')).evmAmount).toBe(BIG_AMOUNT)
    expect(BigInt(BIG_AMOUNT) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('keeps both halves of the finality policy, not just the depth', async () => {
    // Depth alone is not finality on a rollup: a sequencer receipt arrives in
    // 1-2 seconds, so a lock can be many confirmations deep and still vanish.
    // Losing `minAgeSeconds` across a restart would silently collapse the
    // policy back to depth-only.
    await store.insertQuote(quote)
    const row = await store.get('swap-1')
    expect(row.minConfirmations).toBe(12)
    expect(row.minAgeSeconds).toBe(720)
  })

  it('does not treat a refused row as live for the same payment hash', async () => {
    await store.insertQuote(quote)
    await store.transition('swap-1', 'quoted', 'refused')
    expect(await store.findLiveByPaymentHash(quote.paymentHash)).toBeNull()
  })

  it('counts every non-terminal state against the cap, quotes included', async () => {
    // The solver's sats are only literally at risk from `funding_arkade`, but
    // a live quote is a claim the client can call in inside its window — the
    // cap has to hold the float for it. Counting only exposed states would let
    // unlimited concurrent quotes slip past and all expect funding at once.
    await store.insertQuote(quote)
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'quoted', 'awaiting_lock')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'awaiting_lock', 'locked')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'locked', 'funding_arkade')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'funding_arkade', 'refunding_arkade')
    expect(await store.committedSats()).toBe(50_000)
    await store.transition('swap-1', 'refunding_arkade', 'refunded')
    expect(await store.committedSats()).toBe(0)
  })
})
