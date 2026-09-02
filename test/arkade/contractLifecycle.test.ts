import { readerSetFromDeps, type FlatCorridorDeps } from '@arkade-os/solver-app/ops/corridorSet.js'
import { describe, expect, it } from 'vitest'
import {
  lockupSource,
  planContractLifecycle,
  runContractLifecycle,
  type CorridorSource,
  type KnownContract,
  type LiveContract,
} from '@arkade-os/solver-arkade/arkade/contractLifecycle.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const opts = { now: NOW, retentionMs: 30 * DAY }

const live = (script: string): LiveContract => ({
  script,
  registration: { type: 'vhtlc-v2', params: {}, script, address: `ark1${script}`, label: 'x', metadata: {} } as never,
  refundLocktime: 1_800_000_000,
})

const known = (script: string, over: Partial<KnownContract> = {}): KnownContract => ({
  script,
  retained: false,
  retiredAt: null,
  funded: false,
  ...over,
})

describe('planContractLifecycle', () => {
  it('registers a live contract that is not yet known', () => {
    const plan = planContractLifecycle([live('aa')], [], opts)
    expect(plan.register.map((c) => c.script)).toEqual(['aa'])
    expect(plan.disable).toEqual([])
    expect(plan.delete).toEqual([])
  })

  it('does not re-register a contract already known', () => {
    const plan = planContractLifecycle([live('aa')], [known('aa')], opts)
    expect(plan.register).toEqual([])
  })

  it('skips a contract whose registration no handler can express', () => {
    const plan = planContractLifecycle([{ script: 'bb', registration: null, refundLocktime: 1 }], [], opts)
    expect(plan.register).toEqual([])
  })

  it('disables a known contract once it is neither live nor funded', () => {
    const plan = planContractLifecycle([], [known('aa')], opts)
    expect(plan.disable).toEqual(['aa'])
    expect(plan.delete).toEqual([])
  })

  // The safety gate both stages share. Spec D2.
  it('refuses to disable while the script still holds an unspent output', () => {
    const plan = planContractLifecycle([], [known('aa', { funded: true })], opts)
    expect(plan.disable).toEqual([])
    expect(plan.delete).toEqual([])
  })

  it('never touches something still live', () => {
    const plan = planContractLifecycle([live('aa')], [known('aa')], opts)
    expect(plan.disable).toEqual([])
    expect(plan.delete).toEqual([])
  })

  it('does not re-disable a contract already retained', () => {
    const plan = planContractLifecycle([], [known('aa', { retained: true, retiredAt: NOW })], opts)
    expect(plan.disable).toEqual([])
  })

  it('deletes a retained contract once the retention window has elapsed', () => {
    const plan = planContractLifecycle([], [known('aa', { retained: true, retiredAt: NOW - 31 * DAY })], opts)
    expect(plan.delete).toEqual(['aa'])
  })

  it('keeps a retained contract until the window elapses', () => {
    const plan = planContractLifecycle([], [known('aa', { retained: true, retiredAt: NOW - 29 * DAY })], opts)
    expect(plan.delete).toEqual([])
  })

  // A row funded again after being retained must never be deleted out from
  // under the outputs sitting at it.
  it('refuses to delete a retained contract that has been funded again', () => {
    const row = known('aa', { retained: true, retiredAt: NOW - 31 * DAY, funded: true })
    const plan = planContractLifecycle([], [row], opts)
    expect(plan.delete).toEqual([])
  })

  // Rows written before `retiredAt` existed must not be deleted on a guess.
  it('never deletes a retained contract with no recorded retirement time', () => {
    const plan = planContractLifecycle([], [known('aa', { retained: true, retiredAt: null })], opts)
    expect(plan.delete).toEqual([])
    expect(plan.disable).toEqual(['aa'])
  })
})

/**
 * A row from before the client-unilateral refund leaf. `covenantScriptFromRow`
 * refuses these outright since #202 deleted the base three-leaf script, so this
 * is what a source has to survive rather than a hypothetical.
 */
