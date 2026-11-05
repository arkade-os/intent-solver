import type { Services } from './services.js'
import { hex } from '@scure/base'
import { LOCKUP_CONTRACT_TYPE, registeredLockupDeadlines } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { json, messageOf, nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { startCadence } from './cadence.js'
import { createJoin, STALE_READ_MS, within } from './guardedRead.js'
import { limitNotification } from './notify.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import type { OperatorWithdrawal } from '../admin/db.js'

export interface BalanceCheckpoint {
  id: number
  scope: string
  startedAt: number
  finishedAt: number
  arkade: { totalSats: string; assets: Record<string, string> } | null
  lightningSats: string | null
  onchain: { confirmedSats: string; unconfirmedSats: string; sharedWithLightning: boolean } | null
  totalSats: string | null
  errors: Record<string, string>
  previousId: number | null
  decreases: { asset: string; before: string; after: string; decrease: string; uncertainFeeAllowanceSats?: string }[]
  // Optional: checkpoints stored before recovery tracking have neither.
  recovered?: (FollowedDecrease & { after: string })[]
  unrecovered?: FollowedDecrease[]
  rebalance?: {
    accountingVersion?: 2
    comparisonTotalSats: string
    feeAllowanceUsedSats: string
    uncertainFeeAllowanceSats?: string
    accountedOverrideIds?: string[]
    seenIds: string[]
    pending: {
      id: string
      chargedAt: number
      debitObserved: boolean
      observedDebitSats: string
      remainingSats: string
    }[]
    attributionDeferred?: {
      anchorCheckpointId: number
      anchorComparisonTotalSats: string
      since: number
      transferIds: string[]
      overrideId?: string
      lastReminderAt?: number
      heldBtcDecreaseIds?: number[]
      heldBtcWarnings?: FollowedDecrease[]
    }
    delayedBtcWarningIds?: number[]
  }
  operatorWithdrawals?: {
    comparisonTotalSats: string
    seenIds: string[]
    observedSourceDropSats: string
    rebalanceReservedSats: string
    rebalanceIds: string[]
    rebalanceAllowanceBasis?: { id: string; debitSats: string }[]
    rebalanceAttributionAmbiguous?: boolean
    pending: {
      id: string
      createdAt: number
      address: string
      amountSats: number
      feeSats: number | null
      reference: string | null
      state: OperatorWithdrawal['state']
    }[]
    deferred?: {
      anchorCheckpointId: number
      since: number
      lastReminderAt?: number
      heldBtcDecreaseIds?: number[]
      heldBtcWarnings?: FollowedDecrease[]
    }
    delayedBtcWarningIds?: number[]
    explained?: { id: string; reference: string; address: string; debitSats: string }[]
  }
}

/** A decrease reported at `checkpointId`, followed until its asset is back to `before`. */
export interface FollowedDecrease {
  checkpointId: number
  asset: string
  before: string
  uncertainFeeAllowanceSats?: string
}

export const rebalanceOverlapReady = (
  checkpoint: BalanceCheckpoint | null | undefined,
  pendingIds: readonly string[],
): boolean => {
  if (
    !checkpoint ||
    checkpoint.totalSats === null ||
    checkpoint.rebalance?.accountingVersion !== 2 ||
    pendingIds.length !== 1
  )
    return false
  const deferred = checkpoint.rebalance.attributionDeferred
  if (
    (deferred &&
      (deferred.overrideId || deferred.transferIds.length !== 1 || deferred.transferIds[0] !== pendingIds[0])) ||
    checkpoint.rebalance.delayedBtcWarningIds?.length ||
    checkpoint.decreases.some((row) => row.asset === 'BTC')
  )
    return false
  const pending = new Map(checkpoint.rebalance.pending.map((row) => [row.id, row]))
  return pendingIds.every((id) => {
    const row = pending.get(id)
    return row?.debitObserved === true && BigInt(row.observedDebitSats) > 0n && checkpoint.startedAt >= row.chargedAt
  })
}

// ponytail: oldest dropped past this; a time window instead if late follow-ups turn into noise.
const UNRECOVERED_LIMIT = 20
const DEFERRAL_REMINDER_SECONDS = 30 * 60

type CheckpointServices = Pick<
  Services,
  'arkade' | 'ln' | 'onchain' | 'adminStore' | 'config' | 'providerPubkey' | 'rebalanceStore'
>

export interface BalanceCheckpointReport {
  current: BalanceCheckpoint | null
  previous: BalanceCheckpoint | null
}

export interface BalanceChange {
  asset: string
  before: string
  after: string
  delta: string
}

export const balanceCheckpointScope = (services: CheckpointServices): string =>
  json([
    // Bumped when what a checkpoint counts changes, so the new measure starts its own baseline.
    'excludes-user-lockups',
    services.config.network,
    services.config.arkade.operatorUrl,
    services.providerPubkey,
    services.config.lnBackend,
    services.config.lnd?.socket ?? null,
    services.ln !== null,
    services.onchain !== null,
  ])

export const checkpointChanges = (
  before: Pick<BalanceCheckpoint, 'scope' | 'totalSats' | 'arkade'>,
  after: Pick<BalanceCheckpoint, 'scope' | 'totalSats' | 'arkade'>,
): BalanceChange[] | null => {
  if (
    before.scope !== after.scope ||
    before.totalSats === null ||
    after.totalSats === null ||
    !before.arkade ||
    !after.arkade
  )
    return null
  const change = (asset: string, from: string, to: string): BalanceChange => ({
    asset,
    before: from,
    after: to,
    delta: String(BigInt(to) - BigInt(from)),
  })
  const ids = new Set([...Object.keys(before.arkade.assets), ...Object.keys(after.arkade.assets)])
  return [
    change('BTC', before.totalSats, after.totalSats),
    ...[...ids].map((id) => change(`arkade:${id}`, before.arkade!.assets[id] ?? '0', after.arkade!.assets[id] ?? '0')),
  ]
}

export const formatBalanceChange = (change: BalanceChange): string => {
  const delta = BigInt(change.delta)
  const amount = (value: string) => BigInt(value).toLocaleString('en-US')
  return `${change.asset}: ${delta > 0n ? '+' : ''}${amount(change.delta)} ${change.asset === 'BTC' ? 'sats' : 'base units'} (${amount(change.before)} → ${amount(change.after)})`
}

const levelOf = (checkpoint: BalanceCheckpoint, asset: string): string =>
  asset === 'BTC'
    ? (checkpoint.operatorWithdrawals?.comparisonTotalSats ??
      checkpoint.rebalance?.comparisonTotalSats ??
      checkpoint.totalSats ??
      '0')
    : (checkpoint.arkade?.assets[asset.slice('arkade:'.length)] ?? '0')

// A decrease is alerted only once the next checkpoint still shows it: a claim landing a few
// seconds after its payment, or two rails read a moment apart, is back by then.
export const formatCheckpointWarning = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  const delayed = new Set([
    ...(checkpoint.rebalance?.delayedBtcWarningIds ?? []),
    ...(checkpoint.operatorWithdrawals?.delayedBtcWarningIds ?? []),
  ])
  const held = (checkpoint.unrecovered ?? []).filter(
    ({ checkpointId, asset }) =>
      (checkpointId === checkpoint.previousId || (asset === 'BTC' && delayed.has(checkpointId))) &&
      !(asset === 'BTC' && (checkpoint.rebalance?.attributionDeferred || checkpoint.operatorWithdrawals?.deferred)),
  )
  return held.length === 0
    ? null
    : limitNotification(
        [
          `⚠️ *POSSIBLE LOSS* · ${network} · checkpoint #${checkpoint.id}`,
          ...held.map(({ checkpointId, asset, before }) => {
            const after = levelOf(checkpoint, asset)
            if (asset === 'BTC' && checkpoint.rebalance)
              return `BTC: unexplained decrease of ${(BigInt(before) - BigInt(after)).toLocaleString('en-US')} sats since checkpoint #${checkpointId}`
            return `${formatBalanceChange({ asset, before, after, delta: String(BigInt(after) - BigInt(before)) })} since checkpoint #${checkpointId}`
          }),
          checkpoint.rebalance?.attributionDeferred || checkpoint.operatorWithdrawals?.deferred
            ? 'BTC loss and recovery notices are deferred while transfer attribution is uncertain; asset changes are still reported.'
            : checkpoint.rebalance
              ? `Known rebalances and their allowed fees are accounted for. Other fees and ${checkpoint.operatorWithdrawals ? 'untracked withdrawals' : 'withdrawals'} may explain this decrease. A RECOVERED follow-up is sent if it clears.`
              : checkpoint.operatorWithdrawals
                ? 'Tracked operator withdrawals are accounted for. Other fees or untracked withdrawals may explain this decrease. A RECOVERED follow-up is sent if the balance comes back.'
                : 'Fees, withdrawals and funds in flight are not reconciled. A RECOVERED follow-up is sent if the balance comes back.',
        ].join('\n'),
      )
}

