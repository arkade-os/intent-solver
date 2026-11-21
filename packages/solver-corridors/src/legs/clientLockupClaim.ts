import type { ArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import { unilateralExitRecourse } from '@arkade-os/solver-arkade/arkade/unilateralExit.js'
import { boundedSpendInputs, claimOutputs } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { capture, unwrap } from '@arkade-os/solver-core/util/capture.js'
import type { BaseSwapStore } from '../db/baseSwapStore.js'
import { advanceUnrolledClaims, awaitLeftover, lockupLeftover, settleUnrolledClaims } from '../unrolledSpendStep.js'
import { adoptedOnly, unadopted } from './arkadeLockup.js'

/**
 * Marks a row parked because its lockup read short mid-claim. `rearmPendingClaims` finds rows by this text
 * at boot and puts them back on the claim path, so it must not change apart from there.
 */
export const CLAIM_UNPROVEN = 'while claiming; no claim txid recorded'

export interface ClientLockupClaim<S extends string> {
  store: Pick<BaseSwapStore<unknown, S>, 'patch' | 'transition' | 'fail'>
  arkade: ArkadeOps
  row: {
    id: string
    pkScript: string
    paymentHash: string
    amountSats: number
    lockupOutpoints: string | null
    unrolledClaim: string | null
  }
  /** The row in the shape the covenant script is rebuilt from. */
  covenantRow: CovenantScriptRow
  preimage: string
  edge: { from: S; to: S }
  now: () => number
  refundDeadlineReached: () => Promise<boolean>
  /** Start the deadline read beside the spend-evidence read, not after it. For a deadline that needs the chain tip. */
  readsDeadlineWithEvidence: boolean
  /** Take a spend that reveals our preimage as our own claim, landed before a crash took its txid. */
  recognisesOwnClaim: boolean
  onTickError?: (id: string, error: unknown) => void
}

/**
 * Collects the client's Arkade lockup with the preimage, once the payout is out. One implementation for
 * every corridor that starts with such a lockup. Returns whether the row moved.
 */
export const claimClientLockup = async <S extends string>(claim: ClientLockupClaim<S>): Promise<boolean> => {
  const { store, arkade, row, covenantRow, preimage, edge } = claim
  // An unrolled output is already off Arkade, so its claim is not parked behind the vtxo read.
  const lockupsP = capture(arkade.findLockups(row.pkScript))
  const unrolled = await advanceUnrolledClaims(store, row, arkade, covenantRow, preimage)
  const lockups = unwrap(await lockupsP)
  const outputs = claimOutputs(adoptedOnly(lockups, row.lockupOutpoints), row.amountSats)
  // `claimOutputs` falls back to every adopted output when the asset-free ones fall short, so a dust asset
  // vtxo reads non-empty yet cannot cover the amount. Guard on value, not emptiness.
  const held = outputs.reduce((sum, o) => sum + o.value, 0)
  if (held < row.amountSats && unrolled === null) return whenLockupIsShort(claim, held)

  let txid: string | null = null
  try {
    if (outputs.length > 0) txid = await arkade.claim(covenantRow, outputs, preimage)
  } catch (error) {
    // Past the deadline the client's refund is open and racing us, and nothing cooperative is left to
    // retry. The row names the way out that needs no server. Before the deadline the failure is retried.
    if (await claim.refundDeadlineReached()) {
      const detail = error instanceof Error ? error.message : String(error)
      await store.fail(row.id, edge.from, `claim failing past the refund deadline: ${detail} — ${recourseOf(claim)}`)
      return false
    }
    throw error
  }
  const extra = unadopted(lockups, row.lockupOutpoints)
  if (txid !== null && extra.length > 0) {
    await arkade.refund(covenantRow, extra).catch((error: unknown) => claim.onTickError?.(row.id, error))
  }
  const recourse = () => recourseOf(claim)
  if (unrolled === null || unrolled.settled) {
    const claimedNow = txid === null ? [] : boundedSpendInputs(outputs, claim.now())
    const leftover = await lockupLeftover(arkade, row, claimedNow, unrolled)
    if (leftover.length > 0) {
      const pastDeadline = await claim.refundDeadlineReached()
      return awaitLeftover(store, row.id, edge.from, txid, leftover, pastDeadline, recourse)
    }
  }
  if (unrolled === null) {
    await store.transition(row.id, edge.from, edge.to, { claim_ark_txid: txid })
    return false
  }
  if (txid !== null) await store.patch(row.id, { claim_ark_txid: txid })
  return settleUnrolledClaims(store, row.id, edge, unrolled, recourse)
}

const recourseOf = <S extends string>(claim: ClientLockupClaim<S>): string =>
  unilateralExitRecourse(claim.covenantRow, { solverPubkey: claim.arkade.providerPubkey })

// The lockup reads empty or short and no claim txid is on the row. `findLockups` answers the same for a
// swept, renewed or lagging vtxo as after our own spend, so a short read is NOT "claimed": a false `stuck`
// costs a glance, a false `claimed` costs the funds.
const whenLockupIsShort = async <S extends string>(claim: ClientLockupClaim<S>, held: number): Promise<boolean> => {
  const { store, arkade, row, covenantRow, preimage, edge } = claim
  const evidenceP = arkade.lockupSpendEvidence(row.pkScript)
  const earlyDeadlineP = claim.readsDeadlineWithEvidence ? capture(claim.refundDeadlineReached()) : null
  const outpointsP = claim.recognisesOwnClaim
    ? capture(arkade.findLockupOutpoints ? arkade.findLockupOutpoints(row.pkScript) : Promise.resolve([]))
    : null
  const evidence = await evidenceP
  if (evidence !== 'spent') {
    const pastDeadline = earlyDeadlineP ? unwrap(await earlyDeadlineP) : await claim.refundDeadlineReached()
    if (!pastDeadline) {
      throw new Error(
        `swap ${row.id}: lockup holds ${held} < ${row.amountSats} while claiming but no spend is provable (${evidence})`,
      )
    }
  }
  // A throw keeps the row claiming, so the sweep retries a finalize arkd refused.
  const pending = evidence === 'spent' ? await arkade.finalizePendingClaim?.(covenantRow, preimage) : null
  if (pending) return store.transition(row.id, edge.from, edge.to, { claim_ark_txid: pending })

  if (outpointsP) {
    const outpoints = unwrap(await outpointsP)
    const ours = outpoints.length > 0 && (await arkade.findClaimPreimage?.(outpoints, row.paymentHash))
    // A row with no adopted set has no leftover to check, and one claimed output would hide the rest.
    if (ours && row.lockupOutpoints !== null && (await lockupLeftover(arkade, row, [], null)).length === 0) {
      return store.transition(row.id, edge.from, edge.to, { claim_ark_txid: null })
    }
  }
  await store.fail(row.id, edge.from, `lockup holds ${held} < amount ${row.amountSats} ${CLAIM_UNPROVEN}; needs review`)
  return false
}
