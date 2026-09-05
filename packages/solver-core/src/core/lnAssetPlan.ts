/**
 * What a `lightning:BTC<->arkade:<asset>` swap should do next — as pure
 * functions, deliberately, for the reason `evmSendPlan.ts` gives: the
 * money-critical ordering becomes a unit test with no fixtures at all.
 *
 * A Lightning leg is irreversible once the preimage is revealed and the asset
 * leg is a covenant, so every rule below is about ORDER. Each is a test.
 *
 * RECEIVE (`lightning:BTC->arkade:<asset>`; the client pays sats, the solver
 * funds an asset lockup the client claims):
 *
 * R1. Adopt an existing lockup before deciding anything else. A crashed attempt
 *     may already have funded one, and funding again pays twice for one claim.
 * R2. Never fund before the HTLC is armed and the funding gate says yes.
 * R3. A readable preimage outranks everything: the asset has already left, so
 *     the held HTLC must be settled whatever the Arkade side now says.
 * R4. Never settle the HTLC without a preimage recovered from the chain.
 * R5. Never refund while a preimage is readable — the claim already happened.
 * R6. Refund only at or after `refund_locktime`; earlier it races a live claim.
 * R7. An unarmed quote is refused at its OWN deadline, not at the refund
 *     locktime hours later: until it dies it holds capacity against the cap.
 *
 * SEND (`arkade:<asset>->lightning:BTC`; the client locks the asset, the solver
 * pays sats and claims with the preimage the payment reveals — issue #21):
 *
 * S1. Never pay before the lockup holds the QUOTED ASSET AMOUNT. Sats would go
 *     out against nothing; a sats-only funding check cannot see this.
 * S2. A readable preimage outranks everything: the lockup is claimable and no
 *     fact about the payment changes that.
 * S3. Never claim at or after `refund_locktime`. Past it the client's own
 *     refund is live, so a claim races it and the loser paid for nothing.
 * S4. A lockup first observed past `lockup_deadline` is refused, never filled:
 *     every second past the quote the fixed asset/BTC rate decays against the
 *     solver, and § 5 forbids silent re-pricing.
 * S5. A payment whose outcome is unknown is never retried. Only proof the sats
 *     never left may refuse it; anything else needs a human.
 * S6. The solver never refunds this leg. The client funded it and the covenant's
 *     non-interactive refund needs no solver signature, so a refusal strands
 *     nothing and there is no refund action to plan.
 */

/** The receive leg's states — the BTC receive lifecycle, asset-denominated. */
export type LnAssetReceiveState =
  | 'quoted'
  | 'armed'
  | 'funded'
  | 'claimed'
  | 'settled'
  | 'refunding'
  | 'refunded'
  | 'refused'
  | 'stuck'

/** The send leg's states — `db/swaps.ts`'s send lifecycle, asset-denominated. */
export type LnAssetSendState =
  | 'quoted'
  | 'funded'
  | 'paying'
  | 'paid'
  | 'claiming'
  | 'claimed'
  | 'refused'
  | 'stuck'

const RECEIVE_TERMINAL: readonly LnAssetReceiveState[] = ['settled', 'refunded', 'refused', 'stuck']
const SEND_TERMINAL: readonly LnAssetSendState[] = ['claimed', 'refused', 'stuck']

/**
 * The planner's view of a receive row. Declared structurally, for the reason
 * `EvmSendPlanRow` is: core may not know the store exists.
 */
export interface LnAssetReceivePlanRow {
  state: LnAssetReceiveState
  /** When the quote — and the hold invoice minted against it — stops binding. */
  invoiceExpiresAt: number
  preimage: string | null
}

export interface LnAssetReceiveObservation {
  /** A lockup of ours at this row's script, funded or historical. R1. */
  lockupOutpointFound: boolean
  /** That lockup still holds the QUOTED ASSET AMOUNT — `lockupIsFunded`'s asset arm. */
  lockupHoldsQuotedAsset: boolean
  /** `evaluateReceiveFunding`'s verdict, taken immediately before funding. R2. */
  funding: { fund: true } | { fund: false; reason: string }
  /** Recovered from whatever spent the lockup. Never inferred from its absence. */
  preimage: string | null
  /** Asked in the locktime's OWN unit — a height against the tip, seconds against the clock. */
  refundDeadlineReached: boolean
  nowSeconds: number
}