export const formatCheckpointRecovery = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  // A decrease back by the next checkpoint was never alerted.
  const delayed = new Set([
    ...(checkpoint.rebalance?.delayedBtcWarningIds ?? []),
    ...(checkpoint.operatorWithdrawals?.delayedBtcWarningIds ?? []),
  ])
  const recovered = (checkpoint.recovered ?? []).filter(
    ({ checkpointId, asset }) =>
      checkpointId !== checkpoint.previousId &&
      !(asset === 'BTC' && (checkpoint.rebalance?.attributionDeferred || checkpoint.operatorWithdrawals?.deferred)) &&
      !(asset === 'BTC' && delayed.has(checkpointId)),
  )
  return recovered.length === 0
    ? null
    : limitNotification(
        [
          `✅ *RECOVERED* · ${network} · checkpoint #${checkpoint.id}`,
          ...recovered.map(({ checkpointId, asset, before, after }) =>
            asset === 'BTC' && checkpoint.rebalance
              ? `BTC: unexplained decrease cleared since checkpoint #${checkpointId}`
              : `${formatBalanceChange({ asset, before, after, delta: String(BigInt(after) - BigInt(before)) })} since before the drop at checkpoint #${checkpointId}`,
          ),
          checkpoint.rebalance?.attributionDeferred || checkpoint.operatorWithdrawals?.deferred
            ? 'BTC loss and recovery notices are deferred while transfer attribution is uncertain; asset changes are still reported.'
            : checkpoint.rebalance
              ? 'The unexplained decrease has cleared after accounting for known rebalances and their allowed fees.'
              : checkpoint.operatorWithdrawals
                ? 'The balance has returned; tracked operator withdrawals were accounted for, but the earlier decrease is not fully explained.'
                : 'The balance is back to its level before the drop; the cause is not reconciled.',
        ].join('\n'),
      )
}

export const formatCheckpointDeferral = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  const deferred = checkpoint.rebalance?.attributionDeferred
  if (deferred?.lastReminderAt === checkpoint.startedAt) {
    const raw = BigInt(checkpoint.totalSats ?? '0')
    const baseline = BigInt(deferred.anchorComparisonTotalSats)
    const difference = raw - baseline
    const ids = deferred.transferIds
    const transferContext = ids.length <= 3 ? ids.join(', ') : `${ids.slice(-3).join(', ')} (${ids.length} total)`
    return limitNotification(
      `⚠️ *BTC BALANCE CHECK STILL DEFERRED* · ${network} · checkpoint #${checkpoint.id}\n` +
        `Raw BTC: ${raw.toLocaleString('en-US')} sats; ` +
        `comparison baseline: ${baseline.toLocaleString('en-US')} sats; ` +
        `raw difference: ${difference > 0n ? '+' : ''}${difference.toLocaleString('en-US')} sats. ` +
        `This includes funds in flight; loss is unconfirmed. Tracked transfers: ${transferContext}. ` +
        'Check their destination receipts. BTC loss and RECOVERED notices remain paused until settlement and a fresh balance read.',
    )
  }
  return deferred?.anchorCheckpointId === checkpoint.previousId
    ? limitNotification(
        `ℹ️ *BTC BALANCE CHECK DEFERRED* · ${network} · checkpoint #${checkpoint.id}\n` +
          (deferred.overrideId
            ? 'Two manual rebalances are in flight, so aggregate balances cannot identify which transfer credited first. '
            : 'A rebalance is in flight and a balance increase cannot yet be tied to its destination credit. ') +
          'Raw balances and asset checks continue. BTC loss and RECOVERED checks resume after settlement and a fresh balance read.',
      )
    : null
}