const legacyRow = (id: string) => ({
  id,
  receiverPubkey: `02${'0'.repeat(64)}`,
  serverPubkey: `02${'1'.repeat(64)}`,
  paymentHash: 'ab'.repeat(20),
  refundLocktime: 1_800_000_000,
  claimDelay: 1024,
  emulatorPubkey: `02${'2'.repeat(64)}`,
  refundPkScript: `5120${'00'.repeat(32)}`,
  pkScript: `5120${'11'.repeat(32)}`,
  clientRefundPubkey: null,
  refundWithoutReceiverDelay: 2048,
  refundDelay: 4096,
  receiverPkScript: null,
  nonInteractiveParameters: null,
  providerPubkey: `02${'3'.repeat(64)}`,
})

const stores = (over: Record<string, unknown> = {}) => ({
  store: { findRecoverable: async () => [] },
  onchainStore: { findRecoverable: async () => [] },
  receiveStore: { findRecoverable: async () => [] },
  onchainReceiveStore: { findRecoverable: async () => [] },
  ...over,
})

describe('lockupSource', () => {
  // Guards the exact regression `liveLockupRows` was written for: a source that
  // reads only the SEND stores looks identical in every other test.
  it('reads all four corridor stores', async () => {
    const calls: string[] = []
    const spy = (name: string) => ({
      findRecoverable: async () => {
        calls.push(name)
        return []
      },
    })
    const source = lockupSource(
      readerSetFromDeps({
        store: spy('store'),
        onchainStore: spy('onchainStore'),
        receiveStore: spy('receiveStore'),
        onchainReceiveStore: spy('onchainReceiveStore'),
      } as unknown as FlatCorridorDeps),
      'ark',
      new Uint8Array(32),
    )
    await source.live()
    expect(calls.sort()).toEqual(['onchainReceiveStore', 'onchainStore', 'receiveStore', 'store'])
  })

  it('is empty when no corridor holds a lockup', async () => {
    const source = lockupSource(readerSetFromDeps(stores() as unknown as FlatCorridorDeps), 'ark', new Uint8Array(32))
    expect(await source.live()).toEqual([])
  })

  /**
   * The interaction with #202 that makes this isolation load-bearing rather
   * than tidy: `runContractLifecycle` treats a THROWING source as an incomplete
   * live set and suppresses retirement for the whole pass. Without the per-row
   * catch, one un-rebuildable legacy row would freeze retirement permanently.
   */
  it('skips a row it cannot rebuild instead of taking the whole source down', async () => {
    const logged: string[] = []
    const source = lockupSource(
      readerSetFromDeps(
        stores({ store: { findRecoverable: async () => [legacyRow('legacy-1')] } }) as unknown as FlatCorridorDeps,
      ),
      'ark',
      new Uint8Array(32),
      (line) => logged.push(line),
    )
    await expect(source.live()).resolves.toEqual([])
    expect(logged.join(' ')).toContain('legacy-1')
  })

  it('stays quiet when there is nothing to skip', async () => {
    const logged: string[] = []
    const source = lockupSource(
      readerSetFromDeps(stores() as unknown as FlatCorridorDeps),
      'ark',
      new Uint8Array(32),
      (line) => logged.push(line),
    )
    await source.live()
    expect(logged).toEqual([])
  })
})

/**
 * The manager mock's rows are owned lockups BY DEFAULT, because the engine now
 * retires only what a source claims. `kind` mirrors what
 * `lockupContractRegistration` writes; `wallet` names a wallet-owned row
 * (`default`/`delegate`/`boarding`: no `kind`, a different `type`), which no
 * source may claim.
 *
 * VTXOs carry real spend facts — bare `{}` is what let the funded gate count
 * spent outputs as funding without any test noticing.
 */
const manager = (
  rows: {
    script: string
    watch?: string
    retiredAt?: number
    vtxos?: { isSpent?: boolean; spentBy?: string; settledBy?: string; isSwept?: boolean }[]
    wallet?: boolean
  }[] = [],
) => {
  const created: string[] = []
  const updated: { script: string; watch?: string; metadata?: Record<string, unknown> }[] = []
  const deleted: string[] = []
  return {
    created,
    updated,
    deleted,
    createContract: async (p: { script: string }) => void created.push(p.script),
    deleteContract: async (s: string) => void deleted.push(s),
    updateContract: async (s: string, u: { watch?: string; metadata?: Record<string, unknown> }) =>
      void updated.push({ script: s, watch: u.watch, metadata: u.metadata }),
    getContractsWithVtxos: async () =>
      rows.map((r) => ({
        contract: r.wallet
          ? { script: r.script, type: 'default', watch: r.watch ?? 'watched', metadata: {} }
          : {
              script: r.script,
              type: 'vhtlc-v2',
              watch: r.watch ?? 'watched',
              metadata: { kind: 'lnswap-lockup', retiredAt: r.retiredAt },
            },
        vtxos: r.vtxos ?? [],
      })),
  }
}

