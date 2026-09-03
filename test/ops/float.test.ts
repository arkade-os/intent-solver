/**
 * The automatic half of float maintenance: when it spends, and when it must not.
 *
 * `maybeMintPool` is the only new decision in this change — `runFloatLifecycle`
 * is the daemon's existing pass moved behind a function, and its behaviour is
 * already covered by `test/arkade/vtxoLifecycle.test.ts`.
 *
 * Every case here is a way an automatic spender goes wrong: spending because a
 * flag was mis-read, spending when the float's shape needed nothing, or
 * overriding the guard that a human would have been asked about.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { hex } from '@scure/base'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import * as floatOps from '@arkade-os/solver-app/ops/float.js'
import type { LockupDeadline, VtxoLifecycleReport } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import {
  lockupDeadlinesOf,
  maybeMintPool,
  migrationClock,
  resetMigrationThrottle,
  runFloatLifecycle,
} from '@arkade-os/solver-app/ops/float.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '@arkade-os/solver-app/ops/corridorSet.js'

/**
 * Enough of `Services` for `poolPlan`, which is all `maybeMintPool` reaches.
 *
 * `pieces` becomes the float's coins and drives whether the plan has anything
 * to do: one fat coin needs splitting, a spread of small ones does not.
 */
const servicesWith = (pieces: number[]): Services =>
  ({
    arkade: {
      wallet: {
        getSpendableVtxos: async () => pieces.map((value) => ({ value })),
        arkProvider: { getInfo: async () => ({ dust: 330n }) },
      },
      // `poolPlan` filters the float by this process's reservations, so a split
      // cannot spend a coin an in-flight funding has already pinned. Nothing is
      // pinned in these cases: the decision under test is the float's SHAPE, and
      // contention is covered where the filter itself lives.
      reservations: { reserved: () => new Set<string>() },
    },
    config: { limits: { maxSats: 100_000 }, maxExposedSats: 1_000_000 },
  }) as unknown as Services

describe('maybeMintPool', () => {
  it('does not spend when the operator has not opted in', async () => {
    // The default. An automatic spender that ran because nobody said no is the
    // failure this flag exists to prevent.
    const mint = vi.fn()
    const outcome = await maybeMintPool(servicesWith([900_000]), { enabled: false, mint })
    expect(outcome).toEqual({ minted: false, skipped: 'disabled' })
    expect(mint).not.toHaveBeenCalled()
  })

  it('does not read the float at all when disabled', async () => {
    // Short-circuits before `poolPlan`. A disabled feature that still costs an
    // indexer round trip every cadence is a disabled feature with a bill.
    const getSpendableVtxos = vi.fn(async () => [{ value: 900_000 }])
    const services = {
      arkade: { wallet: { getSpendableVtxos, arkProvider: { getInfo: async () => ({ dust: 330n }) } } },
      config: { limits: { maxSats: 100_000 }, maxExposedSats: 1_000_000 },
    } as unknown as Services
    await maybeMintPool(services, { enabled: false, mint: vi.fn() })
    expect(getSpendableVtxos).not.toHaveBeenCalled()
  })

  it('spends when the float is one fat coin, which funds one swap at a time', async () => {
    // Funding PINS the coins it spends, so this float refuses the second
    // concurrent swap however many sats it holds. That is what minting fixes.
    const mint = vi.fn(async () => ({ minted: [100_000, 100_000] }))
    const outcome = await maybeMintPool(servicesWith([900_000]), { enabled: true, mint })
    expect(outcome.minted).toBe(true)
    expect(mint).toHaveBeenCalledOnce()
  })

  it('declines when the shape is already fine, rather than paying a fee to rearrange nothing', async () => {
    // The ordinary answer on a healthy float, and it repeats every cadence
    // forever — so it must be a skip and not a failure.
    const mint = vi.fn()
    const outcome = await maybeMintPool(servicesWith([1_000, 1_000, 1_000]), { enabled: true, mint })
    expect(outcome).toEqual({ minted: false, skipped: 'shape_is_fine' })
    expect(mint).not.toHaveBeenCalled()
  })

  it('never passes force, so the concurrent-provider guard still applies', async () => {
    // `mintPool` refuses while any corridor has a non-terminal swap, because
    // reservations are process-local and a second provider could hold them.
    // An automatic caller is precisely the one with no human to weigh that.
    const mint = vi.fn(async (_services: Services) => ({ ok: true }))
    await maybeMintPool(servicesWith([900_000]), { enabled: true, mint })
    expect(mint).toHaveBeenCalledWith(expect.anything())
    // One argument: the services. Anything else would be an options bag, and
    // the only option `mintPool` takes is `force`.
    expect(mint.mock.calls[0]).toHaveLength(1)
  })

  it('propagates a mint failure rather than reporting a skip', async () => {
    // The caller isolates this — a failed split must not end the watch loop —
    // but it has to be able to tell "declined" from "tried and broke".
    const mint = vi.fn(async () => {
      throw new Error('provider busy')
    })
    await expect(maybeMintPool(servicesWith([900_000]), { enabled: true, mint })).rejects.toThrow(/provider busy/)
  })
})