export const formatOperatorWithdrawalNotice = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  const state = checkpoint.operatorWithdrawals
  if (!state) return null
  const lines =
    state.explained?.map(
      ({ reference, address, debitSats }) =>
        `${BigInt(debitSats).toLocaleString('en-US')} sats left Arkade for ${address}. Transaction: ${reference}.`,
    ) ?? []
  if (lines.length && !state.deferred)
    return limitNotification(
      `ℹ️ *OPERATOR WITHDRAWAL ACCOUNTED FOR* · ${network} · checkpoint #${checkpoint.id}\n` +
        `${lines.join('\n')} The source debit is documented; destination receipt is not verified by this check. ` +
        'Raw balances are unchanged.',
    )
  const deferred = state.deferred
  if (!deferred) return null
  const firstNotice =
    deferred.anchorCheckpointId === checkpoint.previousId ||
    (deferred.anchorCheckpointId === 0 && checkpoint.previousId === null)
  if (!firstNotice && deferred.lastReminderAt !== checkpoint.startedAt && lines.length === 0) return null
  const pending = state.pending.map(
    ({ id, amountSats, feeSats, address, reference, state: status }) =>
      `${id}: ${amountSats.toLocaleString('en-US')} sats to ${address}${feeSats === null ? ' (fee pending)' : ` + ${feeSats.toLocaleString('en-US')} sats quoted fee`}; ${status}${reference ? `; transaction ${reference}` : ''}`,
  )
  return limitNotification(
    `ℹ️ *WITHDRAWAL BALANCE CHECK PENDING* · ${network} · checkpoint #${checkpoint.id}\n` +
      `${lines.length ? `${lines.join('\n')}\n` : ''}${pending.join('\n')}\nRaw BTC: ${BigInt(checkpoint.totalSats ?? '0').toLocaleString('en-US')} sats. ` +
      (state.rebalanceAttributionAmbiguous
        ? 'Withdrawal and rebalance debits overlap. Matching settled source transactions are still needed; reconcile manually if wallet history cannot supply them. '
        : checkpoint.startedAt - deferred.since >= DEFERRAL_REMINDER_SECONDS
          ? 'Action needed: check the wallet transaction and destination receipt for the journal ID before retrying or closing this transfer. '
          : 'The Arkade debit or final send result is still being checked. ') +
      'BTC loss and RECOVERED alerts are paused; asset checks continue. Verify the destination receipt separately.',
  )
}

export const checkpointNotices =
  (network: string, post: (text: string) => void) =>
  (checkpoint: BalanceCheckpoint): void => {
    for (const text of [
      formatCheckpointDeferral(checkpoint, network),
      formatOperatorWithdrawalNotice(checkpoint, network),
      formatCheckpointRecovery(checkpoint, network),
      formatCheckpointWarning(checkpoint, network),
    ]) {
      if (text) post(text)
    }
  }

const balanceReads = new WeakMap<CheckpointServices, ReturnType<typeof createJoin>>()

const sats = (value: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('balance must be non-negative safe integer sats')
  return String(value)
}

const minimum = (...values: bigint[]): bigint => values.reduce((a, b) => (a < b ? a : b))
const positive = (value: bigint): bigint => (value > 0n ? value : 0n)
const pendingRebalance = (row: RebalanceTransfer): boolean =>
  row.state === 'submitting' || row.state === 'pending' || row.state === 'needs_reconciliation'
const completionAllowance = (row: RebalanceTransfer, sourceDebit: bigint): bigint => {
  if (row.state !== 'completed' || row.creditedSats === undefined) return 0n
  return minimum(BigInt(sats(row.feeSats)), positive(sourceDebit - BigInt(sats(row.creditedSats))))
}

const accountRebalances = (
  previous: BalanceCheckpoint | undefined,
  totalSats: string,
  arkadeSats: string,
  transfers: RebalanceTransfer[],
  startedAt: number,
): NonNullable<BalanceCheckpoint['rebalance']> => {
  let feeAllowance = BigInt(previous?.rebalance?.feeAllowanceUsedSats ?? '0')
  const pending = (previous?.rebalance?.pending ?? []).map((row) => ({ ...row }))
  const seen = new Set(previous?.rebalance?.seenIds ?? [])
  const byId = new Map(transfers.map((row) => [row.id, row]))
  if (pending.some((row) => !byId.has(row.id))) throw new Error('tracked rebalance is missing from its journal')
  const delta =
    previous?.totalSats === undefined || previous.totalSats === null
      ? 0n
      : BigInt(totalSats) - BigInt(previous.totalSats)
  let decrease = positive(-delta)
  let sourceDecrease = previous?.arkade ? positive(BigInt(previous.arkade.totalSats) - BigInt(arkadeSats)) : 0n
  const sourceDecreaseBeforeAttribution = sourceDecrease
  for (const row of transfers) {
    if (row.chargedAt === undefined) continue
    sats(row.chargedAt)
    sats(row.debitSats)
    if (seen.has(row.id) || pending.some((item) => item.id === row.id)) continue
    if (pendingRebalance(row)) {
      pending.push({
        id: row.id,
        chargedAt: row.chargedAt,
        debitObserved: !previous || (!previous.rebalance && row.chargedAt <= previous.startedAt),
        observedDebitSats: '0',
        remainingSats: '0',
      })
    } else if (previous) {
      const debit = minimum(sourceDecrease, BigInt(sats(row.debitSats)))
      const explained = minimum(decrease, completionAllowance(row, debit))
      feeAllowance += explained
      decrease -= explained
      sourceDecrease -= debit
    }
  }
  for (const held of pending) {
    const row = byId.get(held.id)!
    if (!held.debitObserved && sourceDecrease > 0n) {
      const debit = minimum(sourceDecrease, BigInt(sats(row.debitSats)))
      const explained = minimum(decrease, debit)
      held.remainingSats = String(explained)
      held.observedDebitSats = String(debit)
      held.debitObserved = true
      decrease -= explained
      sourceDecrease -= debit
    }
  }
  const remaining = pending.filter((held) => {
    const row = byId.get(held.id)!
    if (pendingRebalance(row)) return true
    feeAllowance += completionAllowance(row, BigInt(held.observedDebitSats))
    return false
  })
  const earlierDeferred = previous?.rebalance?.attributionDeferred
  const legacyUnprovenReturn =
    previous?.rebalance?.accountingVersion !== 2 &&
    pending.some(
      (row) => row.debitObserved && BigInt(row.remainingSats) < BigInt(row.observedDebitSats) && byId.has(row.id),
    )
  const ambiguousRise =
    (remaining.length > 0 && (delta > 0n || sourceDecreaseBeforeAttribution > positive(-delta))) || legacyUnprovenReturn
  const mayResolve = earlierDeferred && remaining.length === 0 && previous?.rebalance?.pending.length === 0
  const attributionDeferred = mayResolve
    ? undefined
    : earlierDeferred
      ? {
          ...earlierDeferred,
          transferIds: [...new Set([...earlierDeferred.transferIds, ...remaining.map((row) => row.id)])],
          ...(remaining.some((row) => !earlierDeferred.transferIds.includes(row.id)) ||
          startedAt - (earlierDeferred.lastReminderAt ?? earlierDeferred.since) >= DEFERRAL_REMINDER_SECONDS
            ? { lastReminderAt: startedAt }
            : {}),
        }
      : ambiguousRise && previous?.totalSats !== null && previous?.totalSats !== undefined
        ? {
            anchorCheckpointId: previous.id,
            anchorComparisonTotalSats: previous.rebalance?.comparisonTotalSats ?? previous.totalSats,
            since: Math.min(previous.finishedAt, ...remaining.map((row) => row.chargedAt)),
            transferIds: remaining.map((row) => row.id),
            heldBtcDecreaseIds: previous.decreases.some(({ asset }) => asset === 'BTC') ? [previous.id] : [],
            heldBtcWarnings: previous.decreases
              .filter(({ asset }) => asset === 'BTC')
              .map(({ asset, before, uncertainFeeAllowanceSats }) => ({
                checkpointId: previous.id,
                asset,
                before,
                ...(uncertainFeeAllowanceSats ? { uncertainFeeAllowanceSats } : {}),
              })),
          }
        : undefined
  const comparisonTotalSats = String(
    BigInt(totalSats) + feeAllowance + remaining.reduce((sum, row) => sum + BigInt(row.remainingSats), 0n),
  )
  return {
    accountingVersion: 2,
    comparisonTotalSats: attributionDeferred?.anchorComparisonTotalSats ?? comparisonTotalSats,
    feeAllowanceUsedSats: String(feeAllowance),
    ...(previous?.rebalance?.uncertainFeeAllowanceSats
      ? { uncertainFeeAllowanceSats: previous.rebalance.uncertainFeeAllowanceSats }
      : {}),
    ...(previous?.rebalance?.accountedOverrideIds
      ? { accountedOverrideIds: previous.rebalance.accountedOverrideIds }
      : {}),
    seenIds: transfers.map((row) => row.id),
    pending: remaining,
    ...(attributionDeferred ? { attributionDeferred } : {}),
    ...(mayResolve && earlierDeferred?.heldBtcDecreaseIds?.length
      ? { delayedBtcWarningIds: earlierDeferred.heldBtcDecreaseIds }
      : {}),
  }
}