export type LnAssetReceiveAction =
  | { do: 'wait' }
  /** A previous attempt's lockup exists; record it rather than fund a second. */
  | { do: 'adopt_funding' }
  /** Fund the asset lockup — the first action that commits the solver's asset. */
  | { do: 'fund_asset' }
  /** The client claimed; record the preimage their spend revealed. */
  | { do: 'record_claim'; preimage: string }
  /** Settle the held HTLC with the revealed preimage — the solver gets paid. */
  | { do: 'settle_htlc'; preimage: string }
  /** Take the solver's own asset back, past `refund_locktime`. */
  | { do: 'refund_asset' }
  /** Nothing has moved; the swap can be abandoned safely. */
  | { do: 'refuse'; reason: string }
  /** Money is committed and cannot be recovered by this state machine. */
  | { do: 'stick'; reason: string }

export const planLnAssetReceive = (
  row: LnAssetReceivePlanRow,
  seen: LnAssetReceiveObservation,
): LnAssetReceiveAction => {
  if (RECEIVE_TERMINAL.includes(row.state)) return { do: 'wait' }

  const preimage = seen.preimage ?? row.preimage

  switch (row.state) {
    case 'quoted':
      // R7. The HTLC arming is the host's own observation and moves the row to
      // `armed`; from here the only decision left is whether the quote died.
      return seen.nowSeconds >= row.invoiceExpiresAt
        ? { do: 'refuse', reason: 'invoice expired before it was ever armed' }
        : { do: 'wait' }

    case 'armed':
      // R1 BEFORE R2, and the order is the rule. The gates below decide whether
      // to CREATE exposure; exposure that already exists must be adopted
      // regardless, or a row whose funding crashed and whose invoice has since
      // expired is refused with the asset already gone.
      if (seen.lockupOutpointFound) return { do: 'adopt_funding' }
      // R2.
      if (!seen.funding.fund) return { do: 'refuse', reason: `refused to fund: ${seen.funding.reason}` }
      return { do: 'fund_asset' }

    case 'funded':
      // R3/R5. A preimage means the client's claim landed and the asset is
      // already gone — settling is how the solver gets paid for it, and a
      // refund here would race a spend that has already happened.
      if (preimage !== null) return { do: 'record_claim', preimage }
      // R6.
      if (seen.refundDeadlineReached) return { do: 'refund_asset' }
      return { do: 'wait' }

    case 'claimed':
      // R4. `claimed` is only ever entered with a preimage; a row here without
      // one is corrupt, and guessing would settle an HTLC against nothing.
      if (preimage === null) return { do: 'stick', reason: 'claimed state with no preimage' }
      return { do: 'settle_htlc', preimage }

    case 'refunding':
      // R5 again, from the refund side: a late-but-valid claim can land right up
      // until this races it, so the preimage is re-read before every push.
      if (preimage !== null) return { do: 'record_claim', preimage }
      // The lockup is gone and no claim is readable. Two very different things
      // look identical from here and only TIME separates them, so the caller
      // owns the grace window; this reports the ambiguity rather than resolving it.
      if (!seen.lockupHoldsQuotedAsset && !seen.lockupOutpointFound) {
        return { do: 'stick', reason: 'lockup empty during refunding with no matching claim found' }
      }
      return { do: 'refund_asset' }

    default:
      return { do: 'wait' }
  }
}

/** What became of the solver's outbound Lightning payment. */
export type LnAssetPaymentOutcome = 'none' | 'in_flight' | 'succeeded' | 'failed'

export interface LnAssetSendPlanRow {
  state: LnAssetSendState
  /** When the quote stops binding — the client's window to fund. S4. */
  lockupDeadline: number
  /** When the CLIENT's own refund path opens. S3. */
  refundLocktime: number
  preimage: string | null
}

