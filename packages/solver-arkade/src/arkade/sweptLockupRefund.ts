/**
 * The policy behind an UNATTENDED swept-lockup refund, shared by all three send
 * corridors so one judgement call cannot drift into three.
 *
 * TWO TIERS. `refused` means the solver never paid, so returning whatever sits
 * at the script is safe whatever `refund_outcome` says. An EXPOSED row is
 * refunded only against a verdict the caller supplies, out of a state with an
 * edge to `refused`; without one it is named and left alone, because refunding
 * blind would hand the client both legs.
 */
import type { ArkadeOps } from './arkadeOps.js'
import type { CovenantScriptRow } from './covenantRow.js'
import type { FundedOutput } from './wallet.js'

export interface SweptRefundRow {
  id: string
  state: string
  lockupValue?: number | null
  refundOutcome?: string | null
}

export interface SweptRefundRecord {
  lockup_value?: number
  refund_outcome?: string
  refund_ark_txid?: string
}

export type SweptRefundDecision = { refund: true; reason: string } | { refund: false; why: string }

export type SweptLockupRefund =
  | { swapId: string; txid: string; recorded: boolean; closedFrom?: string }
  | { swapId: string; heldInState: string; why?: string }
  | null

export interface SweptLockupRefundDeps<Row extends SweptRefundRow> {
  find(pkScript: string): Promise<Row | null>
  swept(pkScript: string): Promise<readonly FundedOutput[]>
  refund(row: Row, swept: readonly FundedOutput[]): Promise<string>
  record(row: Row, fields: SweptRefundRecord): Promise<void>
  decide?(row: Row): Promise<SweptRefundDecision>
  close?(row: Row, reason: string): Promise<void>
  /** `claiming` stays out: it holds a revealed preimage, so a refund there pays twice. */
  closableStates?: readonly string[]
}

/** Null on a build without the optional swept ops — a fork, a test's fake. */
export const sweptOpsFrom = <Row extends SweptRefundRow>(
  arkade: Pick<ArkadeOps, 'findSweptLockups' | 'refundSwept'>,
  covenantRow: (row: Row) => CovenantScriptRow,
): Pick<SweptLockupRefundDeps<Row>, 'swept' | 'refund'> | null => {
  const { findSweptLockups, refundSwept } = arkade
  if (!findSweptLockups || !refundSwept) return null
  return {
    swept: (pkScript) => findSweptLockups.call(arkade, pkScript),
    refund: (row, swept) => refundSwept.call(arkade, covenantRow(row), swept),
  }
}

export const refundColumnsOnly = (fields: SweptRefundRecord) => ({
  ...(fields.refund_outcome ? { refund_outcome: fields.refund_outcome } : {}),
  ...(fields.refund_ark_txid ? { refund_ark_txid: fields.refund_ark_txid } : {}),
})

export const refundSweptLockupFor = async <Row extends SweptRefundRow>(
  pkScript: string,
  deps: SweptLockupRefundDeps<Row>,
): Promise<SweptLockupRefund> => {
  const row = await deps.find(pkScript)
  if (!row) return null
  const swept = await deps.swept(pkScript)
  if (swept.length === 0) return null

  let decision: SweptRefundDecision | undefined
  if (row.state !== 'refused') {
    const closable = deps.decide && deps.close && (deps.closableStates ?? []).includes(row.state)
    if (!closable) return { swapId: row.id, heldInState: row.state }
    decision = await deps.decide!(row)
    if (!decision.refund) return { swapId: row.id, heldInState: row.state, why: decision.why }
  }

  const txid = await deps.refund(row, swept)
  const recorded = (row.refundOutcome ?? null) === null
  const fields: SweptRefundRecord = {
    ...((row.lockupValue ?? null) === null
      ? { lockup_value: swept.reduce((sum, output) => sum + output.value, 0) }
      : {}),
    ...(recorded ? { refund_outcome: 'pushed', refund_ark_txid: txid } : {}),
  }
  if (Object.keys(fields).length > 0) await deps.record(row, fields)
  // AFTER the record: a closed row with no recorded refund is unreconstructable.
  if (decision?.refund) {
    await deps.close!(row, decision.reason)
    return { swapId: row.id, txid, recorded, closedFrom: row.state }
  }
  return { swapId: row.id, txid, recorded }
}