const accountDeferredRebalances = (
  previous: BalanceCheckpoint | undefined,
  totalSats: string,
  transfers: RebalanceTransfer[],
  startedAt: number,
): NonNullable<BalanceCheckpoint['rebalance']> | undefined => {
  const prior = previous?.rebalance
  const priorDeferred = prior?.attributionDeferred?.overrideId ? prior.attributionDeferred : undefined
  const priorSingleDeferred =
    prior?.attributionDeferred && !prior.attributionDeferred.overrideId ? prior.attributionDeferred : undefined
  const marker = transfers.find((row) => {
    const overrideIds = (row as RebalanceTransfer & { overridePendingIds?: string[] }).overridePendingIds
    return row.chargedAt !== undefined && overrideIds?.length && !prior?.accountedOverrideIds?.includes(row.id)
  })
  if (!priorDeferred && !marker) return undefined
  if (!previous || prior?.accountingVersion !== 2)
    throw new Error('overlapping rebalance has no modern complete accounting baseline')
  const overrideIds = (marker as (RebalanceTransfer & { overridePendingIds?: string[] }) | undefined)
    ?.overridePendingIds
  const deferred =
    priorDeferred ??
    (priorSingleDeferred
      ? {
          ...priorSingleDeferred,
          transferIds: [...new Set([...priorSingleDeferred.transferIds, ...(overrideIds ?? []), marker!.id])],
          overrideId: marker!.id,
        }
      : {
          anchorCheckpointId: previous.id,
          anchorComparisonTotalSats: prior.comparisonTotalSats,
          since: Math.min(previous.startedAt, ...prior.pending.map((row) => row.chargedAt), marker!.chargedAt!),
          transferIds: [...new Set([...(overrideIds ?? []), marker!.id])],
          overrideId: marker!.id,
          heldBtcDecreaseIds: previous.decreases.some(({ asset }) => asset === 'BTC') ? [previous.id] : [],
          heldBtcWarnings: previous.decreases
            .filter(({ asset }) => asset === 'BTC')
            .map(({ asset, before, uncertainFeeAllowanceSats }) => ({
              checkpointId: previous.id,
              asset,
              before,
              ...(uncertainFeeAllowanceSats ? { uncertainFeeAllowanceSats } : {}),
            })),
        })
  const byId = new Map(transfers.map((row) => [row.id, row]))
  const tracked = deferred.transferIds.map((id) => {
    const row = byId.get(id)
    if (!row) throw new Error(`overlapping rebalance ${id} is missing from its journal`)
    return row
  })
  const seenIds = [...new Set([...prior.seenIds, ...transfers.map((row) => row.id)])]
  const allTerminal = tracked.every((row) => !pendingRebalance(row) && row.state !== 'quoted')
  if (!priorDeferred || !allTerminal || startedAt <= Math.max(...tracked.map((row) => row.updatedAt))) {
    const reminded =
      priorSingleDeferred ||
      (priorDeferred && startedAt - (deferred.lastReminderAt ?? deferred.since) >= DEFERRAL_REMINDER_SECONDS)
    return {
      accountingVersion: 2,
      comparisonTotalSats: deferred.anchorComparisonTotalSats,
      feeAllowanceUsedSats: prior.feeAllowanceUsedSats,
      ...(prior.uncertainFeeAllowanceSats ? { uncertainFeeAllowanceSats: prior.uncertainFeeAllowanceSats } : {}),
      ...(prior.accountedOverrideIds ? { accountedOverrideIds: prior.accountedOverrideIds } : {}),
      seenIds,
      pending: [],
      attributionDeferred: reminded ? { ...deferred, lastReminderAt: startedAt } : deferred,
    }
  }
  const allowed = tracked.reduce((sum, row) => sum + completionAllowance(row, BigInt(sats(row.debitSats))), 0n)
  const feeAllowance = BigInt(prior.feeAllowanceUsedSats) + allowed
  const uncertainAllowance = BigInt(prior.uncertainFeeAllowanceSats ?? '0') + allowed
  return {
    accountingVersion: 2,
    comparisonTotalSats: String(BigInt(totalSats) + feeAllowance),
    feeAllowanceUsedSats: String(feeAllowance),
    uncertainFeeAllowanceSats: String(uncertainAllowance),
    accountedOverrideIds: [...new Set([...(prior.accountedOverrideIds ?? []), deferred.overrideId!])],
    seenIds,
    pending: [],
    ...(deferred.heldBtcDecreaseIds?.length ? { delayedBtcWarningIds: deferred.heldBtcDecreaseIds } : {}),
  }
}