/**
 * The migration half of `runFloatLifecycle`: throttled, and counted.
 *
 * Owning `migrateDeprecatedSignerVtxos` means owning the throttle the SDK's
 * poll carried — the manual API bypasses `MIGRATION_COOLDOWN_MS` by design,
 * so an unthrottled caller re-submits an identical intent on every pass and
 * logs a failure line each time. And the migrated count must reach the
 * report: with no counter, "the cooperative path ran" and "every input
 * quietly took sweep-then-recover" are indistinguishable.
 *
 * The throttle's module state is reset between tests via a real pass at t=0,
 * which is also the simplest way to prove the first attempt is never gated.
 */
/** The four built-in stores these lifecycle cases expose, and the readers over them. */
const floatStores = {
  store: { findRecoverable: async () => [] },
  onchainStore: { findRecoverable: async () => [] },
  receiveStore: { findRecoverable: async () => [] },
  onchainReceiveStore: { findRecoverable: async () => [] },
}

const floatServices = (migrate: () => Promise<unknown>, vtxos: { txid: string; vout: number }[] = []): Services =>
  ({
    arkade: {
      wallet: {
        getVtxoManager: async () => ({
          migrateDeprecatedSignerVtxos: migrate,
          getExpiringVtxos: async () => [],
          recoverVtxos: async () => null,
        }),
        getContractManager: async () => ({
          getContractsWithVtxos: async () =>
            vtxos.length === 0 ? [] : [{ contract: { script: 'aa', type: 'default' }, vtxos }],
        }),
        // The recovery guard's ungated read: nothing recoverable in these cases.
        getVtxos: async () => [],
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: 1_000_000n, dust: 330n }) },
        getAddress: async () => 'ark1test',
      },
      reservations: createReservationLedger(),
      // The recovery guard asks whether a lockup's `client` key is ours before
      // it lets one into an all-or-nothing sweep. No lockups in these cases, so
      // the key never matches anything — it just has to be readable.
      identity: { xOnlyPublicKey: async () => new Uint8Array(32).fill(4) },
    },
    ...floatStores,
    // `liveLockupRows` reads this, not the stores directly.
    readers: readerSetFromDeps(floatStores as unknown as FlatCorridorDeps),
    config: { limits: { maxSats: 100_000 }, maxExposedSats: 1_000_000 },
  }) as unknown as Services

const NO_DEPRECATED = { rotated: false, expired: [], signers: [], skipped: 'no-deprecated-vtxos' }

/**
 * The role half of the recovery guard, derived where the deadlines are.
 *
 * `refundWithoutReceiver` is the only leaf `VHTLCV2ContractHandler` stamps onto
 * a `vhtlc-v2` VTXO, and it needs the lockup's `sender` — which `covenant.ts`
 * fills from the row's `client` key. So "can recovery spend this at all" is
 * exactly "is that key ours", and a send leg's answer is no at every clock
 * reading, not merely before the CLTV.
 */
