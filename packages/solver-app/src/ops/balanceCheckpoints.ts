import type { Services } from './services.js'
import { json, messageOf, nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { startCadence } from './cadence.js'
import { createJoin, within } from './guardedRead.js'
import { limitNotification } from './notify.js'

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
}

type CheckpointServices = Pick<Services, 'arkade' | 'ln' | 'onchain' | 'adminStore' | 'config' | 'providerPubkey'>

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
    services.config.network,
    services.config.arkade.arkServerUrl,
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

export const formatCheckpointWarning = (checkpoint: BalanceCheckpoint, network: string): string | null =>
  checkpoint.decreases.length === 0
    ? null
    : limitNotification(
        [
          `POSSIBLE LOSS — ${network} — checkpoint #${checkpoint.id}`,
          'Fees, withdrawals and funds in flight are not reconciled.',
          ...checkpoint.decreases.map(({ asset, before, after, decrease }) =>
            formatBalanceChange({ asset, before, after, delta: String(-BigInt(decrease)) }),
          ),
        ].join('\n'),
      )

const balanceReads = new WeakMap<CheckpointServices, ReturnType<typeof createJoin>>()

const sats = (value: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('balance must be non-negative safe integer sats')
  return String(value)
}

export const recordBalanceCheckpoint = async (services: CheckpointServices): Promise<BalanceCheckpoint> => {
  const startedAt = nowSeconds()
  const errors: Record<string, string> = {}
  const joined = balanceReads.get(services) ?? createJoin()
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
      const assets = new Map<string, bigint>()
      for (const asset of balance.assets) {
        if (asset.amount < 0n) throw new Error('asset balance must be non-negative')
        assets.set(asset.assetId, (assets.get(asset.assetId) ?? 0n) + asset.amount)
      }
      return {
        totalSats: sats(balance.total),
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
  const scope = balanceCheckpointScope(services)
  const totalSats =
    Object.keys(errors).length > 0 || arkade === null
      ? null
      : String(
          BigInt(arkade.totalSats) +
            (onchain ? BigInt(onchain.confirmedSats) + BigInt(onchain.unconfirmedSats) : 0n) +
            // A shared rail reports the same pool twice; inbound capacity is never owned funds.
            (onchain?.sharedWithLightning ? 0n : BigInt(lightningSats ?? '0')),
        )
  const previous = totalSats === null ? undefined : await services.adminStore.latestCompleteBalanceCheckpoint(scope)
  const changes = previous ? checkpointChanges(previous, { scope, totalSats, arkade }) : null
  const decreases = (changes ?? [])
    .filter(({ delta }) => BigInt(delta) < 0n)
    .map(({ asset, before, after, delta }) => ({ asset, before, after, decrease: String(-BigInt(delta)) }))
  return services.adminStore.recordBalanceCheckpoint({
    scope,
    startedAt,
    finishedAt: nowSeconds(),
    arkade,
    lightningSats,
    onchain,
    totalSats,
    errors,
    previousId: previous?.id ?? null,
    decreases,
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
            'fees, withdrawals and funds in flight are not reconciled',
        )
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