const newRebalanceSourceDebits = (
  previous: BalanceCheckpoint | undefined,
  transfers: RebalanceTransfer[],
): RebalanceTransfer[] => {
  const seen = new Set(previous?.rebalance?.seenIds ?? [])
  const pending = new Map((previous?.rebalance?.pending ?? []).map((row) => [row.id, row]))
  return transfers.filter((row) => {
    if (row.chargedAt === undefined) return false
    const prior = pending.get(row.id)
    return prior ? !prior.debitObserved : !seen.has(row.id)
  })
}

type WithdrawalHistory = {
  key: { arkTxid: string; commitmentTxid: string }
  type: string
  amount: number
  settled: boolean
}

const historyDebit = (reference: string, history: readonly WithdrawalHistory[]): bigint | null => {
  const matched = history.filter(
    (row) => row.type === 'SENT' && (row.key.arkTxid === reference || row.key.commitmentTxid === reference),
  )
  if (!matched.length || matched.some((row) => !row.settled)) return null
  try {
    return matched.reduce((sum, row) => sum + BigInt(sats(row.amount)), 0n)
  } catch {
    return null
  }
}

const accountOperatorWithdrawals = (
  previous: BalanceCheckpoint | undefined,
  totalSats: string,
  arkadeSats: string,
  rebalance: BalanceCheckpoint['rebalance'],
  transfers: RebalanceTransfer[],
  withdrawals: OperatorWithdrawal[],
  history: readonly WithdrawalHistory[],
  startedAt: number,
): {
  state: NonNullable<BalanceCheckpoint['operatorWithdrawals']>
  previousComparisonSats: string
  rebalanceCorrectionSats: bigint
  explainedDebitSats: bigint
} => {
  const prior = previous?.operatorWithdrawals
  const priorComparison =
    prior?.comparisonTotalSats ?? previous?.rebalance?.comparisonTotalSats ?? previous?.totalSats ?? totalSats
  const seen = new Set(prior?.seenIds ?? [])
  const rows = new Map(withdrawals.map((row) => [row.id, row]))
  const pending = (prior?.pending ?? []).map((held) => {
    const row = rows.get(held.id)
    if (!row) throw new Error(`tracked operator withdrawal ${held.id} is missing from its journal`)
    return {
      ...held,
      address: row.address,
      amountSats: row.amountSats,
      feeSats: row.feeSats,
      reference: row.reference,
      state: row.state,
    }
  })
  for (const row of withdrawals) {
    if (seen.has(row.id) || pending.some((held) => held.id === row.id)) continue
    if (!previous && row.state === 'sent') {
      seen.add(row.id)
      continue
    }
    if (row.state === 'failed') {
      seen.add(row.id)
      continue
    }
    pending.push({
      id: row.id,
      createdAt: row.createdAt,
      address: row.address,
      amountSats: row.amountSats,
      feeSats: row.feeSats,
      reference: row.reference,
      state: row.state,
    })
  }
  const sourceDrop = previous?.arkade ? positive(BigInt(previous.arkade.totalSats) - BigInt(arkadeSats)) : 0n
  const live = pending.filter((held) => held.state !== 'preparing' && held.state !== 'failed')
  const sourceDropSats = BigInt(prior?.observedSourceDropSats ?? '0') + (live.length ? sourceDrop : 0n)
  const rebalanceIds = new Set(prior?.rebalanceIds ?? [])
  let reservedSats = BigInt(prior?.rebalanceReservedSats ?? '0')
  if (live.length)
    for (const row of newRebalanceSourceDebits(previous, transfers)) {
      if (rebalanceIds.has(row.id)) continue
      rebalanceIds.add(row.id)
      reservedSats += BigInt(sats(row.debitSats))
    }
  const byRebalanceId = new Map(transfers.map((row) => [row.id, row]))
  const priorRebalances = new Map((previous?.rebalance?.pending ?? []).map((row) => [row.id, row]))
  const currentRebalances = new Map((rebalance?.pending ?? []).map((row) => [row.id, row]))
  const allowanceBasis = new Map((prior?.rebalanceAllowanceBasis ?? []).map(({ id, debitSats }) => [id, debitSats]))
  for (const id of rebalanceIds) {
    const held = currentRebalances.get(id) ?? priorRebalances.get(id)
    if (held) allowanceBasis.set(id, held.observedDebitSats)
  }
  const rebalanceTerminal = [...rebalanceIds].every((id) => {
    const row = byRebalanceId.get(id)
    if (!row) throw new Error(`tracked rebalance ${id} is missing from its journal`)
    return !pendingRebalance(row) && row.state !== 'quoted'
  })
  const references = live.map((held) => held.reference)
  const exactDebits = live.map((held) =>
    held.state === 'sent' && held.feeSats !== null && held.reference
      ? BigInt(sats(held.amountSats)) + BigInt(sats(held.feeSats))
      : null,
  )
  const rebalanceReferences = [...rebalanceIds].map((id) => byRebalanceId.get(id)?.fundingTxid)
  const allReferences = [...references, ...rebalanceReferences]
  const uniqueReferences = new Set(allReferences).size === allReferences.length
  const matchedHistoryIndexes = allReferences.flatMap((reference) =>
    reference
      ? history.flatMap((row, index) =>
          row.type === 'SENT' && (row.key.arkTxid === reference || row.key.commitmentTxid === reference) ? [index] : [],
        )
      : [],
  )
  const disjointHistory = new Set(matchedHistoryIndexes).size === matchedHistoryIndexes.length
  const rebalanceActualDebits = [...rebalanceIds].map((id, i) => {
    const row = byRebalanceId.get(id)
    const reference = rebalanceReferences[i]
    const actual = reference ? historyDebit(reference, history) : null
    return row && allowanceBasis.has(id) && actual !== null && actual > 0n && actual <= BigInt(sats(row.debitSats))
      ? actual
      : null
  })
  const rebalanceEvidenceComplete =
    rebalanceTerminal && uniqueReferences && disjointHistory && rebalanceActualDebits.every((debit) => debit !== null)
  const rebalanceAttributionAmbiguous = rebalanceIds.size > 0 && rebalanceTerminal && !rebalanceEvidenceComplete
  const rebalanceCorrectionSats =
    rebalanceEvidenceComplete && !rebalance?.attributionDeferred
      ? [...rebalanceIds].reduce((sum, id, i) => {
          const row = byRebalanceId.get(id)!
          return (
            sum +
            completionAllowance(row, rebalanceActualDebits[i]!) -
            completionAllowance(row, BigInt(allowanceBasis.get(id)!))
          )
        }, 0n)
      : 0n
  if (rebalanceEvidenceComplete && !rebalance?.attributionDeferred)
    [...rebalanceIds].forEach((id, i) => allowanceBasis.set(id, String(rebalanceActualDebits[i]!)))
  const baseComparison = String(BigInt(rebalance?.comparisonTotalSats ?? totalSats) + rebalanceCorrectionSats)
  const reservedActual = rebalanceEvidenceComplete
    ? rebalanceActualDebits.reduce<bigint>((sum, debit) => sum + debit!, 0n)
    : reservedSats
  const proved =
    live.length > 0 &&
    !rebalance?.attributionDeferred &&
    rebalanceEvidenceComplete &&
    uniqueReferences &&
    exactDebits.every((debit, i) => debit !== null && historyDebit(references[i]!, history) === debit) &&
    sourceDropSats >= reservedActual + exactDebits.reduce<bigint>((sum, debit) => sum + (debit ?? 0n), 0n)
  let explainedDebit = 0n
  const explained: NonNullable<BalanceCheckpoint['operatorWithdrawals']>['explained'] = []
  const remaining = pending.filter((held) => {
    if (held.state === 'failed') {
      seen.add(held.id)
      return false
    }
    if (!proved || held.feeSats === null || !held.reference) return true
    const debit = BigInt(sats(held.amountSats)) + BigInt(sats(held.feeSats))
    explainedDebit += debit
    explained.push({ id: held.id, reference: held.reference, address: held.address, debitSats: String(debit) })
    seen.add(held.id)
    return false
  })
  const remainingLive = remaining.some((held) => held.state !== 'preparing')
  const previousComparisonSats = String(BigInt(priorComparison) - explainedDebit)
  const priorDeferred = prior?.deferred
  const deferred = remainingLive
    ? priorDeferred
      ? (rebalanceAttributionAmbiguous && !prior?.rebalanceAttributionAmbiguous) ||
        startedAt - (priorDeferred.lastReminderAt ?? priorDeferred.since) >= DEFERRAL_REMINDER_SECONDS
        ? { ...priorDeferred, lastReminderAt: startedAt }
        : priorDeferred
      : previous
        ? {
            anchorCheckpointId: previous.id,
            since: startedAt,
            heldBtcDecreaseIds: previous.decreases.some(({ asset }) => asset === 'BTC') ? [previous.id] : [],
            heldBtcWarnings: previous.decreases
              .filter(({ asset }) => asset === 'BTC')
              .map(({ asset, before, uncertainFeeAllowanceSats }) => ({
                checkpointId: previous.id,
                asset,
                before,
                ...(uncertainFeeAllowanceSats ? { uncertainFeeAllowanceSats } : {}),
              })),
          }
        : { anchorCheckpointId: 0, since: startedAt }
    : undefined
  return {
    state: {
      comparisonTotalSats: deferred ? previousComparisonSats : baseComparison,
      seenIds: [...seen],
      observedSourceDropSats: remainingLive ? String(sourceDropSats) : '0',
      rebalanceReservedSats: remainingLive ? String(reservedActual) : '0',
      rebalanceIds: remainingLive ? [...rebalanceIds] : [],
      ...(remainingLive && allowanceBasis.size
        ? { rebalanceAllowanceBasis: [...allowanceBasis].map(([id, debitSats]) => ({ id, debitSats })) }
        : {}),
      ...(remainingLive && rebalanceAttributionAmbiguous ? { rebalanceAttributionAmbiguous: true } : {}),
      pending: remaining,
      ...(deferred ? { deferred } : {}),
      ...(!deferred && priorDeferred?.heldBtcDecreaseIds?.length
        ? { delayedBtcWarningIds: priorDeferred.heldBtcDecreaseIds }
        : {}),
      ...(explained.length ? { explained } : {}),
    },
    previousComparisonSats,
    rebalanceCorrectionSats,
    explainedDebitSats: explainedDebit,
  }
}

