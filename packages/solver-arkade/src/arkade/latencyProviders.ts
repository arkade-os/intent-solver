import { AsyncLocalStorage } from 'node:async_hooks'
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk'
import { json, log } from '@arkade-os/solver-core/util/poll.js'

const timingScope = new AsyncLocalStorage<string>()

export const withProviderTimingScope = <T>(scope: string, operation: () => Promise<T>): Promise<T> =>
  process.env.SOLVER_LATENCY_DIAGNOSTICS === '1' ? timingScope.run(scope, operation) : operation()

export class TimedIndexerProvider extends RestIndexerProvider {
  override async getVtxos(options?: Parameters<RestIndexerProvider['getVtxos']>[0]) {
    const started = performance.now()
    const request = {
      scope: timingScope.getStore(),
      scripts: options?.scripts?.length ?? 0,
      outpoints: options?.outpoints?.length ?? 0,
      pageIndex: options?.pageIndex,
      pageSize: options?.pageSize,
      after: options?.after,
      before: options?.before,
      pendingOnly: options?.pendingOnly ?? false,
    }
    try {
      const result = await super.getVtxos(options)
      log(
        'indexer_vtxos_timing',
        json({ ...request, rows: result.vtxos.length, ms: Math.round(performance.now() - started), outcome: 'ok' }),
      )
      return result
    } catch (error) {
      log(
        'indexer_vtxos_timing',
        json({
          ...request,
          ms: Math.round(performance.now() - started),
          outcome: 'failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      )
      throw error
    }
  }
}

export class TimedArkProvider extends RestArkProvider {
  override async submitTx(...args: Parameters<RestArkProvider['submitTx']>) {
    const started = performance.now()
    try {
      const result = await super.submitTx(...args)
      log(
        'ark_submit_timing',
        json({ scope: timingScope.getStore(), ms: Math.round(performance.now() - started), outcome: 'ok' }),
      )
      return result
    } catch (error) {
      log(
        'ark_submit_timing',
        json({
          scope: timingScope.getStore(),
          ms: Math.round(performance.now() - started),
          outcome: 'failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      )
      throw error
    }
  }
}
