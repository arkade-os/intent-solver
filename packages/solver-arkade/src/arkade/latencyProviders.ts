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

const span = (from: number | undefined, to: number | undefined): number | undefined =>
  from === undefined || to === undefined ? undefined : Math.round(to - from)

export const sendPhaseTimings = (scope: ProviderTimingScope, started: number, finished: number) => ({
  beforeSubmitMs: span(started, scope.submitStarted),
  submitMs: span(scope.submitStarted, scope.submitFinished),
  checkpointMs: span(scope.submitFinished, scope.finalizeStarted),
  finalizeMs: span(scope.finalizeStarted, scope.finalizeFinished),
  afterFinalizeMs: span(scope.finalizeFinished, finished),
})

const timed = async <T>(
  event: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>,
  okFields: (result: T) => Record<string, unknown> = () => ({}),
): Promise<T> => {
  const started = performance.now()
  try {
    const result = await run()
    log(event, json({ ...fields, ...okFields(result), ms: Math.round(performance.now() - started), outcome: 'ok' }))
    return result
  } catch (error) {
    log(
      event,
      json({
        ...fields,
        ms: Math.round(performance.now() - started),
        outcome: 'failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      }),
    )
    throw error
  }
}

export class TimedIndexerProvider extends RestIndexerProvider {
  override async getVtxos(options?: Parameters<RestIndexerProvider['getVtxos']>[0]) {
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
    return timed(
      'indexer_vtxos_timing',
      request,
      () => super.getVtxos(options),
      (result) => ({ rows: result.vtxos.length }),
    )
  }
}

export class TimedArkProvider extends RestArkProvider {
  override async submitTx(...args: Parameters<RestArkProvider['submitTx']>) {
    const scope = timingScope.getStore()
    if (scope) scope.submitStarted = performance.now()
    try {
      return await timed('ark_submit_timing', { fundRef: scope?.fundRef }, () => super.submitTx(...args))
    } finally {
      if (scope) scope.submitFinished = performance.now()
    }
  }

  override async finalizeTx(...args: Parameters<RestArkProvider['finalizeTx']>) {
    const scope = timingScope.getStore()
    if (scope) scope.finalizeStarted = performance.now()
    try {
      return await timed('ark_finalize_timing', { fundRef: scope?.fundRef }, () => super.finalizeTx(...args))
    } finally {
      if (scope) scope.finalizeFinished = performance.now()
    }
  }
}
