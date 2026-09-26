import { AsyncLocalStorage } from 'node:async_hooks'
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk'
import { json, log } from '@arkade-os/solver-core/util/poll.js'

export interface ProviderTimingScope {
  fundRef: string
  submitStarted?: number
  submitFinished?: number
  finalizeStarted?: number
  finalizeFinished?: number
}

const timingScope = new AsyncLocalStorage<ProviderTimingScope>()

export const withProviderTimingScope = <T>(scope: ProviderTimingScope, operation: () => Promise<T>): Promise<T> =>
  process.env.SOLVER_LATENCY_DIAGNOSTICS === '1' ? timingScope.run(scope, operation) : operation()

export const sendPhaseTimings = (scope: ProviderTimingScope, started: number, finished: number) => ({
  beforeSubmitMs: scope.submitStarted === undefined ? undefined : Math.round(scope.submitStarted - started),
  submitMs:
    scope.submitStarted === undefined || scope.submitFinished === undefined
      ? undefined
      : Math.round(scope.submitFinished - scope.submitStarted),
  checkpointMs:
    scope.submitFinished === undefined || scope.finalizeStarted === undefined
      ? undefined
      : Math.round(scope.finalizeStarted - scope.submitFinished),
  finalizeMs:
    scope.finalizeStarted === undefined || scope.finalizeFinished === undefined
      ? undefined
      : Math.round(scope.finalizeFinished - scope.finalizeStarted),
  afterFinalizeMs: scope.finalizeFinished === undefined ? undefined : Math.round(finished - scope.finalizeFinished),
})

export class TimedIndexerProvider extends RestIndexerProvider {
  override async getVtxos(options?: Parameters<RestIndexerProvider['getVtxos']>[0]) {
    const started = performance.now()
    const request = {
      fundRef: timingScope.getStore()?.fundRef,
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
    const scope = timingScope.getStore()
    if (scope) scope.submitStarted = started
    try {
      const result = await super.submitTx(...args)
      log(
        'ark_submit_timing',
        json({ fundRef: scope?.fundRef, ms: Math.round(performance.now() - started), outcome: 'ok' }),
      )
      return result
    } catch (error) {
      log(
        'ark_submit_timing',
        json({
          fundRef: scope?.fundRef,
          ms: Math.round(performance.now() - started),
          outcome: 'failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      )
      throw error
    } finally {
      if (scope) scope.submitFinished = performance.now()
    }
  }

  override async finalizeTx(...args: Parameters<RestArkProvider['finalizeTx']>) {
    const started = performance.now()
    const scope = timingScope.getStore()
    if (scope) scope.finalizeStarted = started
    try {
      const result = await super.finalizeTx(...args)
      log(
        'ark_finalize_timing',
        json({ fundRef: scope?.fundRef, ms: Math.round(performance.now() - started), outcome: 'ok' }),
      )
      return result
    } catch (error) {
      log(
        'ark_finalize_timing',
        json({
          fundRef: scope?.fundRef,
          ms: Math.round(performance.now() - started),
          outcome: 'failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      )
      throw error
    } finally {
      if (scope) scope.finalizeFinished = performance.now()
    }
  }
}