export const recordBalanceCheckpoint = async (services: CheckpointServices): Promise<BalanceCheckpoint> => {
  const startedAt = nowSeconds()
  const scope = balanceCheckpointScope(services)
  const baseline = await services.adminStore.latestCompleteBalanceCheckpoint(scope)
  const errors: Record<string, string> = {}
  const joined = balanceReads.get(services) ?? createJoin(STALE_READ_MS)
  balanceReads.set(services, joined)
  const read = async <T>(name: string, fetch: () => Promise<T>, fresh = false): Promise<T | null> => {
    try {
      return await within(fresh ? fetch : joined(name, fetch), 10_000)()
    } catch (error) {
      errors[name] = messageOf(error)
      return null
    }
  }
  const withdrawalSince = Math.min(
    baseline?.startedAt ?? startedAt,
    ...(baseline?.operatorWithdrawals?.pending ?? []).map((row) => row.createdAt),
  )
  const withdrawals = await read(
    'operatorWithdrawals',
    () => services.adminStore.listOperatorWithdrawals(scope, withdrawalSince),
    true,
  )
  const relevantWithdrawals = withdrawals?.filter((row) => row.source === 'arkade') ?? []
  const hasSentWithdrawal = relevantWithdrawals.some((row) => row.state === 'sent')
  const [arkadeSnapshot, lightningSats, onchain] = await Promise.all([
    read(hasSentWithdrawal ? 'arkadeWithHistory' : 'arkade', async () => {
      if (hasSentWithdrawal) await services.arkade.wallet.getSpendableVtxos({ requireSynced: true, maxSyncAgeMs: 0 })
      const history = hasSentWithdrawal ? await services.arkade.wallet.getTransactionHistory() : []
      const balance = await services.arkade.wallet.getBalance()
      // `total` counts every lockup the wallet watches. One a user funded is theirs until we claim it,
      // so counting it turns each refund into a loss. An unbounded age never syncs, so this reads the
      // repository getBalance just read, even when its sync failed. Not atomic: a write landing between
      // the two reads skews one sample, and the one-checkpoint alert hold absorbs it.
      const lockups = await (
        await services.arkade.wallet.getContractManager()
      ).getContractsWithVtxos({ type: [LOCKUP_CONTRACT_TYPE] }, undefined, {
        maxSyncAgeMs: Number.MAX_SAFE_INTEGER,
        unspentOnly: true,
      })
      const solverPubkey = hex.encode(await services.arkade.identity.xOnlyPublicKey())
      const theirs = new Set(
        registeredLockupDeadlines(
          lockups.map(({ contract }) => contract),
          solverPubkey,
        ).map(({ script }) => script),
      )
      const inFlight = lockups.filter(({ contract }) => theirs.has(contract.script)).flatMap(({ vtxos }) => vtxos)
      const assets = new Map<string, bigint>()
      for (const asset of balance.assets) {
        if (asset.amount < 0n) throw new Error('asset balance must be non-negative')
        assets.set(asset.assetId, (assets.get(asset.assetId) ?? 0n) + asset.amount)
      }
      for (const asset of inFlight.flatMap((vtxo) => vtxo.assets ?? [])) {
        assets.set(asset.assetId, (assets.get(asset.assetId) ?? 0n) - asset.amount)
      }
      if ([...assets.values()].some((amount) => amount < 0n)) throw new Error('asset balance must be non-negative')
      return {
        arkade: {
          totalSats: sats(balance.total - inFlight.reduce((sum, vtxo) => sum + vtxo.value, 0)),
          assets: Object.fromEntries([...assets].map(([id, amount]) => [id, String(amount)])),
        },
        history,
      }
    }),
    services.ln ? read('lightning', async () => sats((await services.ln!.getBalance()).availableSats)) : null,
    services.onchain
      ? read('onchain', async () => {
          const balance = await services.onchain!.getBalance()
          return {
            confirmedSats: sats(balance.confirmedSats),
            unconfirmedSats: sats(balance.unconfirmedSats),
            sharedWithLightning: balance.sharedWithLightning === true,
          }
        })
      : null,
  ])
  const arkade = arkadeSnapshot?.arkade ?? null
  const withdrawalsAfterBalance = await read(
    'operatorWithdrawalsAfterBalance',
    () => services.adminStore.listOperatorWithdrawals(scope, withdrawalSince),
    true,
  )
  if (
    withdrawals !== null &&
    withdrawalsAfterBalance !== null &&
    JSON.stringify(relevantWithdrawals) !==
      JSON.stringify(withdrawalsAfterBalance.filter((row) => row.source === 'arkade'))
  )
    errors.operatorWithdrawals = 'operator withdrawal journal changed during balance sample'
  let totalSats =
    Object.keys(errors).length > 0 || arkade === null
      ? null
      : String(
          BigInt(arkade.totalSats) +
            (onchain ? BigInt(onchain.confirmedSats) + BigInt(onchain.unconfirmedSats) : 0n) +
            // A shared rail reports the same pool twice; inbound capacity is never owned funds.
            (onchain?.sharedWithLightning ? 0n : BigInt(lightningSats ?? '0')),
        )
  let rebalance: BalanceCheckpoint['rebalance']
  let rebalanceTransfers: RebalanceTransfer[] = []
  if (totalSats !== null && (services.rebalanceStore || baseline?.rebalance)) {
    const since = Math.min(
      baseline?.startedAt ?? startedAt,
      ...(baseline?.rebalance?.pending ?? []).map((row) => row.chargedAt),
      ...(baseline?.rebalance?.attributionDeferred ? [baseline.rebalance.attributionDeferred.since] : []),
    )
    const transfers = await read('rebalance', async () => {
      const store = services.rebalanceStore
      if (!store) return []
      const listed = await store.checkpointTransfers(since)
      const present = new Set(listed.map((row) => row.id))
      const missingIds = [
        ...(baseline?.rebalance?.attributionDeferred?.transferIds ?? []),
        ...(baseline?.operatorWithdrawals?.rebalanceIds ?? []),
      ].filter((id) => !present.has(id))
      const missing = await Promise.all(missingIds.map((id) => store.get(id)))
      if (missing.some((row) => !row)) throw new Error('tracked rebalance is missing from its journal')
      return [...listed, ...(missing as RebalanceTransfer[])].sort(
        (a, b) => (a.chargedAt ?? 0) - (b.chargedAt ?? 0) || a.id.localeCompare(b.id),
      )
    })
    try {
      if (transfers === null) totalSats = null
      else {
        rebalanceTransfers = transfers
        rebalance =
          accountDeferredRebalances(baseline, totalSats, transfers, startedAt) ??
          accountRebalances(baseline, totalSats, arkade!.totalSats, transfers, startedAt)
      }
    } catch (error) {
      errors.rebalance = messageOf(error)
      totalSats = null
    }
  }
  let operatorWithdrawals: BalanceCheckpoint['operatorWithdrawals']
  let previousComparisonSats =
    baseline?.operatorWithdrawals?.comparisonTotalSats ??
    baseline?.rebalance?.comparisonTotalSats ??
    baseline?.totalSats
  let explainedDebitSats = 0n
  if (totalSats !== null) {
    try {
      if (withdrawals === null) totalSats = null
      else {
        const accounted = accountOperatorWithdrawals(
          baseline,
          totalSats,
          arkade!.totalSats,
          rebalance,
          rebalanceTransfers,
          relevantWithdrawals,
          arkadeSnapshot?.history ?? [],
          startedAt,
        )
        operatorWithdrawals = accounted.state
        previousComparisonSats = accounted.previousComparisonSats
        explainedDebitSats = accounted.explainedDebitSats
        if (rebalance && accounted.rebalanceCorrectionSats !== 0n)
          rebalance = {
            ...rebalance,
            comparisonTotalSats: String(BigInt(rebalance.comparisonTotalSats) + accounted.rebalanceCorrectionSats),
            feeAllowanceUsedSats: String(BigInt(rebalance.feeAllowanceUsedSats) + accounted.rebalanceCorrectionSats),
          }
      }
    } catch (error) {
      errors.operatorWithdrawals = messageOf(error)
      totalSats = null
    }
  }
  const previous = totalSats === null ? undefined : baseline
  const changes = previous
    ? checkpointChanges(
        { ...previous, totalSats: previousComparisonSats ?? previous.totalSats },
        {
          scope,
          totalSats: operatorWithdrawals?.comparisonTotalSats ?? rebalance?.comparisonTotalSats ?? totalSats,
          arkade,
        },
      )
    : null
  const btcDeferred = rebalance?.attributionDeferred !== undefined || operatorWithdrawals?.deferred !== undefined
  const decreases = (changes ?? [])
    .filter(({ asset, delta }) => BigInt(delta) < 0n && !(btcDeferred && asset === 'BTC'))
    .map(({ asset, before, after, delta }) => ({
      asset,
      before,
      after,
      decrease: String(-BigInt(delta)),
      ...(asset === 'BTC' && previous?.rebalance?.uncertainFeeAllowanceSats
        ? { uncertainFeeAllowanceSats: previous.rebalance.uncertainFeeAllowanceSats }
        : {}),
    }))
  const levels = new Map((changes ?? []).map(({ asset, after }) => [asset, BigInt(after)]))
  const level = (asset: string) => levels.get(asset) ?? 0n
  const followed: FollowedDecrease[] = previous
    ? [
        ...new Map(
          [
            ...(previous.unrecovered ?? []),
            ...(previous.rebalance?.attributionDeferred?.heldBtcWarnings ?? []),
            ...(previous.operatorWithdrawals?.deferred?.heldBtcWarnings ?? []),
            ...previous.decreases.map(({ asset, before, uncertainFeeAllowanceSats }) => ({
              checkpointId: previous.id,
              asset,
              ...(uncertainFeeAllowanceSats ? { uncertainFeeAllowanceSats } : {}),
              before,
            })),
          ].map((row) => [`${row.checkpointId}:${row.asset}`, row] as const),
        ).values(),
      ].map((row) =>
        row.asset === 'BTC' && explainedDebitSats > 0n
          ? { ...row, before: String(BigInt(row.before) - explainedDebitSats) }
          : row,
      )
    : []
  if (btcDeferred) {
    const heldIds = new Set([
      ...(previous?.rebalance?.attributionDeferred?.heldBtcDecreaseIds ?? []),
      ...(previous?.operatorWithdrawals?.deferred?.heldBtcDecreaseIds ?? []),
      ...(rebalance?.attributionDeferred?.heldBtcDecreaseIds ?? []),
      ...(operatorWithdrawals?.deferred?.heldBtcDecreaseIds ?? []),
      ...(rebalance?.delayedBtcWarningIds ?? []),
      ...(operatorWithdrawals?.delayedBtcWarningIds ?? []),
    ])
    const heldBtcDecreaseIds = [...heldIds]
    const heldBtcWarnings = followed.filter((row) => row.asset === 'BTC' && heldIds.has(row.checkpointId))
    if (rebalance?.attributionDeferred)
      rebalance = {
        ...rebalance,
        attributionDeferred: { ...rebalance.attributionDeferred, heldBtcDecreaseIds, heldBtcWarnings },
      }
    if (operatorWithdrawals?.deferred)
      operatorWithdrawals = {
        ...operatorWithdrawals,
        deferred: { ...operatorWithdrawals.deferred, heldBtcDecreaseIds, heldBtcWarnings },
      }
  }
  const isBack = ({ asset, before, uncertainFeeAllowanceSats }: FollowedDecrease) => {
    if (asset !== 'BTC') return level(asset) >= BigInt(before)
    if (btcDeferred) return false
    return (
      level(asset) - BigInt(rebalance?.uncertainFeeAllowanceSats ?? '0') >=
      BigInt(before) - BigInt(uncertainFeeAllowanceSats ?? '0')
    )
  }
  const delayed = new Set([
    ...(rebalance?.delayedBtcWarningIds ?? []),
    ...(operatorWithdrawals?.delayedBtcWarningIds ?? []),
  ])
  const heldBtcIds = new Set([
    ...(rebalance?.attributionDeferred?.heldBtcDecreaseIds ?? rebalance?.delayedBtcWarningIds ?? []),
    ...(operatorWithdrawals?.deferred?.heldBtcDecreaseIds ?? operatorWithdrawals?.delayedBtcWarningIds ?? []),
  ])
  const stillOpen = followed.filter((row) => !isBack(row))
  const protectedBtc = stillOpen.filter((row) => row.asset === 'BTC' && heldBtcIds.has(row.checkpointId))
  const room = Math.max(0, UNRECOVERED_LIMIT - protectedBtc.length)
  const capped = room ? stillOpen.filter((row) => !protectedBtc.includes(row)).slice(-room) : []
  return services.adminStore.recordBalanceCheckpoint({
    scope,
    startedAt,
    finishedAt: nowSeconds(),
    arkade,
    lightningSats,
    onchain,
    totalSats,
    ...(rebalance ? { rebalance } : {}),
    ...(operatorWithdrawals ? { operatorWithdrawals } : {}),
    errors,
    previousId: previous?.id ?? null,
    decreases,
    recovered: followed
      .filter((d) => isBack(d) && !(d.asset === 'BTC' && delayed.has(d.checkpointId)))
      .map((d) => ({ ...d, after: String(level(d.asset)) })),
    unrecovered: [...protectedBtc, ...capped],
  })
}

