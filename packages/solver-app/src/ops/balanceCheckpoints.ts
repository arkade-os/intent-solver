import type { Services } from './services.js'
import { hex } from '@scure/base'
import { LOCKUP_CONTRACT_TYPE, registeredLockupDeadlines } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { json, messageOf, nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { startCadence } from './cadence.js'
import { createJoin, STALE_READ_MS, within } from './guardedRead.js'
import { limitNotification } from './notify.js'
import type { RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'

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
  decreases: { asset: string; before: string; after: string; decrease: string }[]
  // Optional: checkpoints stored before recovery tracking have neither.
  recovered?: (FollowedDecrease & { after: string })[]
  unrecovered?: FollowedDecrease[]
  rebalance?: {
    accountingVersion?: 2
    comparisonTotalSats: string
    feeAllowanceUsedSats: string
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
      heldBtcDecreaseIds?: number[]
    }
    delayedBtcWarningIds?: number[]
  }
}

/** A decrease reported at `checkpointId`, followed until its asset is back to `before`. */
export interface FollowedDecrease {
  checkpointId: number
  asset: string
  before: string
}

// ponytail: oldest dropped past this; a time window instead if late follow-ups turn into noise.
const UNRECOVERED_LIMIT = 20

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
    ? (checkpoint.rebalance?.comparisonTotalSats ?? checkpoint.totalSats ?? '0')
    : (checkpoint.arkade?.assets[asset.slice('arkade:'.length)] ?? '0')

// A decrease is alerted only once the next checkpoint still shows it: a claim landing a few
// seconds after its payment, or two rails read a moment apart, is back by then.
export const formatCheckpointWarning = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  const delayed = new Set(checkpoint.rebalance?.delayedBtcWarningIds ?? [])
  const held = (checkpoint.unrecovered ?? []).filter(
    ({ checkpointId, asset }) =>
      (checkpointId === checkpoint.previousId || (asset === 'BTC' && delayed.has(checkpointId))) &&
      !(asset === 'BTC' && checkpoint.rebalance?.attributionDeferred),
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
          checkpoint.rebalance
            ? 'Known rebalances and their allowed fees are accounted for. Other fees and withdrawals may explain this decrease. A RECOVERED follow-up is sent if it clears.'
            : 'Fees, withdrawals and funds in flight are not reconciled. A RECOVERED follow-up is sent if the balance comes back.',
        ].join('\n'),
      )
}

export const formatCheckpointRecovery = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  // A decrease back by the next checkpoint was never alerted.
  const recovered = (checkpoint.recovered ?? []).filter(({ checkpointId }) => checkpointId !== checkpoint.previousId)
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
          checkpoint.rebalance
            ? 'The unexplained decrease has cleared after accounting for known rebalances and their allowed fees.'
            : 'The balance is back to its level before the drop; the cause is not reconciled.',
        ].join('\n'),
      )
}

export const formatCheckpointDeferral = (checkpoint: BalanceCheckpoint, network: string): string | null => {
  const deferred = checkpoint.rebalance?.attributionDeferred
  return deferred?.anchorCheckpointId === checkpoint.previousId
    ? limitNotification(
        `ℹ️ *BTC BALANCE CHECK DEFERRED* · ${network} · checkpoint #${checkpoint.id}\n` +
          'A rebalance is in flight and a balance increase cannot yet be tied to its destination credit. ' +
          'Raw balances and asset checks continue. BTC loss and RECOVERED checks resume after settlement and a fresh balance read.',
      )
    : null
}