/** A lockup row holding one unspent output. */
const funded = { vtxos: [{}] }
/** A lockup row whose only output is spent — the settled-swap case. */
const spent = { vtxos: [{ isSpent: true, spentBy: 'txid' }] }
/** A lockup row whose only output was batch-swept: gone, but recovery is not done with it. */
const swept = { vtxos: [{ isSwept: true }] }

const OWNING: Pick<CorridorSource, 'owns'> = {
  owns: (row) => row.metadata?.kind === 'lnswap-lockup' || row.type === 'vhtlc-v2',
}

const src = (contracts: LiveContract[]): CorridorSource => ({ name: 'test', live: async () => contracts, ...OWNING })
const engineDeps = (m: ReturnType<typeof manager>, sources: CorridorSource[]) => ({
  manager: m as never,
  sources,
  now: () => NOW,
  retentionMs: 30 * DAY,
  log: (() => {}) as (line: string) => void,
})

describe('runContractLifecycle', () => {
  it('registers new contracts and returns every live deadline', async () => {
    const m = manager()
    const deadlines = await runContractLifecycle(engineDeps(m, [src([live('aa')])]))
    expect(m.created).toEqual(['aa'])
    expect(deadlines).toEqual([{ script: 'aa', refundLocktime: 1_800_000_000 }])
  })

  it('disables a contract that is no longer live, stamping when', async () => {
    const m = manager([{ script: 'aa' }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.updated).toEqual([
      { script: 'aa', watch: 'retained', metadata: { kind: 'lnswap-lockup', retiredAt: NOW } },
    ])
    expect(m.deleted).toEqual([])
  })

  it('deletes only once the window has elapsed', async () => {
    const m = manager([{ script: 'aa', watch: 'retained', retiredAt: NOW - 31 * DAY }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.deleted).toEqual(['aa'])
  })

  // The whole point of the spec's D2 gate.
  it('leaves a dead contract alone while its script still holds an output', async () => {
    const m = manager([{ script: 'aa', watch: 'retained', retiredAt: NOW - 31 * DAY, ...funded }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.deleted).toEqual([])
    expect(m.updated).toEqual([])
  })

  /**
   * The funded gate counts UNSPENT outputs only. The repository keeps spent
   * rows forever — nothing prunes them — so counting them leaves every settled
   * lockup permanently funded and neither retirement stage ever fires, which
   * is the precise set this engine exists to retire.
   */
  it('retires a contract whose only outputs are spent', async () => {
    const m = manager([{ script: 'aa', ...spent }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.updated).toEqual([
      { script: 'aa', watch: 'retained', metadata: { kind: 'lnswap-lockup', retiredAt: NOW } },
    ])
  })

  it('deletes a spent contract once the window has elapsed', async () => {
    const m = manager([{ script: 'aa', watch: 'retained', retiredAt: NOW - 31 * DAY, ...spent }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.deleted).toEqual(['aa'])
  })

  // A swept output is deliberately NOT a terminal spend: the batch took it,
  // but the recovery path is not done with it, so the contract stays funded
  // and protected until recovery drains it.
  it('keeps a swept-but-not-spent contract funded', async () => {
    const m = manager([{ script: 'aa', watch: 'retained', retiredAt: NOW - 31 * DAY, ...swept }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.deleted).toEqual([])
    expect(m.updated).toEqual([])
  })

  // Restart safety: state comes from the rows, so a fresh process still retires.
  it('retires a row it never registered itself', async () => {
    const m = manager([{ script: 'zz' }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.updated.map((u) => u.script)).toEqual(['zz'])
  })

  // Per-row isolation: one bad row must not stop the pass, because the pass is
  // what feeds the recovery guard.
  it('keeps going when one registration throws', async () => {
    const m = manager()
    m.createContract = async (p: { script: string }) => {
      if (p.script === 'aa') throw new Error('nope')
      m.created.push(p.script)
    }
    const logged: string[] = []
    const deadlines = await runContractLifecycle({
      ...engineDeps(m, [src([live('aa'), live('bb')])]),
      log: (l: string) => logged.push(l),
    })
    expect(m.created).toEqual(['bb'])
    expect(logged.join(' ')).toContain('aa')
    expect(deadlines.map((d) => d.script)).toEqual(['aa', 'bb'])
  })

  it('survives a source that throws, using the corridors that answered', async () => {
    const m = manager()
    const broken: CorridorSource = {
      name: 'broken',
      live: async () => {
        throw new Error('down')
      },
      ...OWNING,
    }
    const logged: string[] = []
    const deadlines = await runContractLifecycle({
      ...engineDeps(m, [broken, src([live('bb')])]),
      log: (l: string) => logged.push(l),
    })
    expect(deadlines.map((d) => d.script)).toEqual(['bb'])
    expect(logged.join(' ')).toContain('broken')
  })

  /**
   * A partial live set can say what EXISTS but never what is GONE. A corridor
   * that failed to answer has not said its contracts are dead, so a failed
   * source must suppress retirement for the whole pass — otherwise one flaky
   * store read retires three other corridors' live contracts.
   */
  it('retires nothing at all when any source failed', async () => {
    const m = manager([{ script: 'aa' }])
    const broken: CorridorSource = {
      name: 'broken',
      live: async () => {
        throw new Error('down')
      },
      ...OWNING,
    }
    await runContractLifecycle({ ...engineDeps(m, [broken, src([])]), log: () => {} })
    expect(m.updated).toEqual([])
    expect(m.deleted).toEqual([])
  })

  /**
   * The unfiltered snapshot also carries the wallet's OWN contracts —
   * `default` and `delegate` per signer and `boarding` per signer. None can
   * appear in a corridor's live set, so an unfunded one looked retirable:
   * disabled on the first pass and deleted after the window, out from under
   * `pickActiveReceive`. Ownership by claim, not denylist.
   */
  it('never retires a wallet-owned contract, however empty', async () => {
    const m = manager([
      { script: 'wallet-default', wallet: true },
      { script: 'wallet-boarding', wallet: true },
      { script: 'aa' },
    ])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.updated).toEqual([
      { script: 'aa', watch: 'retained', metadata: { kind: 'lnswap-lockup', retiredAt: NOW } },
    ])
    expect(m.deleted).toEqual([])
  })

  it('never deletes a wallet-owned contract past the window', async () => {
    const m = manager([{ script: 'wallet-default', wallet: true, watch: 'retained', retiredAt: NOW - 31 * DAY }])
    await runContractLifecycle(engineDeps(m, [src([])]))
    expect(m.deleted).toEqual([])
  })

  // Rows written before the `kind` metadata existed are still this corridor's:
  // the `type` arm of the ownership predicate claims them.
  it('claims a lockup row that predates the kind metadata', async () => {
    const m = manager()
    const legacy = { script: 'aa', type: 'vhtlc-v2', watch: 'watched', metadata: {} }
    m.getContractsWithVtxos = async () => [{ contract: legacy, vtxos: [] }]
    await runContractLifecycle(engineDeps(m, [src([])]))
    // Nothing to preserve on a row that predates `kind`: the stamp is all the metadata it gets.
    expect(m.updated).toEqual([{ script: 'aa', watch: 'retained', metadata: { retiredAt: NOW } }])
  })

  /**
   * The snapshot read is the one manager call that cannot be per-row isolated,
   * and `ContractManager.getContractsWithVtxos` rethrows what
   * `isRetryableProviderError` rejects. Letting that escape the engine lands it
   * in the watch loop's `try` — the same one `runFloatLifecycle` sits in — so
   * one bad indexer answer would cost a full cadence of renewal and recovery.
   * An unreadable repository instead reads as "retire nothing this pass", the
   * same posture a throwing source gets.
   */
  it('registers the live set and retires nothing when the snapshot is unreadable', async () => {
    const m = manager()
    m.getContractsWithVtxos = async () => {
      throw new Error('indexer 500')
    }
    const logged: string[] = []
    const deadlines = await runContractLifecycle({
      ...engineDeps(m, [src([live('bb')])]),
      log: (l: string) => logged.push(l),
    })
    expect(m.created).toEqual(['bb'])
    expect(m.updated).toEqual([])
    expect(m.deleted).toEqual([])
    expect(logged.join(' ')).toContain('indexer 500')
    expect(deadlines.map((d) => d.script)).toEqual(['bb'])
  })
})
