/**
 * What an `onchain:BTC->arkade:<asset>` swap should do next — as a pure
 * function, deliberately.
 *
 * The BTC receive leg keeps this decision inside a 1004-line service alongside
 * the I/O that carries it out. That works, and it means the money-critical
 * ordering can only be tested through fakes for a chain, a wallet and an
 * emulator. Here the decision is separated from the doing: everything below is
 * derived from a row plus what was observed, so every ordering rule that can
 * lose funds is a unit test with no fixtures at all.
 *
 * THE RULES THAT COST MONEY, and each is a test:
 *
 *  1. Never fund the asset lockup before the client's L1 HTLC has reached
 *     `min_confirmations`. Zero-conf funding pays out against a transaction
 *     that can still be replaced.
 *  2. Never fund once the solver's own Arkade refund window has begun closing.
 *     Past it the asset is out with no time left to reclaim it.
 *  3. Never fund when the solver's unilateral recourse would open AFTER the L1
 *     HTLC's own timeout. Otherwise the client reclaims onchain and still
 *     claims the asset — both sides of one swap (#69).
 *  4. Exposure that ALREADY exists is adopted, never re-gated. Once the lockup
 *     holds the asset, a window that has since closed must not fail the row:
 *     the money is out either way, and failing it loses only the record of it.
 *  5. A revealed preimage outranks everything else. It is the money: once `P`
 *     is public the L1 HTLC is claimable and no fact about the Arkade side
 *     changes that.
 *  6. A broadcast claim is not a landed one. `settled` is terminal, so only a
 *     CONFIRMED L1 claim earns it.
 *  7. A CONFIRMED funding mismatch is refused, never adopted. The payout was
 *     priced against the quoted give, so adopting a different give would pay a
 *     price nobody quoted. Unconfirmed is not yet anything — it can still be
 *     fee-bumped or completed by a second send.
 *  8. The payout is fixed at quote time and never re-derived. The client funded
 *     against the quoted number; a price that has moved since re-prices nothing.
 *  9. Inventory is re-checked immediately before funding, never inherited from
 *     the quote.
 */

import { MIN_ARKADE_FUND_WINDOW } from './onchainReceive.js'
import { UNILATERAL_RECOURSE_MARGIN } from './receive.js'
import type { OnchainAssetReceiveState } from './onchainAssetSwapState.js'

/**
 * Re-exported rather than redeclared: the window is the same physical question
 * on both receive legs, and two copies could drift into one leg funding what
 * the other refuses.
 */
export { MIN_ARKADE_FUND_WINDOW }

/** The planner's view of a row — core may not know the store exists. */
export interface OnchainAssetReceivePlanRow {
  state: OnchainAssetReceiveState
  /** What the client funds the L1 HTLC with. */
  amountSats: number
  /** Atomic units of the asset the solver owes, fixed at quote time (rule 8). */
  payoutUnits: bigint
  minConfirmations: number
  /** The L1 HTLC's CLTV — the CLIENT's refund path on this leg. */
  htlcLocktime: number
  /** The Arkade lockup's refund deadline — the SOLVER's own. */
  refundLocktime: number
  /** CSV on the leaf the solver can spend alone, seconds, from the row. */
  refundWithoutReceiverDelay: number
  /** How long a quote stays fundable by the client before it is abandoned. */
  fundingDeadline: number
  preimage: string | null
  /** The solver's own L1 claim broadcast, once one has been recorded. */
  onchainClaimTxid: string | null
}

/** One output at the client's HTLC address. */
export interface ObservedHtlcOutput {
  txid: string
  vout: number
  valueSats: number
  confirmations: number
}

