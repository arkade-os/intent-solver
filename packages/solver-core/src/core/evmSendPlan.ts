/**
 * What an `arkade:BTC->ethereum:<token>` swap should do next - as a pure
 * function, deliberately.
 *
 * The onchain corridors keep this decision inside an 865-line service alongside
 * the I/O that carries it out. That works, and it means the money-critical
 * ordering can only be tested through fakes for a chain, a wallet and an
 * emulator. Here the decision is separated from the doing: everything below is
 * derived from a row plus what was observed, so every ordering rule that can
 * lose funds is a unit test with no fixtures at all.
 *
 * THE FOUR RULES THAT COST MONEY, and each is a test:
 *
 * 1. Never lock the ERC20 before the Arkade lockup is funded. The solver's
 *    tokens would be committed against nothing.
 * 2. Never claim the Arkade lockup at or after `refund_locktime`. Past it the
 *    client's own refund path is live, so a claim races a refund and the loser
 *    has paid for nothing.
 * 3. Refund the ERC20 only at or after `evm_timeout`. Earlier the contract
 *    rejects it, and treating that rejection as failure would strand the lock.
 * 4. A revealed preimage outranks everything else. It is the money: once it
 *    exists the Arkade lockup is claimable and nothing about the EVM side
 *    changes that.
 * 5. A quote binds only until `valid_until`. Funding first observed past it is
 *    refused, never filled at a stale rate — every second past the quote the
 *    fixed rate decays further against the solver. And a quote that expired
 *    unfunded is refused at that deadline rather than at the refund locktime
 *    hours later: until it dies, the row holds capacity against the house cap.
 */

import type { EvmSendSwapState } from './evmSwapState.js'

/**
 * The planner's view of a swap row — declared HERE, structurally, for the same
 * reason every core module takes its own params: core may not know the store
 * exists (the layer DAG forbids core -> corridor), and the corridor's row
 * satisfies this interface by construction. Fields are exactly the ones the
 * planner reads, no more.
 */
export interface EvmSendPlanRow {
  state: EvmSendSwapState
  refundLocktime: number
  evmTimeout: number
  validUntil: number
  minConfirmations: number
  minAgeSeconds: number
  preimage: string | null
}

/** What the caller observed about the world, all of it optional to obtain. */
export interface EvmSendObservation {
  /** Is the client's Arkade lockup funded for the quoted amount? */
  arkadeLockupFunded: boolean
  /** Does the solver's ERC20 lock exist in the contract? */
  evmLockPresent: boolean
  /** Confirmations on the lock, and how long it has been buried. */
  evmLockConfirmations: number
  evmLockAgeSeconds: number
  /** The client's preimage, once a Claim event has revealed it. */
  preimage: string | null
  /** Wall clock, seconds. */
  nowSeconds: number
  /** Current EVM block height, for the refund timeout. */
  evmBlockHeight: number
}

export type EvmSendAction =
  | { do: 'wait' }
  /** Lock the ERC20 - the first action that commits the solver's money. */
  | { do: 'lock_evm' }
  /** The lock met depth AND age; the client may now claim it. */
  | { do: 'await_claim' }
  /** Claim the Arkade lockup with the revealed preimage. */
  | { do: 'claim_arkade'; preimage: string }
  /** Take the solver's own ERC20 back, past `evm_timeout`. */
  | { do: 'refund_evm' }
  /** Nothing has moved; the swap can be abandoned safely. */
  | { do: 'refuse'; reason: string }
  /** Money is committed and cannot be recovered by this state machine. */
  | { do: 'stick'; reason: string }

const TERMINAL: readonly EvmSendSwapState[] = ['claimed', 'refunded', 'refused', 'stuck']

export const planEvmSend = (row: EvmSendPlanRow, seen: EvmSendObservation): EvmSendAction => {
  if (TERMINAL.includes(row.state)) return { do: 'wait' }

  // RULE 4 FIRST, and the order of these branches IS the rule. A preimage is
  // the money: once revealed, the Arkade lockup is claimable and no fact about
  // the EVM side changes that. Checking anything else first would let a
  // timed-out lock send us to refund while a claimable preimage sat on the row.
  const preimage = seen.preimage ?? row.preimage
  if (preimage !== null) {
    // RULE 2. Past the refund locktime the client's own refund is live, so a
    // claim races it. Sticking is the honest answer: the preimage is real, the
    // window is gone, and only a human can work out who got there first.
    if (seen.nowSeconds >= row.refundLocktime) {
      return { do: 'stick', reason: 'preimage revealed but the Arkade refund window has closed' }
    }
    return { do: 'claim_arkade', preimage }
  }

  switch (row.state) {
    case 'quoted':
      // RULE 1. Nothing is committed yet, so an unfunded lockup is a refusal
      // rather than a failure - the client simply never turned up.
      if (!seen.arkadeLockupFunded) {
        // RULE 5. An expired quote terminates at its own deadline, not at the
        // refund locktime hours later - until it dies the row counts against
        // the house cap.
        if (seen.nowSeconds >= row.validUntil) {
          return { do: 'refuse', reason: 'quote expired before the client funded' }
        }
        return seen.nowSeconds >= row.refundLocktime
          ? { do: 'refuse', reason: 'client never funded the Arkade lockup' }
          : { do: 'wait' }
      }
      // RULE 5 again, from the funded side: a lockup that shows up after the
      // quote died is refused, never filled at a stale rate. The refusal routes
      // the lockup to the non-interactive covenant refund, so the client is
      // made whole without the solver moving a token.
      if (seen.nowSeconds >= row.validUntil) {
        return { do: 'refuse', reason: 'lockup funded after the quote expired' }
      }
      return { do: 'lock_evm' }

    case 'funded':
      // RULE 1 again, from the other side: the row says funded, so lock.
      return { do: 'lock_evm' }

    case 'locking_evm':
      // The lock call went out. Absent means it has not landed YET or it
      // reverted - indistinguishable from here, and both are "keep waiting"
      // until the refund timeout makes it a refund.
      if (!seen.evmLockPresent) {
        return seen.evmBlockHeight >= row.evmTimeout ? { do: 'refund_evm' } : { do: 'wait' }
      }
      // Depth AND age, both required. @see evm/config.ts - on a rollup a lock
      // can be many confirmations deep and still vanish, because safety comes
      // from the L1 posting finalising rather than from the count.
      return seen.evmLockConfirmations >= row.minConfirmations && seen.evmLockAgeSeconds >= row.minAgeSeconds
        ? { do: 'await_claim' }
        : { do: 'wait' }

    case 'awaiting_claim':
      // RULE 3. Only at or past the timeout; earlier the contract rejects the
      // refund and treating that as failure would strand the lock.
      return seen.evmBlockHeight >= row.evmTimeout ? { do: 'refund_evm' } : { do: 'wait' }

    case 'claiming':
    case 'refunding_evm':
      // In flight. The caller re-reads and retries; nothing here to decide.
      return { do: 'wait' }

    default:
      return { do: 'wait' }
  }
}
