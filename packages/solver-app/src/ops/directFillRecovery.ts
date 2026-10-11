import { hex } from '@scure/base'
import { VtxoScript } from '@arkade-os/sdk'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { DirectFillAttempt, DirectFillAttempts } from '@arkade-os/solver-arkade/arkade/directFillAttempts.js'
import {
  buildDirectFillConflict,
  directFillFinalized,
  recoverDirectFillGraph,
  submitDirectFillConflict,
  validateDirectFillGraph,
  type DirectFillChain,
  type DirectFillCoin,
  type DirectFillGraphDeps,
} from '@arkade-os/solver-arkade/arkade/directFillGraph.js'

export interface DirectFillParentProof {
  id: string
  depositTxid: string
  depositVout: number
  offerPkScript: string
}

export interface DirectFillParentStore {
  recoverDirectFill(proof: DirectFillParentProof, fillTxid: string): Promise<boolean>
  cancelDirectFill(proof: DirectFillParentProof, conflictTxid: string): Promise<boolean>
}

export interface DirectFillRecoveryDeps {
  attempts: DirectFillAttempts
  chain: DirectFillChain
  graph: DirectFillGraphDeps
  coins: () => Promise<readonly DirectFillCoin[]>
  serverUnrollScript: ArkadeContext['wallet']['serverUnrollScript']
  parent: (kind: 'offer' | 'rfq') => DirectFillParentStore | null
  now?: () => number
  conflictAfterSeconds?: number
  onError?: (key: string, error: unknown) => void
}

export const DIRECT_FILL_CONFLICT_AFTER_SECONDS = 900