export interface OnchainAssetReceiveObservation {
  /** Every output seen at the HTLC address. */
  htlcOutputs: readonly ObservedHtlcOutput[]
  /** Does the Arkade lockup already carry at least the payout? Rule 4. */
  lockupFunded: boolean
  /** Is anything still sitting at the lockup script? */
  lockupEmpty: boolean
  /** `P`, once any spend of the lockup has revealed it. */
  preimage: string | null
  /** What became of the solver's own L1 claim broadcast. Rule 6. */
  onchainClaimOutcome: 'confirmed' | 'mempool' | 'unknown'
  /**
   * Whether the HTLC output is already spent, and by whom.
   *
   * `null` when nothing has spent it. `ours` is decided by the witness carrying
   * this row's preimage — the refund path cannot produce one — so a process
   * that died between broadcasting and recording finds its OWN claim rather
   * than reading it as the client's refund.
   */
  priorSpend: null | 'ours' | 'theirs'
  /** Does the float still hold the payout? Rule 9. */
  inventorySufficient: boolean
  nowSeconds: number
}

export type OnchainAssetReceiveAction =
  | { do: 'wait' }
  /** The lockup already holds the asset — record it without funding again. */
  | { do: 'adopt_lockup' }
  /** The client's funding output is confirmed enough to act on. */
  | { do: 'await_confirmations'; txid: string; vout: number }
  /** Hand off to funding: every gate passed. */
  | { do: 'begin_funding' }
  /** Pay the asset into the lockup — the first action that commits the float. */
  | { do: 'fund_arkade' }
  /** `P` is public; take the L1 HTLC with it. */
  | { do: 'claim_onchain'; preimage: string }
  /** The L1 claim confirmed; the row may finally say so. */
  | { do: 'record_settled' }
  /** Reclaim the solver's own asset lockup. */
  | { do: 'refund_arkade' }
  /** Nothing of the solver's has moved; the swap can be abandoned safely. */
  | { do: 'refuse'; reason: string }
  /** Money is committed and cannot be recovered by this state machine. */
  | { do: 'stick'; reason: string }

const TERMINAL: readonly OnchainAssetReceiveState[] = ['settled', 'refunded', 'refused', 'stuck']

/** Rules 2 and 3, as one answer, so both callers ask them the same way. */
export const onchainAssetFundingGate = (
  row: Pick<OnchainAssetReceivePlanRow, 'refundLocktime' | 'htlcLocktime' | 'refundWithoutReceiverDelay'>,
  now: number,
): { fund: true } | { fund: false; reason: string } => {
  if (now >= row.refundLocktime - MIN_ARKADE_FUND_WINDOW) {
    return { fund: false, reason: 'refused to fund: arkade refund window closing' }
  }
  if (now + row.refundWithoutReceiverDelay + UNILATERAL_RECOURSE_MARGIN > row.htlcLocktime) {
    return { fund: false, reason: 'refused to fund: solver unilateral recourse opens after the onchain htlc timeout' }
  }
  return { fund: true }
}