export const checkpointNotices =
  (network: string, post: (text: string) => void) =>
  (checkpoint: BalanceCheckpoint): void => {
    for (const text of [
      formatCheckpointDeferral(checkpoint, network),
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
  // An aggregate rise cannot prove this transfer's credit; another wallet flow may have arrived first.
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
    feeAllowance += minimum(BigInt(held.remainingSats), completionAllowance(row, BigInt(held.observedDebitSats)))
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
        }
      : ambiguousRise && previous?.totalSats !== null && previous?.totalSats !== undefined
        ? {
            anchorCheckpointId: previous.id,
            anchorComparisonTotalSats: previous.rebalance?.comparisonTotalSats ?? previous.totalSats,
            since: previous.finishedAt,
            transferIds: remaining.map((row) => row.id),
            heldBtcDecreaseIds: previous.decreases.some(({ asset }) => asset === 'BTC') ? [previous.id] : [],
          }
        : undefined
  const comparisonTotalSats = String(
    BigInt(totalSats) + feeAllowance + remaining.reduce((sum, row) => sum + BigInt(row.remainingSats), 0n),
  )
  return {
    accountingVersion: 2,
    comparisonTotalSats: attributionDeferred?.anchorComparisonTotalSats ?? comparisonTotalSats,
    feeAllowanceUsedSats: String(feeAllowance),
    seenIds: transfers.map((row) => row.id),
    pending: remaining,
    ...(attributionDeferred ? { attributionDeferred } : {}),
    ...(mayResolve && earlierDeferred?.heldBtcDecreaseIds?.length
      ? { delayedBtcWarningIds: earlierDeferred.heldBtcDecreaseIds }
      : {}),
  }
}

export const recordBalanceCheckpoint = async (services: CheckpointServices): Promise<BalanceCheckpoint> => {
  const startedAt = nowSeconds()
  const scope = balanceCheckpointScope(services)
  const baseline = await services.adminStore.latestCompleteBalanceCheckpoint(scope)
  const errors: Record<string, string> = {}
  const joined = balanceReads.get(services) ?? createJoin(STALE_READ_MS)
  balanceReads.set(services, joined)
  const read = async <T>(name: string, fetch: () => Promise<T>): Promise<T | null> => {
    try {
      return await within(joined(name, fetch), 10_000)()
    } catch (error) {
      errors[name] = messageOf(error)
      return null
    }
  }
  const [arkade, lightningSats, onchain] = await Promise.all([
    read('arkade', async () => {
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
        totalSats: sats(balance.total - inFlight.reduce((sum, vtxo) => sum + vtxo.value, 0)),
        assets: Object.fromEntries([...assets].map(([id, amount]) => [id, String(amount)])),
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
  if (totalSats !== null && (services.rebalanceStore || baseline?.rebalance)) {
    const since = Math.min(
      baseline?.startedAt ?? startedAt,
      ...(baseline?.rebalance?.pending ?? []).map((row) => row.chargedAt),
    )
    const transfers = await read('rebalance', async () => services.rebalanceStore?.checkpointTransfers(since) ?? [])
    try {
      if (transfers === null) totalSats = null
      else rebalance = accountRebalances(baseline, totalSats, arkade!.totalSats, transfers)
    } catch (error) {
      errors.rebalance = messageOf(error)
      totalSats = null
    }
  }
  const previous = totalSats === null ? undefined : baseline
  const changes = previous
    ? checkpointChanges(
        { ...previous, totalSats: previous.rebalance?.comparisonTotalSats ?? previous.totalSats },
        { scope, totalSats: rebalance?.comparisonTotalSats ?? totalSats, arkade },
      )
    : null
  const btcDeferred = rebalance?.attributionDeferred !== undefined
  const decreases = (changes ?? [])
    .filter(({ asset, delta }) => BigInt(delta) < 0n && !(btcDeferred && asset === 'BTC'))
    .map(({ asset, before, after, delta }) => ({ asset, before, after, decrease: String(-BigInt(delta)) }))
  const levels = new Map((changes ?? []).map(({ asset, after }) => [asset, BigInt(after)]))
  const level = (asset: string) => levels.get(asset) ?? 0n
  const followed: FollowedDecrease[] = previous
    ? [
        ...(previous.unrecovered ?? []),
        ...previous.decreases.map(({ asset, before }) => ({ checkpointId: previous.id, asset, before })),
      ]
    : []
  const isBack = ({ asset, before }: FollowedDecrease) =>
    !(btcDeferred && asset === 'BTC') && level(asset) >= BigInt(before)
  const delayed = new Set(rebalance?.delayedBtcWarningIds ?? [])
  return services.adminStore.recordBalanceCheckpoint({
    scope,
    startedAt,
    finishedAt: nowSeconds(),
    arkade,
    lightningSats,
    onchain,
    totalSats,
    ...(rebalance ? { rebalance } : {}),
    errors,
    previousId: previous?.id ?? null,
    decreases,
    recovered: followed
      .filter((d) => isBack(d) && !(d.asset === 'BTC' && delayed.has(d.checkpointId)))
      .map((d) => ({ ...d, after: String(level(d.asset)) })),
    unrecovered: followed.filter((d) => !isBack(d)).slice(-UNRECOVERED_LIMIT),
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