export const createDirectFillRecovery = (deps: DirectFillRecoveryDeps) => {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const errors = new Map<string, string>()
  let running: Promise<void> | undefined

  const acknowledge = async (attempt: DirectFillAttempt): Promise<void> => {
    if (attempt.phase === 'abandoned') {
      await deps.attempts.acknowledge(attempt)
      return
    }
    if (!attempt.outcomeTxid) throw new Error(`direct fill ${attempt.key} has no outcome to acknowledge`)
    if (attempt.parent.kind !== 'standalone') {
      const parent = deps.parent(attempt.parent.kind)
      if (!parent) throw new Error(`direct fill ${attempt.key} parent store unavailable`)
      const proof = {
        id: attempt.parent.id,
        depositTxid: attempt.deposit.txid,
        depositVout: attempt.deposit.vout,
        offerPkScript: attempt.offerPkScript,
      }
      const accepted =
        attempt.phase === 'settled'
          ? await parent.recoverDirectFill(proof, attempt.outcomeTxid)
          : await parent.cancelDirectFill(proof, attempt.outcomeTxid)
      if (!accepted) throw new Error(`direct fill ${attempt.key} parent does not match its proven outcome`)
    }
    await deps.attempts.acknowledge(attempt)
  }

  const record = async (
    attempt: DirectFillAttempt,
    phase: 'settled' | 'cancelled',
    outcomeTxid: string,
  ): Promise<void> => {
    const next: DirectFillAttempt = { ...attempt, phase, outcomeTxid }
    if (await deps.attempts.change(attempt, next)) await acknowledge(next)
  }

  const recover = async (attempt: DirectFillAttempt): Promise<void> => {
    if (['settled', 'cancelled', 'abandoned'].includes(attempt.phase)) return acknowledge(attempt)
    if (deps.attempts.invocationActive(attempt.key)) return
    if (attempt.phase === 'prepared') {
      const abandoned: DirectFillAttempt = { ...attempt, phase: 'abandoned' }
      if (await deps.attempts.change(attempt, abandoned)) await acknowledge(abandoned)
      return
    }
    const graph = attempt.graph!
    const expected = [attempt.deposit, ...attempt.funding]
    const originalFinalized = await directFillFinalized(deps.chain, graph, expected)
    const conflictFinalized =
      attempt.conflict !== undefined && (await directFillFinalized(deps.chain, attempt.conflict, attempt.funding))
    if (originalFinalized && conflictFinalized) throw new Error(`direct fill ${attempt.key} has contradictory finality`)
    if (originalFinalized) return record(attempt, 'settled', validateDirectFillGraph(graph, expected).txid)
    if (conflictFinalized)
      return record(attempt, 'cancelled', validateDirectFillGraph(attempt.conflict!, attempt.funding).txid)
    if (attempt.phase === 'cancelling') {
      await submitDirectFillConflict(deps.graph, attempt.conflict!, attempt.funding)
      return
    }
    if (await recoverDirectFillGraph(deps.graph, graph, expected, attempt.funding)) return
    if (now() - attempt.createdAt < (deps.conflictAfterSeconds ?? DIRECT_FILL_CONFLICT_AFTER_SECONDS)) return

    const { vtxos } = await deps.chain.getVtxos({ outpoints: attempt.funding })
    const unspent = attempt.funding.every((point) => {
      const found = vtxos.filter((coin) => coin.txid === point.txid && coin.vout === point.vout)
      return (
        found.length === 1 &&
        !found[0]!.spentBy &&
        !found[0]!.arkTxId &&
        !(found[0] as { settledBy?: string }).settledBy
      )
    })
    if (!unspent) return
    const live = await deps.coins()
    const coins = attempt.funding.map((point) => {
      const matching = live.filter((coin) => coin.txid === point.txid && coin.vout === point.vout)
      if (matching.length !== 1) throw new Error(`direct fill ${attempt.key} pinned input unavailable for cancellation`)
      const coin = matching[0]!
      const assets = (entries: readonly { assetId: string; amount: bigint | string }[]) =>
        entries
          .map(({ assetId, amount }) => `${assetId}:${amount}`)
          .sort()
          .join(',')
      if (
        coin.value !== point.value ||
        coin.script !== point.script ||
        assets(coin.assets ?? []) !== assets(point.assets)
      ) {
        throw new Error(`direct fill ${attempt.key} pinned input metadata changed`)
      }
      return coin
    })
    const conflict = await buildDirectFillConflict(
      { ...deps.graph, serverUnrollScript: deps.serverUnrollScript },
      coins,
      attempt.proceedsScript,
    )
    const next: DirectFillAttempt = { ...attempt, phase: 'cancelling', conflict }
    if (await deps.attempts.change(attempt, next)) await submitDirectFillConflict(deps.graph, conflict, attempt.funding)
  }

  return {
    sweep(): Promise<void> {
      if (running) return running
      running = (async () => {
        for (const attempt of await deps.attempts.list()) {
          try {
            await recover(attempt)
            errors.delete(attempt.key)
          } catch (error) {
            errors.set(attempt.key, error instanceof Error ? error.message : String(error))
            deps.onError?.(attempt.key, error)
          }
        }
      })().finally(() => {
        running = undefined
      })
      return running
    },
    async diagnostics() {
      const attempts = await deps.attempts.list()
      return {
        unresolved: attempts.length,
        attempts: attempts.map((attempt) => ({
          id: attempt.key,
          phase: attempt.phase,
          ageSeconds: Math.max(0, now() - attempt.createdAt),
          heldInputs: attempt.funding.length,
          error: errors.get(attempt.key) ?? null,
        })),
      }
    },
  }
}

export const directFillRecoveryFor = async (
  ctx: ArkadeContext,
  parent: DirectFillRecoveryDeps['parent'],
  onError?: DirectFillRecoveryDeps['onError'],
) =>
  createDirectFillRecovery({
    attempts: ctx.directFills,
    chain: ctx.wallet.indexerProvider,
    graph: {
      ark: ctx.wallet.arkProvider,
      signer: ctx.identity,
      serverKey: ctx.wallet.arkServerPublicKey,
      solverKeys: [hex.encode(await ctx.identity.xOnlyPublicKey())],
    },
    coins: async () => {
      const coins = await ctx.wallet.getSpendableVtxos({ withRecoverable: false, genericallySpendableOnly: true })
      return coins.map((coin) => ({ ...coin, script: hex.encode(VtxoScript.decode(coin.tapTree).pkScript) }))
    },
    serverUnrollScript: ctx.wallet.serverUnrollScript,
    parent,
    onError,
  })
