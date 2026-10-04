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

import { describe, it, expect, vi, afterEach, beforeEach, onTestFinished } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { ArkAddress } from '@arkade-os/sdk'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import * as floatOps from '@arkade-os/solver-app/ops/float.js'
import { selectCarrierInputs } from '@arkade-os/solver-app/ops/assetRfqTaxiSettle.js'
import { ASSET, SERVER, vtxoScript, xonly } from '../support/carrierFixtures.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import {
  lockupContractRegistration,
  runVtxoLifecycle,
  LOCKUP_CONTRACT_TYPE,
} from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
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

/** A real address, because a renewal decodes it to price its own output. */
const FLOAT_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

type SettleParams = { inputs: { txid: string; vout: number }[]; outputs: { address: string; amount: bigint }[] }

const floatServices = (
  migrate: () => Promise<unknown>,
  vtxos: { txid: string; vout: number }[] = [],
  expiring: unknown[] = [],
  boarding: { boarded?: unknown[]; expired?: unknown[]; settle?: (params: SettleParams) => Promise<string> } = {},
): Services =>
  ({
    arkade: {
      wallet: {
        settle: boarding.settle ?? (async () => 'settle-txid'),
        getBoardingUtxos: async () => boarding.boarded ?? [],
        // Read by resplitFloat after a renewal; empty means the float needs no reshaping.
        getSpendableVtxos: async () => [],
        getVtxoManager: async () => ({
          migrateDeprecatedSignerVtxos: migrate,
          getExpiringVtxos: async () => expiring,
          getExpiredBoardingUtxos: async () => boarding.expired ?? [],
          recoverVtxos: async () => null,
        }),
        getContractManager: async () => ({
          getContractsWithVtxos: async () =>
            vtxos.length === 0 ? [] : [{ contract: { script: 'aa', type: 'default' }, vtxos }],
        }),
        // The recovery guard's ungated read: nothing recoverable in these cases.
        getVtxos: async () => [],
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: 1_000_000n, dust: 330n }) },
        getAddress: async () => FLOAT_ADDRESS,
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

// Something to renew AND to sweep, so the contract read is reached. Honours the
// filter: the migration's own default/delegate read must survive a failing
// lockup read, or the test cannot tell the two apart.
const servicesWithLockupRead = (lockupRead: () => Promise<unknown[]>, seen: unknown[] = []): Services => {
  const due = {
    value: 500_000,
    createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  }
  const services = floatServices(async () => NO_DEPRECATED, [], [due])
  const wallet = services.arkade.wallet as unknown as Record<string, unknown>
  wallet.getVtxos = async () => [{ txid: 'a'.repeat(64), vout: 0, script: 'aa', isSwept: true }]
  const forFilter = async (filter?: { type?: string[] }): Promise<unknown[]> => {
    seen.push(filter)
    return filter?.type?.includes(LOCKUP_CONTRACT_TYPE) ? lockupRead() : []
  }
  wallet.getContractManager = async () => ({ getContracts: forFilter, getContractsWithVtxos: forFilter })
  return services
}

describe('a failing contract read costs recovery only', () => {
  it('does not throw out of the pass, and leaves renewal done', async () => {
    const report = await runFloatLifecycle(
      servicesWithLockupRead(async () => {
        throw new Error('indexer 503')
      }),
    )
    expect(report.renewed).toBe('settle-txid')
    expect(report.failures.filter((f) => f.includes('indexer 503'))).toEqual(['recover: indexer 503'])
    expect(report.recovered).toBeNull()
  })

  it('asks the repository only for lockup rows', async () => {
    const seen: unknown[] = []
    await runFloatLifecycle(servicesWithLockupRead(async () => [], seen))
    expect(seen).toContainEqual({ type: [LOCKUP_CONTRACT_TYPE] })
  })
})

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
  const SOLVER_KEY = schnorr.getPublicKey(new Uint8Array(32).fill(4))
  const SOLVER = hex.encode(SOLVER_KEY)

  const deadlinesFor = (
    rows: Record<string, unknown>[],
    contracts: Record<string, unknown>[] = [],
  ): Promise<readonly LockupDeadline[]> =>
    lockupDeadlinesOf({
      arkade: {
        identity: { xOnlyPublicKey: async () => SOLVER_KEY },
        wallet: {
          getContractManager: async () => ({
            getContracts: async (filter?: { type?: string[] }) =>
              contracts.filter((c) => filter?.type === undefined || filter.type.includes(c.type as string)),
          }),
        },
      },
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

  /** THE WEDGE: no live row, so no deadline, so a doomed batch every pass. */
  describe('a terminal row whose lockup contract is still registered', () => {
    const trader = schnorr.getPublicKey(new Uint8Array(32).fill(11))

    const lockup = (client: Uint8Array): CovenantSwapScript =>
      new CovenantSwapScript({
        receiver: schnorr.getPublicKey(new Uint8Array(32).fill(1)),
        server: schnorr.getPublicKey(new Uint8Array(32).fill(3)),
        preimageHash: ripemd160(sha256(new Uint8Array(32).fill(7))),
        refundLocktime: 1_800_000_000,
        claimDelay: 4096,
        client,
        clientRefundDelay: 6144,
        refundWithoutServerDelay: 5120,
        nonInteractiveParameters: {
          emulatorPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(9)),
          receiverPkScript: Uint8Array.from([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(13))]),
          senderPkScript: Uint8Array.from([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(5))]),
        },
      })

    // Built by the call that writes it, so the params are the stored ones.
    const registered = (script: CovenantSwapScript) => ({
      ...lockupContractRegistration(script, 'ark1test'),
      state: 'active',
      createdAt: 0,
    })

    it('names the send leg unrefundable with no live row to derive it from', async () => {
      const script = lockup(trader)
      const deadlines = await deadlinesFor([], [registered(script)])
      expect(deadlines).toEqual([
        { script: hex.encode(script.pkScript), refundLocktime: 1_800_000_000, refundable: false },
      ])
    })

    it('holds recovery back instead of attempting the doomed settlement', async () => {
      const script = lockup(trader)
      const recoverVtxos = vi.fn(async () => 'txid')
      const report = await runVtxoLifecycle({
        renewVtxos: async () => {
          throw new Error('No VTXOs available to renew')
        },
        recoverVtxos,
        recoverableVtxos: async () => [{ txid: 'a'.repeat(64), vout: 0, script: hex.encode(script.pkScript) }],
        lockupDeadlines: () => deadlinesFor([], [registered(script)]),
        nowSeconds: () => 1_900_000_000,
      })
      expect(recoverVtxos).not.toHaveBeenCalled()
      expect(report.recoverySkipped).toMatch(/no refund key of ours/)
    })

    // The SDK drops this one input itself; blocking would cost the whole batch.
    it('contributes nothing for a receive-leg lockup, even before its CLTV', async () => {
      const script = lockup(SOLVER_KEY)
      expect(await deadlinesFor([], [registered(script)])).toEqual([])
    })

    it('does not hold recovery back for a terminal receive-leg lockup pre-CLTV', async () => {
      const script = lockup(SOLVER_KEY)
      const recoverVtxos = vi.fn(async () => 'txid')
      const report = await runVtxoLifecycle({
        renewVtxos: async () => {
          throw new Error('No VTXOs available to renew')
        },
        recoverVtxos,
        recoverableVtxos: async () => [{ txid: 'a'.repeat(64), vout: 0, script: hex.encode(script.pkScript) }],
        lockupDeadlines: () => deadlinesFor([], [registered(script)]),
        nowSeconds: () => 1_700_000_000,
      })
      expect(report.recoverySkipped).toBeNull()
      expect(recoverVtxos).toHaveBeenCalledOnce()
    })

    // The over-blocking direction: this one IS ours to refund.
    it('lets a matured receive-leg lockup through', async () => {
      const script = lockup(SOLVER_KEY)
      const recoverVtxos = vi.fn(async () => 'txid')
      const report = await runVtxoLifecycle({
        renewVtxos: async () => {
          throw new Error('No VTXOs available to renew')
        },
        recoverVtxos,
        recoverableVtxos: async () => [{ txid: 'a'.repeat(64), vout: 0, script: hex.encode(script.pkScript) }],
        lockupDeadlines: () => deadlinesFor([], [registered(script)]),
        nowSeconds: () => 1_900_000_000,
      })
      expect(report.recoverySkipped).toBeNull()
      expect(recoverVtxos).toHaveBeenCalledOnce()
    })
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

  it('puts a settled renewal’s ceiling refusals in failures', async () => {
    // Off the real clock, not the migration one: renewal reads `Date.now()`.
    const due = (value: number) => ({
      value,
      createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    const report = await runFloatLifecycle(floatServices(async () => NO_DEPRECATED, [], [due(2_000_000), due(500_000)]))
    expect(report.renewed).toBe('settle-txid')
    const refusal = report.failures.filter((f) => f.includes('per-output ceiling'))
    expect(refusal).toHaveLength(1)
    expect(refusal[0]).toContain('renew:')
    expect(refusal[0]).toContain('1 expiring coin(s)')
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
 * The reservation filter on renewal — why this pass cannot simply call
 * `IVtxoManager.renewVtxos`, which selects for itself and takes no exclusion.
 */
describe('runFloatLifecycle keeps renewal off reserved coins', () => {
  const due = (txid: string, value: number) => ({
    txid,
    vout: 0,
    value,
    createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  it('leaves out a coin an in-flight funding has pinned', async () => {
    const settle = vi.fn(async (_params: SettleParams) => 'settle-txid')
    const services = floatServices(async () => NO_DEPRECATED, [], [due('pinned', 200_000), due('free', 200_000)], {
      settle,
    })
    services.arkade.reservations.reserve([{ txid: 'pinned', vout: 0 }])

    const report = await runFloatLifecycle(services)

    expect(report.renewed).toBe('settle-txid')
    const inputs = settle.mock.calls.at(-1)?.[0].inputs ?? []
    expect(inputs.map((i) => i.txid)).toEqual(['free'])
  })
})

/** Boarding: the half `settlementConfig: false` silently took away. */
describe('runFloatLifecycle boards confirmed sats', () => {
  const boarded = (value: number, txid = `b-${value}`, confirmed = true) => ({
    txid,
    vout: 0,
    value,
    status: { confirmed },
  })

  const passWith = async (boarding: Parameters<typeof floatServices>[3]) => {
    const settle = vi.fn(async (_params: SettleParams) => 'boarding-txid')
    const report = await runFloatLifecycle(floatServices(async () => NO_DEPRECATED, [], [], { ...boarding, settle }))
    return { report, settle }
  }

  it('settles them into the float and reports the txid', async () => {
    const { report, settle } = await passWith({ boarded: [boarded(200_000)] })

    expect(report.boarded).toBe('boarding-txid')
    expect(report.failures).toEqual([])
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ inputs: [{ txid: 'b-200000', vout: 0 }] })
  })

  it('lands them in the pool’s shape, not on one coin', async () => {
    const { settle } = await passWith({ boarded: [boarded(400_000)] })

    const outputs = settle.mock.calls[0]?.[0].outputs ?? []
    expect(outputs.length).toBeGreaterThan(1)
    expect(outputs.every((o) => o.address === FLOAT_ADDRESS)).toBe(true)
  })

  it('leaves an expired input to the sweep rather than settling it', async () => {
    const expired = boarded(200_000, 'gone')
    const { report, settle } = await passWith({ boarded: [expired], expired: [expired] })

    expect(report.boarded).toBeNull()
    expect(settle).not.toHaveBeenCalled()
  })

  it('leaves an unconfirmed input alone', async () => {
    const { report, settle } = await passWith({ boarded: [boarded(200_000, 'pending', false)] })

    expect(report.boarded).toBeNull()
    expect(settle).not.toHaveBeenCalled()
  })

  // Disjoint input sets — L1 boarding UTXOs versus VTXOs — so both legs settle in
  // one pass without contending for a coin.
  it('boards and renews in the same pass, each with its own settlement', async () => {
    // Distinct per leg: equal ids would let the report copy one txid into both
    // fields and still pass.
    const settle = vi.fn(async ({ inputs }: SettleParams) =>
      inputs[0]?.txid === 'b-200000' ? 'boarding-txid' : 'renewal-txid',
    )
    const due = {
      txid: 'expiring',
      vout: 0,
      value: 200_000,
      createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }
    const report = await runFloatLifecycle(
      floatServices(async () => NO_DEPRECATED, [], [due], { boarded: [boarded(200_000)], settle }),
    )

    expect(report.boarded).toBe('boarding-txid')
    expect(report.renewed).toBe('renewal-txid')
    expect(report.failures).toEqual([])
    expect(settle).toHaveBeenCalledTimes(2)
    const [first, second] = settle.mock.calls.map((c) => c[0].inputs.map((i) => i.txid))
    expect(first).toEqual(['b-200000'])
    expect(second).toEqual(['expiring'])
  })

  it('reports nothing and settles nothing when nothing is boarded', async () => {
    const { report, settle } = await passWith({})

    expect(report.boarded).toBeNull()
    expect(report.failures).toEqual([])
    expect(settle).not.toHaveBeenCalled()
  })

  // A float in trouble needs renewal and recovery most.
  it('records a refusal as a failure and still runs the rest of the pass', async () => {
    const settle = vi.fn(async (_params: SettleParams): Promise<string> => {
      throw new Error('arkd said no')
    })
    const report = await runFloatLifecycle(
      floatServices(async () => NO_DEPRECATED, [], [], { boarded: [boarded(200_000)], settle }),
    )

    expect(report.boarded).toBeNull()
    expect(report.failures.join(' ')).toContain('arkd said no')
    expect(report.recoverySkipped).toBeNull()
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
      boarded: null,
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

describe('float lifecycle shares reservation boundaries with carrier fills', () => {
  beforeEach(() => resetMigrationThrottle())
  const latch = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  const due = (seed: string) => ({
    txid: seed.repeat(64),
    vout: 0,
    value: 200_000,
    createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })

  it('reads the latest pins after awaiting expiring inventory', async () => {
    const coin = due('a')
    const entered = latch()
    const release = latch()
    const settle = vi.fn(async (_params: SettleParams) => 'renewed')
    const services = floatServices(async () => NO_DEPRECATED, [], [coin], { settle })
    const manager = await services.arkade.wallet.getVtxoManager()
    manager.getExpiringVtxos = async () => {
      entered.resolve()
      await release.promise
      return [coin] as never
    }
    services.arkade.wallet.getVtxoManager = async () => manager
    const pass = runFloatLifecycle(services)
    let unpin = () => {}
    onTestFinished(async () => {
      release.resolve()
      await pass
      unpin()
    })
    await entered.promise
    unpin = services.arkade.reservations.reserve([coin])
    release.resolve()
    expect((await pass).renewed).toBeNull()
    expect(settle).not.toHaveBeenCalled()
    expect(services.arkade.reservations.reserved()).toEqual(new Set([`${coin.txid}:0`]))
  })

  it.each(['server info', 'destination'] as const)(
    'defers the whole prepared renewal when a coin is pinned during %s',
    async (stage) => {
      const coins = [due('a'), due('b')]
      const entered = latch()
      const release = latch()
      const settle = vi.fn(async (_params: SettleParams) => 'renewed')
      const services = floatServices(async () => NO_DEPRECATED, [], coins, { settle })
      const wallet = services.arkade.wallet
      if (stage === 'server info') {
        const read = wallet.arkProvider.getInfo.bind(wallet.arkProvider)
        wallet.arkProvider.getInfo = async () => {
          entered.resolve()
          await release.promise
          return read()
        }
      } else {
        wallet.getAddress = async () => {
          entered.resolve()
          await release.promise
          return FLOAT_ADDRESS
        }
      }
      const pass = runFloatLifecycle(services)
      let unpin = () => {}
      onTestFinished(async () => {
        release.resolve()
        await pass
        unpin()
      })
      await entered.promise
      unpin = services.arkade.reservations.reserve([coins[0]!])
      release.resolve()
      const report = await pass
      expect(report.renewed).toBeNull()
      expect(report.failures).toEqual(['renew: renewal input is reserved by another operation'])
      expect(settle).not.toHaveBeenCalled()
      expect(services.arkade.reservations.reserved()).toEqual(new Set([`${coins[0]!.txid}:0`]))
      unpin()
      expect((await runFloatLifecycle(services)).renewed).toBe('renewed')
      expect(settle.mock.calls[0]![0].inputs.map((coin) => coin.txid)).toEqual(coins.map((coin) => coin.txid))
    },
  )

  it('holds every renewal input while settlement is unresolved and releases only its own pins on success', async () => {
    const script = vtxoScript(3)
    const coins = [due('a'), due('b')].map((coin) => ({
      ...coin,
      assets: [{ assetId: ASSET, amount: 500n }],
      tapTree: script.encode(),
      forfeitTapLeafScript: script.forfeit(),
      script: hex.encode(script.pkScript),
    }))
    const entered = latch()
    const release = latch()
    const settle = vi.fn(async () => {
      entered.resolve()
      await release.promise
      return 'renewed'
    })
    const services = floatServices(async () => NO_DEPRECATED, [], coins, { settle })
    const pick = () =>
      selectCarrierInputs({
        coins,
        reserved: services.arkade.reservations.reserved(),
        floor: { kind: 'time', value: BigInt(Math.floor(Date.now() / 1000) + 300) },
        dustSats: 330n,
        leg: ASSET,
        amount: 500n,
        solverKeys: [xonly(3)],
        serverKey: hex.decode(SERVER),
      })
    expect(pick()).toHaveLength(1)
    const unpinOther = services.arkade.reservations.reserve([{ txid: 'other', vout: 0 }])
    const pass = runFloatLifecycle(services)
    onTestFinished(async () => {
      release.resolve()
      await pass
      unpinOther()
    })
    await entered.promise
    expect(() => pick()).toThrow(/inventory holds 0/)
    expect(services.arkade.reservations.reserved()).toEqual(
      new Set(['other:0', ...coins.map((coin) => `${coin.txid}:0`)]),
    )
    release.resolve()
    expect((await pass).renewed).toBe('renewed')
    expect(services.arkade.reservations.reserved()).toEqual(new Set(['other:0']))
  })

  it('retains all renewal inputs when settlement rejects with an unknown outcome', async () => {
    const coins = [due('a'), due('b')]
    const settle = vi.fn(async () => {
      throw new Error('settlement response lost')
    })
    const services = floatServices(async () => NO_DEPRECATED, [], coins, { settle })
    const report = await runFloatLifecycle(services)
    expect(report.failures).toContain('renew: settlement response lost')
    expect(services.arkade.reservations.reserved()).toEqual(new Set(coins.map((coin) => `${coin.txid}:0`)))
    await runFloatLifecycle(services)
    expect(settle).toHaveBeenCalledOnce()
  })

  it('skips only migration when an actual candidate became pinned during its inventory read', async () => {
    const candidate = due('a')
    const free = due('b')
    const entered = latch()
    const release = latch()
    const migrate = vi.fn(async () => NO_DEPRECATED)
    const settle = vi.fn(async () => 'renewed')
    const services = floatServices(migrate, [candidate], [free], { settle })
    const manager = await services.arkade.wallet.getContractManager()
    const read = manager.getContractsWithVtxos.bind(manager)
    manager.getContractsWithVtxos = async (...args) => {
      entered.resolve()
      await release.promise
      return read(...args)
    }
    services.arkade.wallet.getContractManager = async () => manager
    const pass = runFloatLifecycle(services)
    let unpin = () => {}
    onTestFinished(async () => {
      release.resolve()
      await pass
      unpin()
    })
    await entered.promise
    unpin = services.arkade.reservations.reserve([candidate])
    release.resolve()
    const report = await pass
    expect(migrate).not.toHaveBeenCalled()
    expect(report.renewed).toBe('renewed')
    expect(report.failures).toEqual([])
    expect(services.arkade.reservations.reserved()).toEqual(new Set([`${candidate.txid}:0`]))
  })

  it('still migrates when reservations belong to unrelated outpoints', async () => {
    const candidate = due('a')
    const migrate = vi.fn(async () => NO_DEPRECATED)
    const services = floatServices(migrate, [candidate])
    const unpin = services.arkade.reservations.reserve([{ txid: 'other', vout: 0 }])
    onTestFinished(unpin)
    await runFloatLifecycle(services)
    expect(migrate).toHaveBeenCalledOnce()
    expect(services.arkade.reservations.reserved()).toEqual(new Set(['other:0']))
  })
})