export const planOnchainAssetReceive = (
  row: OnchainAssetReceivePlanRow,
  seen: OnchainAssetReceiveObservation,
): OnchainAssetReceiveAction => {
  if (TERMINAL.includes(row.state)) return { do: 'wait' }

  // RULE 5 FIRST, and the order of these branches IS the rule. Once `P` exists
  // the L1 HTLC is collectable, and every Arkade-side fact — a closed window, an
  // emptied lockup — is behind it. Checking anything else first would send a row
  // to refund while a claimable preimage sat on it.
  const preimage = seen.preimage ?? row.preimage
  if (preimage !== null && row.state !== 'quoted' && row.state !== 'awaiting_confirmations') {
    // `P` reaches the row BEFORE any settle decision is made, so every branch
    // below reasons from `claimed`. It is also the only legal edge into it from
    // `awaiting_claim` and `refunding_arkade` — settling straight from either
    // would be a transition the store rejects.
    if (row.state !== 'claimed') return { do: 'claim_onchain', preimage }

    // RULE 6. `settled` is terminal, so only a confirmed claim earns it; a
    // broadcast still in the mempool is not yet a fact.
    if (row.onchainClaimTxid !== null) {
      if (seen.onchainClaimOutcome === 'confirmed') return { do: 'record_settled' }
      if (seen.onchainClaimOutcome === 'mempool') return { do: 'wait' }
    }
    if (seen.priorSpend === 'ours') return { do: 'record_settled' }
    if (seen.priorSpend === 'theirs') {
      return {
        do: 'stick',
        reason: "onchain HTLC already spent before the solver could claim it — likely the client's own refund",
      }
    }
    return { do: 'claim_onchain', preimage }
  }

  switch (row.state) {
    case 'quoted': {
      const match = seen.htlcOutputs.find((o) => o.valueSats === row.amountSats)
      if (match) return { do: 'await_confirmations', txid: match.txid, vout: match.vout }
      // RULE 7. Confirmed is the whole condition: an unconfirmed mismatch can
      // still be replaced or completed, a confirmed one can be neither.
      const mismatch = seen.htlcOutputs.find((o) => o.confirmations > 0)
      if (mismatch) {
        return {
          do: 'refuse',
          reason:
            `funding mismatch: ${mismatch.txid}:${mismatch.vout} holds ${mismatch.valueSats} sats, ` +
            `quote is for ${row.amountSats}`,
        }
      }
      if (seen.nowSeconds >= row.fundingDeadline) return { do: 'refuse', reason: 'lockup timeout' }
      return { do: 'wait' }
    }

    case 'awaiting_confirmations': {
      const output = seen.htlcOutputs.find((o) => o.confirmations >= row.minConfirmations)
      const gate = onchainAssetFundingGate(row, seen.nowSeconds)
      // RULE 1, and the gate is asked even while STILL waiting: a swap that can
      // never reach its confirmations before its own refund deadline would
      // otherwise sit here forever instead of failing cleanly. Nothing of the
      // solver's is at risk in this state either way.
      if (!output) {
        return gate.fund ? { do: 'wait' } : { do: 'refuse', reason: `confirmations not reached in time: ${gate.reason}` }
      }
      if (!gate.fund) return { do: 'refuse', reason: gate.reason }
      return { do: 'begin_funding' }
    }

    case 'funding_arkade': {
      // RULE 4, ahead of every gate below it. Exposure that exists is adopted
      // whatever the gates now say — the asset is out, and refusing here would
      // discard the only record of where it went.
      if (seen.lockupFunded) return { do: 'adopt_lockup' }
      const gate = onchainAssetFundingGate(row, seen.nowSeconds)
      if (!gate.fund) return { do: 'refuse', reason: gate.reason }
      // RULE 9. Re-read, never inherited: the quote-time check was made before a
      // confirmation wait another corridor could have spent the float across.
      if (!seen.inventorySufficient) {
        return { do: 'refuse', reason: 'refused to fund: asset float no longer covers the quoted payout' }
      }
      return { do: 'fund_arkade' }
    }

    case 'awaiting_claim': {
      // The deadline backstop reuses the SAME gate that permitted the funding:
      // "is there still time before our own refund path" is the question here
      // too, just asked after the money went out instead of before.
      const gate = onchainAssetFundingGate(row, seen.nowSeconds)
      return gate.fund ? { do: 'wait' } : { do: 'refund_arkade' }
    }

    case 'claimed':
      // Reached only with no preimage on the row, which the rule-5 branch above
      // would otherwise have taken. That is a corrupt row, not a wait.
      return { do: 'stick', reason: 'claimed state with no preimage' }

    case 'refunding_arkade':
      // An empty lockup with no preimage is ambiguous — our own earlier refund,
      // or a claim not yet readable. The caller gives that read lag a bounded
      // grace before this becomes terminal; from here it is simply not decidable.
      return seen.lockupEmpty ? { do: 'wait' } : { do: 'refund_arkade' }

    default:
      return { do: 'wait' }
  }
}