export const withBalanceCheckpoints = async (input: {
  checkpoint(): Promise<BalanceCheckpoint>
  run(): Promise<void>
  signal: AbortSignal
  log(line: string): void
  onCheckpoint?(checkpoint: BalanceCheckpoint): void
}): Promise<void> => {
  const cadence = startCadence({
    intervalMs: 60_000,
    signal: input.signal,
    pass: async () => {
      const checkpoint = await input.checkpoint()
      if (checkpoint.totalSats === null) input.log(`balance checkpoint incomplete: ${json(checkpoint.errors)}`)
      for (const decrease of checkpoint.decreases) {
        input.log(
          `POSSIBLE LOSS: balance decreased at checkpoint ${checkpoint.id}: ${json(decrease)}; ` +
            (checkpoint.rebalance
              ? 'known rebalances and their allowed fees are accounted for'
              : 'fees, withdrawals and funds in flight are not reconciled'),
        )
      }
      for (const recovery of checkpoint.recovered ?? []) {
        input.log(`RECOVERED: balance back at checkpoint ${checkpoint.id}: ${json(recovery)}`)
      }
      input.onCheckpoint?.(checkpoint)
    },
    onError: (error) => input.log(`balance checkpoint failed: ${messageOf(error)}`),
  })
  try {
    await input.run()
  } finally {
    await cadence.stop()
  }
}