export interface LnAssetSendObservation {
  /**
   * The client's lockup holds the QUOTED ASSET AMOUNT — `lockupIsFunded`'s asset
   * arm, never a sats sum. S1: a lockup with the right sats carrier and the
   * wrong asset amount reads as funded to every sats-shaped gate in this repo.
   */
  lockupHoldsQuotedAsset: boolean
  /** `evaluateSendPayment`'s verdict, taken immediately before the payment. */
  payment: { pay: true } | { pay: false; reason: string }
  paymentOutcome: LnAssetPaymentOutcome
  /** From the payment, or from whatever spent the lockup. */
  preimage: string | null
  nowSeconds: number
}

export type LnAssetSendAction =
  | { do: 'wait' }
  /** Pay the client's invoice — the first irreversible act on this leg. */
  | { do: 'pay_invoice' }
  /** The payment settled; record the preimage it returned. */
  | { do: 'record_payment'; preimage: string }
  /** Claim the client's asset lockup with the revealed preimage. */
  | { do: 'claim_asset'; preimage: string }
  | { do: 'refuse'; reason: string }
  | { do: 'stick'; reason: string }

export const planLnAssetSend = (row: LnAssetSendPlanRow, seen: LnAssetSendObservation): LnAssetSendAction => {
  if (SEND_TERMINAL.includes(row.state)) return { do: 'wait' }

  // S2 FIRST, and the order of these branches IS the rule. Once the preimage
  // exists the lockup is claimable and nothing about the payment changes that;
  // checking anything else first could refuse a row whose asset is collectable.
  const preimage = seen.preimage ?? row.preimage
  if (preimage !== null && row.state !== 'quoted') {
    // S3. Past the locktime the client's own refund is live, so a claim races
    // it. Sticking is honest: the preimage is real, the window is gone, and
    // only a human can work out who got there first.
    if (seen.nowSeconds >= row.refundLocktime) {
      return { do: 'stick', reason: 'preimage revealed but the asset refund window has closed' }
    }
    return row.state === 'paying' || row.state === 'funded'
      ? { do: 'record_payment', preimage }
      : { do: 'claim_asset', preimage }
  }

  switch (row.state) {
    case 'quoted':
      if (!seen.lockupHoldsQuotedAsset) {
        // S4, from the unfunded side.
        return seen.nowSeconds >= row.lockupDeadline
          ? { do: 'refuse', reason: 'quote expired before the client funded the asset lockup' }
          : { do: 'wait' }
      }
      // S4, from the funded side: a lockup that shows up after the quote died is
      // refused, never filled at a stale rate. The refusal leaves the client's
      // own non-interactive refund to make them whole (S6).
      if (seen.nowSeconds >= row.lockupDeadline) {
        return { do: 'refuse', reason: 'asset lockup funded after the quote expired' }
      }
      return { do: 'pay_invoice' }

    case 'funded':
      // S1 again, from the other side, and re-asked rather than inherited: a
      // lockup can be spent between the tick that recorded it and this one.
      if (!seen.lockupHoldsQuotedAsset) {
        return { do: 'refuse', reason: 'asset lockup no longer holds the quoted amount' }
      }
      if (!seen.payment.pay) return { do: 'refuse', reason: `refused to pay: ${seen.payment.reason}` }
      return { do: 'pay_invoice' }

    case 'paying':
      // S5. `succeeded` without a preimage is not a success this leg can act on
      // — the preimage IS the receipt, and the branch above has already taken
      // every case where one exists.
      if (seen.paymentOutcome === 'failed') {
        return { do: 'refuse', reason: 'the outbound payment failed and nothing left the node' }
      }
      if (seen.paymentOutcome === 'succeeded') {
        return { do: 'stick', reason: 'the payment reports success with no preimage to claim against' }
      }
      return { do: 'wait' }

    case 'paid':
    case 'claiming':
      // Sats are out and the preimage branch above did not fire, so the receipt
      // this leg collects against is missing. Retrying cannot conjure it.
      return { do: 'stick', reason: 'the payment settled but no preimage is recorded to claim with' }

    default:
      return { do: 'wait' }
  }
}
