/**
 * What an `ethereum:<token>->arkade:BTC` swap should do next.
 *
 * The mirror of `evmSendPlan.ts`, and the risk runs the OTHER WAY. There the
 * solver locks tokens against sats it can see; here the solver locks SATS
 * against a token lock it does not control and did not create. So the rules that
 * cost money are different ones.
 *
 * THE FOUR RULES, each a test:
 *
 * 1. Never fund the Arkade lockup until the client's ERC20 lock has met depth
 *    AND age. The solver's sats would be committed against a lock that can still
 *    vanish, and on a rollup depth alone does not settle that.
 * 2. Never fund when there is not enough of the client's `evm_timeout_block` left to
 *    claim in. The solver would pay sats for tokens the client can take back.
 * 3. A revealed preimage means CLAIM THE ERC20, and quickly. It is how the
 *    solver gets paid at all — the sats have already gone out.
 * 4. Past the client's `evm_timeout_block` with a preimage in hand and no claim, the
 *    money is gone. That is `stuck`: only a human can find out whether the
 *    client refunded first.
 * 5. A quote binds only until `valid_until`. An ERC20 lock first observed past
 *    it is refused, never funded against at a stale rate — and an unlocked
 *    quote is refused at that deadline rather than at the refund locktime, so
 *    the row stops holding capacity against the house cap.
 * 6. `claimed` means the ERC20 arrived, so only a mined claim earns it. The
 *    sats are already out, so a row saying it over a reverted claim lies.
 */

import type { EvmTransactionOutcome } from '../ports/evm.js'
import type { EvmReceiveSwapState } from './evmSwapState.js'

/**
 * The planner's view of a swap row — structural, declared here for the same
 * reason {@link EvmSendPlanRow} is: core may not import the corridor's store
 * types, and the corridor's row satisfies this interface by construction.
 */
export interface EvmReceivePlanRow {
  state: EvmReceiveSwapState
  refundLocktime: number
  evmTimeout: number
  validUntil: number
  minConfirmations: number
  minAgeSeconds: number
  preimage: string | null
  /** Set once the claim is broadcast; the only handle on its receipt. */
  evmClaimTxid: string | null
}

/** How much of the client's timeout must remain before the solver commits sats. */
export const EVM_RECEIVE_CLAIM_MARGIN_BLOCKS = 60

export interface EvmReceiveObservation {
  /** Does the client's ERC20 lock exist in the contract? */
  evmLockPresent: boolean
  evmLockConfirmations: number
  evmLockAgeSeconds: number
  /** Is the solver's Arkade lockup funded and visible? */
  arkadeLockupFunded: boolean
  /** What became of the solver's own claim broadcast. `pending` until read. */
  evmClaimOutcome: EvmTransactionOutcome
  /** The preimage, once the client's Arkade claim has revealed it. */
  preimage: string | null
  nowSeconds: number
  evmBlockHeight: number
}

export type EvmReceiveAction =
  | { do: 'wait' }
  /** Fund the Arkade lockup — the first action that commits the solver's sats. */
  | { do: 'fund_arkade' }
  /** The lockup is funded; the client may now claim it. */
  | { do: 'await_claim' }
  /** Claim the client's ERC20 with the revealed preimage. This is the payment. */
  | { do: 'claim_evm'; preimage: string }
  /** The claim is mined; the row may finally say the solver was paid. */
  | { do: 'record_claim' }
  /** Take the solver's own sats back — the client never claimed. */
  | { do: 'refund_arkade' }
  | { do: 'refuse'; reason: string }
  | { do: 'stick'; reason: string }

const TERMINAL: readonly EvmReceiveSwapState[] = ['claimed', 'refunded', 'refused', 'stuck']

