/**
 * Which matured locks the sweep sends, and — more importantly — which it holds
 * back and why.
 *
 * Every deferral here is recoverable: the candidate returns next pass. So the
 * failure this guards against is not "refunded something it should not have"
 * but the quieter one — a pass that silently does nothing, or that reports one
 * reason while another was true, leaving an operator to debug a sweep that
 * looks like it ran.
 */
import { describe, it, expect, vi } from 'vitest'
import { planRefundSweep, type RefundCandidate } from '@arkade-os/solver-rails-evm/evm/refundSweep.js'
import type { EvmHtlcBackend } from '@arkade-os/solver-core/ports/evm.js'
import type { Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'

const lockAt = (timelock: bigint): Erc20SwapLock => ({
  preimageHash: new Uint8Array(32).fill(0x11),
  amount: 1_000n,
  tokenAddress: new Uint8Array(20).fill(0x22),
  claimAddress: new Uint8Array(20).fill(0x33),
  refundAddress: new Uint8Array(20).fill(0x44),
  timelock,
})

/** Only the four members the planner touches; the rest would be noise. */
const backendWith = (over: { currentBlock?: bigint; locked?: boolean } = {}) => {
  const currentBlock = vi.fn(async () => over.currentBlock ?? 100n)
  const isLocked = vi.fn(async () => over.locked ?? true)
  const refundForCall = vi.fn((lock: Erc20SwapLock) => ({
    to: new Uint8Array(20).fill(0xaa),
    data: Uint8Array.from([0x0e, 0x5b, 0xbd, 0x59, Number(lock.timelock % 251n)]),
  }))
  return {
    backend: { currentBlock, isLocked, refundForCall } as unknown as EvmHtlcBackend,
    currentBlock,
    isLocked,
    refundForCall,
  }
}

/** Comfortably affordable: worst case over one block stays far below the cap. */
const AFFORDABLE = { baseFeePerGas: 1_000n, tipPerGas: 100n, maxFeeCeilingPerGas: 1_000_000n }

const candidate = (id: string, timelock: bigint): RefundCandidate => ({ id, lock: lockAt(timelock) })

describe('planRefundSweep', () => {
  it('sends a matured lock that is still funded', async () => {
    const { backend } = backendWith({ currentBlock: 100n })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, AFFORDABLE)
    expect(plan.send.map((s) => s.id)).toEqual(['a'])
    expect(plan.deferred).toEqual([])
    expect(plan.send[0]?.fee.maxFeePerGas).toBeGreaterThan(0n)
  })

  it('treats the timelock as reached, not merely passed', async () => {
    // The contract's own check is `timelock <= currentTime()`, so equality is
    // refundable. Deferring it would strand a lock for a whole sweep interval
    // on an off-by-one nobody would look for.
    const { backend } = backendWith({ currentBlock: 90n })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, AFFORDABLE)
    expect(plan.send.map((s) => s.id)).toEqual(['a'])
  })

  it('defers one that has not matured', async () => {
    const { backend } = backendWith({ currentBlock: 89n })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, AFFORDABLE)
    expect(plan.send).toEqual([])
    expect(plan.deferred).toEqual([{ id: 'a', reason: 'not_matured' }])
  })

  it('defers one the contract no longer holds', async () => {
    const { backend } = backendWith({ currentBlock: 100n, locked: false })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, AFFORDABLE)
    expect(plan.deferred).toEqual([{ id: 'a', reason: 'already_settled' }])
  })

  /**
   * The policy difference from every other transaction this corridor sends. A
   * claim that is priced out must still go — missing its deadline loses the
   * swap. A refund has no deadline: the tokens are already the client's and
   * nothing competes for them, so paying above the operator's ceiling buys
   * nothing. Waiting is free, and the candidate returns next pass.
   */
  it('defers on gas rather than paying above the ceiling', async () => {
    const { backend, refundForCall } = backendWith({ currentBlock: 100n })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, {
      baseFeePerGas: 10_000_000n,
      tipPerGas: 1n,
      maxFeeCeilingPerGas: 100n,
    })
    expect(plan.send).toEqual([])
    expect(plan.deferred).toEqual([{ id: 'a', reason: 'gas_above_ceiling' }])
    // And it did not build a call it was never going to send.
    expect(refundForCall).not.toHaveBeenCalled()
  })

  /**
   * THE PAIRING THE SUITE DID NOT COVER: capped gas AND a lock already settled
   * on chain. Each was tested alone; together they are the case where the
   * reported reason is the first true one rather than the most informative.
   *
   * Pinned as the documented behaviour, not as an accident. `isLocked` runs
   * last because it is the only per-candidate RPC, so nothing asks the
   * contract while gas is above the ceiling — the plan is still right (it
   * sends nothing) and the reason corrects itself once gas fits.
   *
   * Which is why a caller must not age candidates out on the reason alone.
   */
  it('reports capped gas for a lock that is ALSO already settled', async () => {
    const { backend, isLocked } = backendWith({ currentBlock: 100n, locked: false })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, {
      baseFeePerGas: 10_000_000n,
      tipPerGas: 1n,
      maxFeeCeilingPerGas: 100n,
    })
    expect(plan.send).toEqual([])
    expect(plan.deferred).toEqual([{ id: 'a', reason: 'gas_above_ceiling' }])
    // And it did not spend the round trip that would have said otherwise.
    expect(isLocked).not.toHaveBeenCalled()
  })

  it('reports it as settled once gas comes back under the ceiling', async () => {
    // The correction, on the next pass. Same candidate, same chain state.
    const { backend } = backendWith({ currentBlock: 100n, locked: false })
    const plan = await planRefundSweep([candidate('a', 90n)], backend, AFFORDABLE)
    expect(plan.deferred).toEqual([{ id: 'a', reason: 'already_settled' }])
  })
  it('reads the chain tip ONCE for the whole pass', async () => {
    // Per-candidate reads could straddle a block, so one pass could report two
    // locks as matured against different chain states.
    const { backend, currentBlock } = backendWith({ currentBlock: 100n })
    const plan = await planRefundSweep(
      [candidate('a', 90n), candidate('b', 91n), candidate('c', 92n)],
      backend,
      AFFORDABLE,
    )
    expect(plan.send).toHaveLength(3)
    expect(currentBlock).toHaveBeenCalledTimes(1)
  })

  it('does not spend an RPC round trip on a lock that cannot be refunded yet', async () => {
    // `isLocked` is the only per-candidate call that costs a request, so an
    // unmatured candidate must not reach it. With a large backlog of young
    // locks this is the difference between one request and hundreds per pass.
    const { backend, isLocked } = backendWith({ currentBlock: 50n })
    await planRefundSweep([candidate('a', 90n), candidate('b', 91n)], backend, AFFORDABLE)
    expect(isLocked).not.toHaveBeenCalled()
  })

  it('touches the chain not at all when there is nothing to consider', async () => {
    const { backend, currentBlock, isLocked } = backendWith()
    const plan = await planRefundSweep([], backend, AFFORDABLE)
    expect(plan).toEqual({ send: [], deferred: [] })
    expect(currentBlock).not.toHaveBeenCalled()
    expect(isLocked).not.toHaveBeenCalled()
  })

  it('reports a reason per id rather than one verdict for the pass', async () => {
    const { backend } = backendWith({ currentBlock: 95n })
    const plan = await planRefundSweep([candidate('young', 99n), candidate('ready', 90n)], backend, AFFORDABLE)
    expect(plan.send.map((s) => s.id)).toEqual(['ready'])
    expect(plan.deferred).toEqual([{ id: 'young', reason: 'not_matured' }])
  })
})