describe('lockupDeadlinesOf', () => {
  const SOLVER = hex.encode(new Uint8Array(32).fill(4))

  const deadlinesFor = (rows: Record<string, unknown>[]): Promise<readonly LockupDeadline[]> =>
    lockupDeadlinesOf({
      arkade: { identity: { xOnlyPublicKey: async () => new Uint8Array(32).fill(4) } },
      readers: readerSetFromDeps({
        store: { findRecoverable: async () => rows },
        onchainStore: { findRecoverable: async () => [] },
        receiveStore: { findRecoverable: async () => [] },
        onchainReceiveStore: { findRecoverable: async () => [] },
      } as unknown as FlatCorridorDeps),
    } as unknown as Services)

  const sendRow = (clientRefundPubkey: string | null): Record<string, unknown> => ({
    id: 'send-1',
    receiverPubkey: SOLVER,
    serverPubkey: 'server',
    paymentHash: 'a'.repeat(64),
    refundLocktime: 1_800_000_000,
    claimDelay: 512,
    emulatorPubkey: 'emulator',
    refundPkScript: 'refund-pkscript',
    pkScript: 'send-pkscript',
    clientRefundPubkey,
    refundWithoutReceiverDelay: 1024,
    refundDelay: 2048,
    receiverPkScript: 'send-receiver-pkscript',
    nonInteractiveParameters: null,
  })

  it('marks a send-leg lockup unrefundable: the solver is receiver, not sender', async () => {
    const [deadline] = await deadlinesFor([sendRow('the-traders-refund-key')])
    expect(deadline).toMatchObject({ script: 'send-pkscript', refundable: false })
  })

  it('marks a lockup whose client key is the solver refundable — the receive-leg shape', async () => {
    const [deadline] = await deadlinesFor([sendRow(SOLVER)])
    expect(deadline).toMatchObject({ script: 'send-pkscript', refundable: true })
  })

  /**
   * No client key at all predates that leaf; `covenantScriptFromRow` refuses to
   * rebuild such a row, so it is never registered and never in the sweep set.
   * Answering `false` would invent a refusal about a lockup the guard cannot
   * see — `undefined` leaves the CLTV question to decide, as it always did.
   */
  it('has no opinion on a row carrying no client refund key', async () => {
    const [deadline] = await deadlinesFor([sendRow(null)])
    expect(deadline?.refundable).toBeUndefined()
  })
})

describe('runFloatLifecycle — migration throttle and count', () => {
  let now: number
  beforeEach(() => {
    now = 1_800_000_000_000
    migrationClock.nowMs = () => now
    resetMigrationThrottle()
  })
  afterEach(() => {
    migrationClock.nowMs = () => Date.now()
  })

  it('reports what a pass migrated', async () => {
    const sdkReport = { ...NO_DEPRECATED, skipped: undefined, vtxos: { migrated: [{}, {}] } }
    const report = await runFloatLifecycle(floatServices(async () => sdkReport))
    expect(report.migrated).toBe(2)
    expect(report.failures).toEqual([])
  })

  it('does not re-submit an identical intent on the very next pass', async () => {
    const migrate = vi.fn(async () => NO_DEPRECATED)
    const services = floatServices(migrate)
    await runFloatLifecycle(services)
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(1)
    // ...but a later pass, past the cooldown, tries again.
    now += 31_000
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially on a persistent refusal instead of logging one line per pass', async () => {
    const migrate = vi.fn(async () => {
      throw new Error('arkd not accepting old-key inputs')
    })
    const services = floatServices(migrate)
    const first = await runFloatLifecycle(services)
    expect(first.failures.join(' ')).toContain('arkd not accepting old-key inputs')
    // A failure backs off 30s * 2^1 = 60s: passes inside the window submit
    // nothing and — the log-spam half of the finding — report nothing.
    now += 31_000
    const second = await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(1)
    expect(second.failures).toEqual([])
    now += 31_000
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(2)
    // And the backoff grows: a third attempt is not due 60s after the second.
    now += 61_000
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(2)
  })

  it('a successful pass resets the backoff', async () => {
    let fail = true
    const migrate = vi.fn(async () => {
      if (fail) throw new Error('down')
      return NO_DEPRECATED
    })
    const services = floatServices(migrate)
    await runFloatLifecycle(services)
    now += 61_000
    fail = false
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(2)
    // Back at the base cooldown: 31s later is due again.
    now += 31_000
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledTimes(3)
  })

  /**
   * The migration selects from the wallet's default/delegate contracts with no
   * knowledge of the reservation ledger — the same ledger renewal consults
   * eleven lines later — so a receive-leg funding holding a coin under a
   * deprecated signer raced the migration for it, and the funding could be the
   * leg arkd failed. `MigrateDeprecatedSignerOptions` has no filter hook, so
   * the candidates are pinned from THIS side for the duration of the call.
   */
  it('holds the migration candidates under reservation while it runs', async () => {
    const coin = { txid: 'aa', vout: 0 }
    const services = floatServices(async () => NO_DEPRECATED, [coin])
    let observed: ReadonlySet<string> = new Set()
    services.arkade.wallet.getVtxoManager = async () =>
      ({
        migrateDeprecatedSignerVtxos: async () => {
          observed = services.arkade.reservations.reserved()
          return NO_DEPRECATED
        },
        getExpiringVtxos: async () => [],
        recoverVtxos: async () => null,
      }) as never
    await runFloatLifecycle(services)
    expect(observed.has('aa:0')).toBe(true)
    // Released after: a reservation that outlived the pass would shrink the
    // spendable float forever.
    expect(services.arkade.reservations.reserved().size).toBe(0)
  })

  it('releases the reservation when the migration throws', async () => {
    const services = floatServices(async () => {
      throw new Error('down')
    }, [{ txid: 'aa', vout: 0 }])
    await runFloatLifecycle(services)
    expect(services.arkade.reservations.reserved().size).toBe(0)
  })
})