export const planEvmReceive = (row: EvmReceivePlanRow, seen: EvmReceiveObservation): EvmReceiveAction => {
  if (TERMINAL.includes(row.state)) return { do: 'wait' }

  const preimage = seen.preimage ?? row.preimage

  // RULES 3 AND 4 FIRST, and the order is the point. Once a preimage exists the
  // solver has already paid out sats, so claiming the ERC20 is the only way it
  // gets paid — that outranks every other consideration including the Arkade
  // refund window, which is no longer relevant to the solver's own position.
  if (preimage !== null) {
    // A MINED CLAIM OUTRANKS THE TIMEOUT: height cannot un-mine it, and the
    // contract deletes the lock on claim, so the client's refund cannot have
    // landed too. Sticking would file an incident over tokens the solver holds.
    if (row.evmClaimTxid !== null && seen.evmClaimOutcome === 'success') return { do: 'record_claim' }
    if (seen.evmBlockHeight >= row.evmTimeout) {
      // RULE 4. The client's refund path is live. The sats are gone and the
      // tokens may be too; only a human can establish who got there first.
      return { do: 'stick', reason: 'preimage revealed but the client ERC20 timeout has passed' }
    }
    // RULE 6. Re-sending on the row alone burns a nonce per tick for one payment.
    if (row.evmClaimTxid !== null) {
      if (seen.evmClaimOutcome === 'reverted') {
        return { do: 'stick', reason: 'the ERC20 claim transaction reverted; the solver has not been paid' }
      }
      return { do: 'wait' }
    }
    return { do: 'claim_evm', preimage }
  }

  switch (row.state) {
    case 'quoted':
    case 'awaiting_lock': {
      if (!seen.evmLockPresent) {
        // Nothing committed, so an absent lock past the deadline is a refusal
        // rather than an incident — the client simply never locked. RULE 5
        // shortens the wait to the quote's own deadline; the refund-locktime
        // refusal stays as the backstop for rows quoted before it existed.
        if (seen.nowSeconds >= row.validUntil) {
          return { do: 'refuse', reason: 'quote expired before the client locked' }
        }
        return seen.nowSeconds >= row.refundLocktime
          ? { do: 'refuse', reason: 'client never locked the ERC20' }
          : { do: 'wait' }
      }
      // RULE 5. A lock that appears after the quote died is not on its terms.
      // Refusing costs the solver nothing — the client takes their own ERC20
      // back at their timeout — while funding here would lock the solver's
      // sats at a rate that stopped binding when the window closed.
      if (seen.nowSeconds >= row.validUntil) {
        return { do: 'refuse', reason: 'ERC20 lock observed after the quote expired' }
      }
      // RULE 1. Depth AND age, neither sufficient. @see evm/config.ts
      if (seen.evmLockConfirmations < row.minConfirmations || seen.evmLockAgeSeconds < row.minAgeSeconds) {
        return { do: 'wait' }
      }
      // RULE 2. Enough of the client's timeout must remain that the solver can
      // still claim after the client reveals. Funding into a nearly-expired lock
      // buys tokens the client can take straight back.
      if (seen.evmBlockHeight + EVM_RECEIVE_CLAIM_MARGIN_BLOCKS >= row.evmTimeout) {
        return { do: 'refuse', reason: 'client ERC20 timeout too close to fund against' }
      }
      return { do: 'fund_arkade' }
    }

    case 'locked':
      return { do: 'fund_arkade' }

    case 'funding_arkade':
      return seen.arkadeLockupFunded ? { do: 'await_claim' } : { do: 'wait' }

    case 'awaiting_claim':
      // No preimage and the Arkade window has closed: the client never claimed,
      // so the solver takes its own sats back.
      return seen.nowSeconds >= row.refundLocktime ? { do: 'refund_arkade' } : { do: 'wait' }

    case 'refunding_arkade':
      // RE-DRIVEN, not parked: the spend is a step after this CAS, and a crash
      // between left the covenant unspent with nothing watching. A funded
      // lockup HERE is that unspent covenant.
      return seen.arkadeLockupFunded ? { do: 'refund_arkade' } : { do: 'wait' }

    case 'claiming':
      return { do: 'wait' }

    default:
      return { do: 'wait' }
  }
}
