import type { ArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import type { SaveUnrolledSpend, UnrolledSpendStep } from '@arkade-os/solver-arkade/arkade/unrolledSpend.js'
import type { BaseSwapStore } from './db/baseSwapStore.js'
import { outpointKey, uncollected, type AdoptedOutput } from './legs/arkadeLockup.js'

const SPENT_BY_ANOTHER = 'spent on L1 by a transaction that is not ours'

/**
 * Both receive legs' handling of one co-signed L1 refund step. `spent` and `closed` escalate
 * only once `P` is worth nothing: until then the claim recheck runs every tick, and `stuck`
 * would end it.
 */
export const applyUnrolledSpendStep = async <S extends string>(
  store: Pick<BaseSwapStore<unknown, S>, 'patch' | 'transition' | 'fail'>,
  row: { id: string; unrolledRefund: string | null },
  edge: { from: S; to: S },
  step: UnrolledSpendStep,
  preimageStillUseful: boolean,
  recourse: () => string,
): Promise<boolean> => {
  if (step.kind === 'waiting') return false
  if (step.kind === 'pending' || step.kind === 'confirmed') {
    const record = JSON.stringify(step.record)
    if (record !== row.unrolledRefund) await store.patch(row.id, { unrolled_refund: record })
    return step.kind === 'confirmed' ? store.transition(row.id, edge.from, edge.to, {}) : false
  }
  if (preimageStillUseful) return false
  await store.fail(
    row.id,
    edge.from,
    step.kind === 'spent'
      ? `unrolled lockup ${SPENT_BY_ANOTHER}; needs review`
      : `L1 refund of the unrolled lockup refused: ${step.reason} — ${recourse()}`,
  )
  return false
}

export interface UnrolledClaims {
  /** Each claim has confirmed or been lost: nothing is left to push, rebroadcast or bump. */
  settled: boolean
  lost: string[]
  /** `txid:vout` of every L1 claim that has confirmed. */
  confirmed: string[]
  /** The first throw, held until every other output has had its turn. */
  error?: unknown
}

/**
 * The send legs' co-signed L1 claims, one per output the client unrolled, each output's last
 * step kept in `unrolled_claim`. Each is advanced even when another throws: one the explorer
 * cannot price must not hold the rest past `refundLocktime`, when arkd co-signs the client's refund.
 */
export const advanceUnrolledClaims = async (
  store: Pick<BaseSwapStore<unknown, string>, 'patch'>,
  row: { id: string; pkScript: string; unrolledClaim: string | null },
  arkade: Pick<ArkadeOps, 'findLockupOutpoints' | 'claimUnrolled'>,
  covenantRow: CovenantScriptRow,
  preimageHex: string,
): Promise<UnrolledClaims | null> => {
  if (!arkade.findLockupOutpoints || !arkade.claimUnrolled) return null
  const steps = (row.unrolledClaim === null ? {} : JSON.parse(row.unrolledClaim)) as Record<string, UnrolledSpendStep>
  const found = (await arkade.findLockupOutpoints(row.pkScript)).filter((o) => o.unrolled)
  // A claim already under way is followed through, whatever a lagging read leaves out.
  const keys = new Set([...Object.keys(steps), ...found.map((o) => `${o.txid}:${o.vout}`)])
  if (keys.size === 0) return null
  const unrolled = [...keys].map((key) => {
    const [txid, vout] = key.split(':')
    return { txid: txid!, vout: Number(vout) }
  })
  const keep = async (key: string, step: UnrolledSpendStep) => {
    if (JSON.stringify(step) === JSON.stringify(steps[key])) return
    steps[key] = step
    await store.patch(row.id, { unrolled_claim: JSON.stringify(steps) })
  }
  let error: unknown
  for (const { txid, vout } of unrolled) {
    const key = `${txid}:${vout}`
    const known = steps[key]
    if (known?.kind === 'confirmed') continue
    try {
      const record = known?.kind === 'pending' ? known.record : null
      const save: SaveUnrolledSpend = (r) => keep(key, { kind: 'pending', record: r })
      const step = await arkade.claimUnrolled(covenantRow, { txid, vout }, record, save, preimageHex)
      if (step.kind !== 'waiting') await keep(key, step)
    } catch (thrown) {
      error ??= thrown
    }
  }
  const lost: string[] = []
  const confirmed: string[] = []
  let settled = true
  for (const { txid, vout } of unrolled) {
    const step = steps[`${txid}:${vout}`]
    if (step?.kind === 'spent') lost.push(`${txid}:${vout} ${SPENT_BY_ANOTHER}`)
    else if (step?.kind === 'closed') lost.push(`${txid}:${vout}: ${step.reason}`)
    else if (step?.kind === 'confirmed') confirmed.push(`${txid}:${vout}`)
    else settled = false
  }
  return { settled, lost, confirmed, error }
}

/** `claimed` once every L1 claim confirmed; `stuck` once one is lost and none is still out. */
export const settleUnrolledClaims = async <S extends string>(
  store: Pick<BaseSwapStore<unknown, S>, 'transition' | 'fail'>,
  id: string,
  edge: { from: S; to: S },
  claims: UnrolledClaims,
  recourse: () => string,
): Promise<boolean> => {
  if (!claims.settled) {
    if (claims.error !== undefined) throw claims.error
    return false
  }
  if (claims.lost.length === 0) return store.transition(id, edge.from, edge.to, {})
  await store.fail(id, edge.from, `L1 claim of the unrolled lockup lost: ${claims.lost.join('; ')} — ${recourse()}`)
  return false
}

/**
 * `txid:vout` of each output adopted at funding that neither rail has collected. Empty for a
 * row that predates `lockup_outpoints`, which has no set to check against.
 */
export const lockupLeftover = async (
  arkade: Pick<ArkadeOps, 'findLockupOutpoints'>,
  row: { pkScript: string; lockupOutpoints: string | null },
  claimedNow: readonly { txid: string; vout: number }[],
  claims: UnrolledClaims | null,
): Promise<string[]> => {
  if (row.lockupOutpoints === null || !arkade.findLockupOutpoints) return []
  const adopted = JSON.parse(row.lockupOutpoints) as AdoptedOutput[]
  return uncollected(adopted, {
    outpoints: await arkade.findLockupOutpoints(row.pkScript),
    claimedOffchain: new Set(claimedNow.map(outpointKey)),
    claimedOnL1: new Set(claims?.confirmed ?? []),
  }).map(outpointKey)
}

/** Never `claimed` while an adopted output is out: retried until the refund deadline, then parked. */
export const awaitLeftover = async (
  store: Pick<BaseSwapStore<unknown, string>, 'patch' | 'fail'>,
  id: string,
  claimTxid: string | null,
  leftover: readonly string[],
  pastDeadline: boolean,
  recourse: () => string,
): Promise<false> => {
  if (claimTxid !== null) await store.patch(id, { claim_ark_txid: claimTxid })
  if (!pastDeadline) throw new Error(`swap ${id}: lockup output(s) ${leftover.join(', ')} not yet collected`)
  await store.fail(
    id,
    'claiming',
    `lockup output(s) ${leftover.join(', ')} uncollected at the refund deadline — ${recourse()}`,
  )
  return false
}