/**
 * The `float-lifecycle` action's own verdict.
 *
 * `runFloatLifecycle` never throws — the report was built for a watch loop that
 * must not die — so the route answers HTTP 200 even when renewal AND recovery
 * both failed. A 200 read on its own then says the opposite of what happened.
 * These pin the verdict the action adds so a renderer, and the audit row's
 * `detail`, both see it without knowing what a `VtxoLifecycleReport` is.
 *
 * Exercised through `ACTIONS` rather than a copy of the mapping, so a change to
 * the action cannot leave this passing.
 */
describe('the float-lifecycle action reports what actually happened', () => {
  const definition = ACTIONS['float-lifecycle']

  const runWith = async (report: Partial<VtxoLifecycleReport>): Promise<Record<string, unknown>> => {
    const full: VtxoLifecycleReport = {
      renewed: null,
      resplit: null,
      recovered: null,
      recoverySkipped: null,
      migrated: 0,
      failures: [],
      ...report,
    }
    vi.spyOn(floatOps, 'runFloatLifecycle').mockResolvedValue(full)
    return (await definition!.run({} as never, {})) as Record<string, unknown>
  }

  afterEach(() => vi.restoreAllMocks())

  it('is armed, so it cannot be clicked without deliberation', () => {
    expect(definition?.tier).toBe('armed')
  })

  it('reports ok and settled when a renewal landed', async () => {
    const result = await runWith({ renewed: 'txid-1' })
    expect(result.ok).toBe(true)
    expect(result.settled).toBe(true)
  })

  it('reports NOT ok when a step failed, even though nothing threw', async () => {
    // The case the verdict exists for: HTTP 200 with both halves broken.
    const result = await runWith({ failures: ['recoverVtxos: INTENT_INSUFFICIENT_FEE'] })
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(['recoverVtxos: INTENT_INSUFFICIENT_FEE'])
  })

  it('is ok but NOT settled when recovery was deliberately held back', async () => {
    // The guard declining is neither a failure nor a settlement — an operator
    // reading `settled: false` should not go looking for a broken wallet.
    const result = await runWith({ recoverySkipped: 'a lockup is still short of its refund deadline' })
    expect(result.ok).toBe(true)
    expect(result.settled).toBe(false)
    expect(result.recoverySkipped).toBeTruthy()
  })

  it('is ok and not settled on a pass with nothing to do', async () => {
    const result = await runWith({})
    expect(result.ok).toBe(true)
    expect(result.settled).toBe(false)
  })
})
