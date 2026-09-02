import { readerSetFromDeps, type FlatCorridorDeps } from '../../src/ops/corridorSet.js'
import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { VHTLCV2ContractHandler } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import {
  liveLockupRows,
  LOCKUP_CONTRACT_TYPE,
  LOCKUP_RECOVERY_MTP_MARGIN_SECONDS,
  lockupContractRegistration,
  renewExpiringVtxos,
  renewalThresholdMs,
  isRenewalDue,
  RENEWAL_THRESHOLD_MS,
  runVtxoLifecycle,
  type LifecycleVtxo,
  type LockupDeadline,
  type RenewableVtxo,
  type RenewalPolicy,
  type RenewVtxoDeps,
  type VtxoLifecycleDeps,
} from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import type { SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import type { OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { OnchainReceiveSwapRow } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const RECEIVER = key(1)
const SERVER = key(2)
const CLIENT = key(3)
const EMULATOR = key(9)
const P2TR = (fill: number): Uint8Array => Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(fill)])

/** Unix seconds, comfortably past LOCKTIME_THRESHOLD so it reads as a timestamp. */
const REFUND_LOCKTIME = 1_800_000_000

const extendedScript = (refundLocktime = REFUND_LOCKTIME): CovenantSwapScript =>
  new CovenantSwapScript({
    receiver: RECEIVER,
    server: SERVER,
    preimageHash: new Uint8Array(20).fill(7),
    refundLocktime,
    claimDelay: 512,
    client: CLIENT,
    clientRefundDelay: 1024,
    refundWithoutServerDelay: 2048,
    nonInteractiveParameters: {
      emulatorPubkey: EMULATOR,
      receiverPkScript: P2TR(9),
      senderPkScript: P2TR(8),
    },
  })

const baseScript = (): CovenantSwapScript =>
  new CovenantSwapScript({
    receiver: RECEIVER,
    server: SERVER,
    preimageHash: new Uint8Array(20).fill(7),
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: 512,
    client: CLIENT,
    clientRefundDelay: 1024,
    refundWithoutServerDelay: 2048,
    nonInteractiveParameters: {
      emulatorPubkey: EMULATOR,
      receiverPkScript: P2TR(9),
      senderPkScript: P2TR(8),
    },
  })

interface Calls {
  renew: number
  recover: number
}

const deps = (overrides: Partial<VtxoLifecycleDeps> = {}): { deps: VtxoLifecycleDeps; calls: Calls } => {
  const calls: Calls = { renew: 0, recover: 0 }
  const built: VtxoLifecycleDeps = {
    renewVtxos: async () => {
      calls.renew += 1
      return 'renew-txid'
    },
    recoverVtxos: async () => {
      calls.recover += 1
      return 'recover-txid'
    },
    recoverableVtxos: async () => [],
    lockupDeadlines: async () => [],
    nowSeconds: () => REFUND_LOCKTIME - 1,
    ...overrides,
  }
  return { deps: built, calls }
}

const vtxo = (script: string, vout = 0): LifecycleVtxo => ({ txid: 'a'.repeat(64), vout, script })

describe('lockupContractRegistration', () => {
  it('registers an extended lockup as vhtlc-v2', () => {
    const script = extendedScript()
    const registration = lockupContractRegistration(script, 'ark1address')
    expect(registration).not.toBeNull()
    expect(registration!.type).toBe(LOCKUP_CONTRACT_TYPE)
    expect(registration!.script).toBe(hex.encode(script.pkScript))
    expect(registration!.address).toBe('ark1address')
  })

  it('marks the lockup as not generically spendable', () => {
    const registration = lockupContractRegistration(extendedScript(), 'ark1address')
    expect(registration!.metadata).toMatchObject({ genericallySpendable: false })
  })

  /**
   * The whole point of registering: `upsertContractRow` re-derives the script
   * from the serialized params and REFUSES any row whose supplied script does
   * not match. This runs that exact round trip through the real handler, so a
   * params drift fails here rather than at the first live registration.
   */
  it('round-trips through the real handler to the same pkScript', () => {
    const script = extendedScript()
    const registration = lockupContractRegistration(script, 'ark1address')
    const rebuilt = VHTLCV2ContractHandler.createScript(registration!.params)
    expect(hex.encode(rebuilt.pkScript)).toBe(hex.encode(script.pkScript))
  })
})

describe('liveLockupRows', () => {
  /**
   * The regression this guards. `registerLiveLockups` (`cli.ts`) used to build
   * its row set from only TWO of the four corridor stores — `store` and
   * `onchainStore`, the SEND corridors where the CLIENT locks up the funds
   * (`src/core/send.ts`). The two RECEIVE corridors — `receiveStore` and
   * `onchainReceiveStore`, where the SOLVER funds the lockup itself
   * (`src/core/receive.ts`: "we fund the Arkade side") — were never read at
   * all, so the solver's own escrow never got the `isGenericallySpendable:
   * false` renewal gate or a recovery path.
   *
   * Each fake store below counts its own calls, which is the whole reason
   * this function takes stores rather than four pre-fetched arrays: a
   * corridor silently dropped from the implementation shows up here as a
   * store that was never read, not merely as a row that happens to be
   * missing from the output.
   */
  it('reads all four corridor stores and maps each one through its own mapper', async () => {
    const calls = { store: 0, onchainStore: 0, receiveStore: 0, onchainReceiveStore: 0 }

    const deps = {
      store: {
        findRecoverable: async () => {
          calls.store += 1
          return [
            {
              id: 'send-1',
              receiverPubkey: 'send-receiver',
              serverPubkey: 'server',
              paymentHash: 'a'.repeat(64),
              refundLocktime: REFUND_LOCKTIME,
              claimDelay: 512,
              emulatorPubkey: 'emulator',
              refundPkScript: 'refund-pkscript',
              pkScript: 'send-pkscript',
              clientRefundPubkey: 'send-client-refund',
              refundWithoutReceiverDelay: 1024,
              refundDelay: 2048,
              receiverPkScript: 'send-receiver-pkscript',
              nonInteractiveParameters: null,
            } as unknown as SendSwapRow,
          ]
        },
      },
      onchainStore: {
        findRecoverable: async () => {
          calls.onchainStore += 1
          return [
            {
              id: 'onchain-send-1',
              providerPubkey: 'onchain-send-receiver',
              serverPubkey: 'server',
              paymentHash: 'b'.repeat(64),
              refundLocktime: REFUND_LOCKTIME,
              claimDelay: 512,
              emulatorPubkey: 'emulator',
              refundPkScript: 'refund-pkscript',
              pkScript: 'onchain-send-pkscript',
              clientRefundPubkey: 'onchain-send-client-refund',
              refundWithoutReceiverDelay: 1024,
              refundDelay: 2048,
              receiverPkScript: 'onchain-send-receiver-pkscript',
              nonInteractiveParameters: null,
            } as unknown as OnchainSendSwapRow,
          ]
        },
      },
      receiveStore: {
        findRecoverable: async () => {
          calls.receiveStore += 1
          return [
            {
              id: 'receive-1',
              payoutPubkey: 'receive-payout',
              serverPubkey: 'server',
              paymentHash: 'c'.repeat(64),
              refundLocktime: REFUND_LOCKTIME,
              claimDelay: 512,
              emulatorPubkey: 'emulator',
              solverRefundPkScript: 'refund-pkscript',
              pkScript: 'receive-pkscript',
              solverPubkey: 'receive-solver-refund',
              refundWithoutReceiverDelay: 1024,
              refundDelay: 2048,
              payoutPkScript: 'receive-receiver-pkscript',
              nonInteractiveParameters: null,
            } as unknown as ReceiveSwapRow,
          ]
        },
      },
      onchainReceiveStore: {
        findRecoverable: async () => {
          calls.onchainReceiveStore += 1
          return [
            {
              id: 'onchain-receive-1',
              clientPayoutPubkey: 'onchain-receive-payout',
              serverPubkey: 'server',
              paymentHash: 'd'.repeat(64),
              refundLocktime: REFUND_LOCKTIME,
              claimDelay: 512,
              emulatorPubkey: 'emulator',
              refundPkScript: 'refund-pkscript',
              pkScript: 'onchain-receive-pkscript',
              providerPubkey: 'onchain-receive-solver-refund',
              refundWithoutReceiverDelay: 1024,
              refundDelay: 2048,
              clientPayoutPkScript: 'onchain-receive-receiver-pkscript',
              nonInteractiveParameters: null,
            } as unknown as OnchainReceiveSwapRow,
          ]
        },
      },
    }

    // The reader set built over the SAME four fake stores, so this still proves
    // each row went through its own corridor's mapper — now supplied by the
    // corridor rather than reached for by `vtxoLifecycle`.
    const rows = await liveLockupRows(readerSetFromDeps(deps as unknown as FlatCorridorDeps))

    expect(calls).toEqual({ store: 1, onchainStore: 1, receiveStore: 1, onchainReceiveStore: 1 })
    expect(rows.map((row) => row.pkScript)).toEqual([
      'send-pkscript',
      'onchain-send-pkscript',
      'receive-pkscript',
      'onchain-receive-pkscript',
    ])
    // Both receive rows went through their own mapper rather than being
    // dropped or mistakenly mapped through the SEND mapper: the receiver role
    // on each is the CLIENT's payout key, not the solver's — the role
    // inversion `receiveCovenantRowFor` documents on both receive legs.
    expect(rows.find((row) => row.pkScript === 'receive-pkscript')).toMatchObject({
      receiverPubkey: 'receive-payout',
      clientRefundPubkey: 'receive-solver-refund',
    })
    expect(rows.find((row) => row.pkScript === 'onchain-receive-pkscript')).toMatchObject({
      receiverPubkey: 'onchain-receive-payout',
      clientRefundPubkey: 'onchain-receive-solver-refund',
    })
  })

  it('returns nothing when every store is empty', async () => {
    const empty = { findRecoverable: async () => [] }
    const rows = await liveLockupRows(
      readerSetFromDeps({
        store: empty,
        onchainStore: empty,
        receiveStore: empty,
        onchainReceiveStore: empty,
      } as unknown as FlatCorridorDeps),
    )
    expect(rows).toEqual([])
  })
})

describe('runVtxoLifecycle — re-splitting after renewal', () => {
  it('re-splits the float once a renewal has consolidated it', async () => {
    // Renewal settles every selectable coin into ONE output. Harmless for sats;
    // fatal the moment the float holds an Arkade asset, because settle carries
    // assets onto the wallet's own output and the entire float lands on one
    // asset-bearing coin no sats lockup may spend. Splitting is what makes it
    // fundable again. @see #123
    let called = 0
    const { deps: d } = deps({
      resplitFloat: async () => {
        called += 1
        return 'split-txid'
      },
    })
    const report = await runVtxoLifecycle(d)
    expect(called).toBe(1)
    expect(report.resplit).toBe('split-txid')
  })

  it('does not re-split when renewal found nothing to do', async () => {
    // No settle, no consolidation, nothing to undo — and re-planning the pool on
    // every idle pass would read the wallet for no reason.
    let called = 0
    const { deps: d } = deps({
      renewVtxos: async () => {
        throw new Error('No VTXOs available to renew')
      },
      resplitFloat: async () => {
        called += 1
        return 'split-txid'
      },
    })
    const report = await runVtxoLifecycle(d)
    expect(report.renewed).toBeNull()
    expect(called).toBe(0)
    expect(report.resplit).toBeNull()
  })

  it('records a failed re-split without stopping recovery', async () => {
    // A float left consolidated still funds sats swaps, so this is a degradation
    // and not an outage. It must not take down the recovery step that follows,
    // which is the one holding money out of expiry.
    const { deps: d, calls } = deps({
      resplitFloat: async () => {
        throw new Error('indexer down')
      },
      recoverableVtxos: async () => [vtxo('deadbeef')],
    })
    const report = await runVtxoLifecycle(d)
    expect(report.failures).toContain('resplit: indexer down')
    expect(report.resplit).toBeNull()
    expect(calls.recover).toBe(1)
  })

  it('is optional — a deployment without a pool behaves exactly as before', async () => {
    const { deps: d } = deps()
    const report = await runVtxoLifecycle(d)
    expect(report.resplit).toBeNull()
    expect(report.failures).toEqual([])
  })
})

describe('runVtxoLifecycle', () => {
  it('renews the operating balance', async () => {
    const { deps: d, calls } = deps()
    const report = await runVtxoLifecycle(d)
    expect(calls.renew).toBe(1)
    expect(report.renewed).toBe('renew-txid')
  })

  it('treats "nothing to renew" as a normal pass, not a failure', async () => {
    const { deps: d } = deps({
      renewVtxos: async () => {
        throw new Error('No VTXOs available to renew')
      },
    })
    const report = await runVtxoLifecycle(d)
    expect(report.renewed).toBeNull()
    expect(report.failures).toEqual([])
  })

  it('recovers when nothing recoverable belongs to a lockup', async () => {
    const { deps: d, calls } = deps({ recoverableVtxos: async () => [vtxo('deadbeef')] })
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(1)
    expect(report.recovered).toBe('recover-txid')
    expect(report.recoverySkipped).toBeNull()
  })

  /**
   * The hazard this module exists for. `recoverVtxos` reads through the UNGATED
   * `getVtxos`, so a registered lockup IS in its sweep set, and it sweeps every
   * recoverable output into ONE settlement with no CLTV awareness. An immature
   * lockup therefore fails the whole batch — including the operating-balance
   * coins that were otherwise fine.
   */
  it('skips recovery entirely while a recoverable lockup is still pre-CLTV', async () => {
    const script = extendedScript()
    const scriptHex = hex.encode(script.pkScript)
    const { deps: d, calls } = deps({
      recoverableVtxos: async () => [vtxo('deadbeef'), vtxo(scriptHex, 1)],
      lockupDeadlines: async (): Promise<LockupDeadline[]> => [{ script: scriptHex, refundLocktime: REFUND_LOCKTIME }],
      nowSeconds: () => REFUND_LOCKTIME - 1,
    })
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(0)
    expect(report.recovered).toBeNull()
    expect(report.recoverySkipped).toContain(scriptHex)
  })

  it('recovers once the lockup CLTV has matured', async () => {
    const script = extendedScript()
    const scriptHex = hex.encode(script.pkScript)
    const { deps: d, calls } = deps({
      recoverableVtxos: async () => [vtxo(scriptHex)],
      lockupDeadlines: async (): Promise<LockupDeadline[]> => [{ script: scriptHex, refundLocktime: REFUND_LOCKTIME }],
      nowSeconds: () => REFUND_LOCKTIME + LOCKUP_RECOVERY_MTP_MARGIN_SECONDS,
    })
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(1)
    expect(report.recoverySkipped).toBeNull()
  })

  /**
   * The deadline alone is not enough. An absolute locktime matures against
   * median-time-past, which trails wall clock, so a lockup that is barely past
   * its deadline can still be refused — and refusing a recovery settlement
   * fails every unrelated coin batched with it.
   */
  it('keeps skipping just past the bare deadline, until the MTP margin clears', async () => {
    const scriptHex = hex.encode(extendedScript().pkScript)
    const { deps: d, calls } = deps({
      recoverableVtxos: async () => [vtxo(scriptHex)],
      lockupDeadlines: async (): Promise<LockupDeadline[]> => [{ script: scriptHex, refundLocktime: REFUND_LOCKTIME }],
      nowSeconds: () => REFUND_LOCKTIME + 1,
    })
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(0)
    expect(report.recoverySkipped).not.toBeNull()
  })

  /**
   * A lockup that is registered but has NOT gone recoverable is not in the
   * sweep set, so it cannot fail the batch and must not block recovery of the
   * operating balance — the over-conservative reading would wedge recovery for
   * as long as any swap is open.
   */
  it('does not block recovery on a pre-CLTV lockup that is not itself recoverable', async () => {
    const scriptHex = hex.encode(extendedScript().pkScript)
    const { deps: d, calls } = deps({
      recoverableVtxos: async () => [vtxo('deadbeef')],
      lockupDeadlines: async (): Promise<LockupDeadline[]> => [{ script: scriptHex, refundLocktime: REFUND_LOCKTIME }],
      nowSeconds: () => REFUND_LOCKTIME - 1,
    })
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(1)
    expect(report.recoverySkipped).toBeNull()
  })

  it('skips recovery when there is nothing recoverable at all', async () => {
    const { deps: d, calls } = deps()
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(0)
    expect(report.recovered).toBeNull()
  })

  /** Both steps always run: a renewal outage must not also stall recovery. */
  it('still recovers when renewal fails outright', async () => {
    const { deps: d, calls } = deps({
      renewVtxos: async () => {
        throw new Error('server unreachable')
      },
      recoverableVtxos: async () => [vtxo('deadbeef')],
    })
    const report = await runVtxoLifecycle(d)
    expect(calls.recover).toBe(1)
    expect(report.recovered).toBe('recover-txid')
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toContain('server unreachable')
  })

  it('reports a recovery failure without throwing', async () => {
    const { deps: d } = deps({
      recoverableVtxos: async () => [vtxo('deadbeef')],
      recoverVtxos: async () => {
        throw new Error('settlement refused')
      },
    })
    const report = await runVtxoLifecycle(d)
    expect(report.recovered).toBeNull()
    expect(report.failures[0]).toContain('settlement refused')
  })
})

/**
 * A real Arkade address, because {@link renewExpiringVtxos} decodes the
 * destination to get the pkScript the output fee is priced against. A
 * placeholder string would fail inside the SDK rather than inside the code
 * under test.
 */
const DESTINATION = extendedScript().address('tark', SERVER).encode()

/** The fee policy arkade-regtest ships by default: 1% of every offchain input. */
const ONE_PERCENT: RenewalPolicy = {
  intentFee: { offchainInput: 'amount * 0.01', offchainOutput: '0.0' },
  vtxoMaxAmount: -1n,
  dust: 330n,
}

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0)
const HOUR = 60 * 60 * 1000

/**
 * A coin with an explicit batch lifetime, expressed as the two facts the
 * renewal reads: how long the batch runs, and how far into it we are now.
 */
const coin = (value: number, lifetimeMs: number, elapsedMs: number): RenewableVtxo => ({
  value,
  createdAt: new Date(NOW - elapsedMs),
  expiresAt: new Date(NOW - elapsedMs + lifetimeMs),
})

interface Settled {
  inputs: readonly RenewableVtxo[]
  /** The first piece — what every fixture here asserts on, since none sets a target. */
  output: { address: string; amount: bigint }
  /** Every piece, so a split renewal can be asserted on. */
  outputs: readonly { address: string; amount: bigint }[]
}

const renewDeps = (
  vtxos: readonly RenewableVtxo[],
  overrides: Partial<RenewVtxoDeps<RenewableVtxo>> = {},
): { deps: RenewVtxoDeps<RenewableVtxo>; settled: Settled[] } => {
  const settled: Settled[] = []
  return {
    settled,
    deps: {
      serverInfo: async () => ONE_PERCENT,
      expiringVtxos: async () => vtxos,
      destination: async () => DESTINATION,
      settle: async (inputs, outputs) => {
        // Recorded as `output` (singular) for every existing assertion: the
        // renewal yields one piece unless a `poolTarget` is supplied, and none
        // of these fixtures supplies one.
        settled.push({ inputs, output: outputs[0]!, outputs })
        return 'settle-txid'
      },
      nowMs: () => NOW,
      ...overrides,
    },
  }
}

/** A coin deep inside its renewal window: 10h batch, 9h of it already gone. */
const DUE = coin(1_000_000, 10 * HOUR, 9 * HOUR)

describe('renewExpiringVtxos', () => {
  /**
   * The bug this function exists for. `IVtxoManager.renewVtxos` asks for an
   * output equal to the GROSS input sum, so the fee the intent implies
   * (`inputs - outputs`) is zero and a fee-charging operator rejects the whole
   * thing with `INTENT_INSUFFICIENT_FEE (31): got 0`. The output must come back
   * short by exactly what the server's own programs price.
   */
  it('carves the pool shape DURING the settlement when a target is given', async () => {
    // The point of the change: the float comes back already able to fund several
    // swaps, instead of as one coin that something else has to split afterwards.
    // 1% input fee on 1_000_000 leaves 990_000 to divide.
    const { deps: d, settled } = renewDeps([DUE], { poolTarget: [{ size: 250_000, want: 3 }] })
    await renewExpiringVtxos(d)
    expect(settled).toHaveLength(1)
    const amounts = settled[0]!.outputs.map((o) => o.amount)
    expect(amounts.length).toBeGreaterThan(1)
    expect(amounts.filter((a) => a === 250_000n).length).toBe(3)
    // Nothing is conjured and nothing is lost: this operator prices outputs at
    // zero, so the pieces sum to exactly what there was to divide.
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(990_000n)
    // Every piece goes to our own address, not just the first.
    expect(settled[0]!.outputs.every((o) => o.address === DESTINATION)).toBe(true)
  })

  it('renews into ONE output when no target is configured', async () => {
    // The behaviour every existing deployment has: absent a target, nothing
    // about renewal changes.
    const { deps: d, settled } = renewDeps([DUE])
    await renewExpiringVtxos(d)
    expect(settled[0]!.outputs).toHaveLength(1)
    expect(settled[0]!.outputs[0]!.amount).toBe(990_000n)
  })

  it('pays the operator’s intent fee out of the renewed output', async () => {
    const { deps: d, settled } = renewDeps([DUE])
    expect(await renewExpiringVtxos(d)).toBe('settle-txid')
    expect(settled).toHaveLength(1)
    // 1% of 1_000_000 in, nothing on the output.
    expect(settled[0]!.output.amount).toBe(990_000n)
    expect(settled[0]!.output.address).toBe(DESTINATION)
  })

  it('leaves the output gross when the operator charges nothing', async () => {
    const { deps: d, settled } = renewDeps([DUE], {
      serverInfo: async () => ({ ...ONE_PERCENT, intentFee: { offchainInput: '0.0', offchainOutput: '0.0' } }),
    })
    await renewExpiringVtxos(d)
    expect(settled[0]!.output.amount).toBe(1_000_000n)
  })

  it('prices the output fee too, not just the inputs', async () => {
    const { deps: d, settled } = renewDeps([DUE], {
      serverInfo: async () => ({ ...ONE_PERCENT, intentFee: { offchainInput: '0.0', offchainOutput: '250.0' } }),
    })
    await renewExpiringVtxos(d)
    expect(settled[0]!.output.amount).toBe(999_750n)
  })

  /**
   * The commonest real-world shape — a percentage on BOTH sides — and the one
   * where our arithmetic and the server's genuinely disagree, so the direction
   * of the disagreement is worth pinning deliberately rather than discovering.
   *
   * The output fee is a function of the output, but the output is what we are
   * solving for, so this deducts `r` of the GROSS (`amount = gross × (1−r)`)
   * while the server charges `r` of the amount it actually receives
   * (`r × gross × (1−r)`). The gap is `r² × gross` — here 0.0001 × 990_000 = 99
   * sats — and it falls on the safe side: we imply MORE fee than the minimum, so
   * the intent is never rejected for underpaying. Solving the fixed point would
   * recover those 99 sats; it is not worth trading a rejection risk for.
   */
  it('over-pays rather than under-pays when the output fee is a percentage', async () => {
    const { deps: d, settled } = renewDeps([DUE], {
      serverInfo: async () => ({
        ...ONE_PERCENT,
        intentFee: { offchainInput: 'amount * 0.01', offchainOutput: 'amount * 0.01' },
      }),
    })
    await renewExpiringVtxos(d)
    // 1_000_000 − 1% in = 990_000 gross, less 1% of that gross = 980_100.
    expect(settled[0]!.output.amount).toBe(980_100n)

    // What the server checks: `inputs − outputs` against its own programs
    // evaluated on the committed amount. Over by exactly r² × gross.
    const impliedFee = 1_000_000n - settled[0]!.output.amount
    const serverMinimum = 10_000n + 9_801n
    expect(impliedFee).toBe(19_900n)
    expect(impliedFee - serverMinimum).toBe(99n)
    expect(impliedFee).toBeGreaterThan(serverMinimum)
  })

  /**
   * The treadmill guard. A renewal costs the intent fee EVERY time it runs and
   * mints a coin with a fresh full lifetime, so a flat threshold longer than
   * that lifetime would re-select the coin renewal just made and re-settle the
   * float on every pass until the fees ate it. On the corridor's regtest stack
   * the flat default is 3 days against a 6144-second batch — more than 40x over.
   */
  it('does not renew a coin fresh out of a batch shorter than the flat threshold', async () => {
    // 1.7h lifetime, six minutes old: far inside a flat 3-day threshold, and
    // nowhere near needing renewal.
    const { deps: d, settled } = renewDeps([coin(1_000_000, 1.7 * HOUR, 6 * 60 * 1000)])
    await expect(renewExpiringVtxos(d)).rejects.toThrow('No VTXOs available to renew')
    expect(settled).toEqual([])
  })

  it('renews that same coin once it is past half its lifetime', async () => {
    const { deps: d, settled } = renewDeps([coin(1_000_000, 1.7 * HOUR, 1.2 * HOUR)])
    await renewExpiringVtxos(d)
    expect(settled).toHaveLength(1)
  })

  /**
   * The cap must not touch the mainnet-shaped case: a four-week batch against
   * the three-day flat threshold is already the smaller number, so behaviour
   * there is exactly the SDK's.
   */
  it('keeps the flat threshold when the batch outlives it', async () => {
    const FOUR_WEEKS = 28 * 24 * HOUR
    const outside = renewDeps([coin(1_000_000, FOUR_WEEKS, FOUR_WEEKS - 4 * 24 * HOUR)])
    await expect(renewExpiringVtxos(outside.deps)).rejects.toThrow('No VTXOs available to renew')

    const inside = renewDeps([coin(1_000_000, FOUR_WEEKS, FOUR_WEEKS - 2 * 24 * HOUR)])
    await renewExpiringVtxos(inside.deps)
    expect(inside.settled).toHaveLength(1)
  })

  /** Nothing is going to strand a coin with no expiry, so paying to re-mint it is pure loss. */
  it('never renews a coin that carries no expiry at all', async () => {
    const { deps: d } = renewDeps([{ value: 1_000_000, createdAt: new Date(NOW - 9 * HOUR) }])
    await expect(renewExpiringVtxos(d)).rejects.toThrow('No VTXOs available to renew')
  })

  /**
   * Reusing the SDK's own wording is load-bearing: `runVtxoLifecycle` matches
   * these on message to tell an idle wallet from a broken one, so a reworded
   * throw here would turn every quiet pass into a reported failure.
   */
  it('reports an empty candidate set in the wording runVtxoLifecycle treats as benign', async () => {
    const { deps: d } = renewDeps([])
    const report = await runVtxoLifecycle({
      renewVtxos: () => renewExpiringVtxos(d),
      recoverVtxos: async () => 'recover-txid',
      recoverableVtxos: async () => [],
      lockupDeadlines: async () => [],
      nowSeconds: () => 0,
    })
    expect(report.renewed).toBeNull()
    expect(report.failures).toEqual([])
  })

  it('drops a coin worth less than its own fee rather than destroying it', async () => {
    // 100% of the input, so the fee exactly equals the value.
    const { deps: d, settled } = renewDeps([DUE], {
      serverInfo: async () => ({ ...ONE_PERCENT, intentFee: { offchainInput: 'amount * 1.0', offchainOutput: '0.0' } }),
    })
    await expect(renewExpiringVtxos(d)).rejects.toThrow('below its own fee')
    expect(settled).toEqual([])
  })

  it('refuses to settle an output the fee has driven under dust', async () => {
    const { deps: d, settled } = renewDeps([coin(400, 10 * HOUR, 9 * HOUR)], {
      serverInfo: async () => ({ ...ONE_PERCENT, intentFee: { offchainInput: '0.0', offchainOutput: '250.0' } }),
    })
    await expect(renewExpiringVtxos(d)).rejects.toThrow('below dust threshold')
    expect(settled).toEqual([])
  })

  it('batches every due coin into one settlement, netting each one’s fee', async () => {
    const { deps: d, settled } = renewDeps([DUE, coin(500_000, 10 * HOUR, 9 * HOUR)])
    await renewExpiringVtxos(d)
    expect(settled[0]!.inputs).toHaveLength(2)
    expect(settled[0]!.output.amount).toBe(990_000n + 495_000n)
  })

  it('leaves a coin that is not yet due out of the batch', async () => {
    const notDue = coin(500_000, 10 * HOUR, 1 * HOUR)
    const { deps: d, settled } = renewDeps([DUE, notDue])
    await renewExpiringVtxos(d)
    expect(settled[0]!.inputs).toEqual([DUE])
  })

  /**
   * Only 50 inputs fit in one settlement. Which 50 matters: a coin that misses
   * its renewal window has no second chance but a unilateral exit, so the cut
   * has to fall on the coins with the most time left.
   */
  it('fills the settlement with the soonest-expiring coins when more are due than fit', async () => {
    const many = Array.from({ length: 60 }, (_, i) => coin(100_000, 10 * HOUR, (9.9 - i * 0.01) * HOUR))
    const { deps: d, settled } = renewDeps(many)
    await renewExpiringVtxos(d)
    expect(settled[0]!.inputs).toHaveLength(50)
    // `many[0]` is the oldest and so the soonest to expire; the last ten, which
    // have the most life left, are the ones deferred.
    expect(settled[0]!.inputs).toEqual(many.slice(0, 50))
  })

  /** `-1n` is the wire's "no limit", and must not read as a ceiling of minus one. */
  it('treats a negative per-output ceiling as no ceiling', async () => {
    const { deps: d, settled } = renewDeps([DUE])
    await renewExpiringVtxos(d)
    expect(settled[0]!.output.amount).toBe(990_000n)
  })

  it('skips a coin that would push the output past the per-output ceiling', async () => {
    const small = coin(100_000, 10 * HOUR, 8.9 * HOUR)
    const { deps: d, settled } = renewDeps([DUE, small], {
      serverInfo: async () => ({ ...ONE_PERCENT, vtxoMaxAmount: 1_000_000n }),
    })
    await renewExpiringVtxos(d)
    // The 1M coin nets 990_000; adding the 100k coin's 99_000 would exceed the
    // ceiling, so it is skipped rather than ending the batch.
    expect(settled[0]!.inputs).toEqual([DUE])
    expect(settled[0]!.output.amount).toBe(990_000n)
  })

  /**
   * A coin over the ceiling ALL BY ITSELF is not deferred — it is unrenewable,
   * on this pass and on every later one. `gross` is still zero when it is
   * judged, so no ordering of the float and no amount of waiting brings it
   * under the ceiling; only cutting it into pieces does.
   *
   * That is what makes the pool split load-bearing for near-expiry coins
   * rather than merely tidy, and it is why `poolPlan` deliberately does NOT
   * filter them out.
   */
  it('can never renew a coin that alone exceeds the per-output ceiling', async () => {
    const oversized = coin(2_000_000, 10 * HOUR, 9 * HOUR)
    const { deps: d, settled } = renewDeps([oversized], {
      serverInfo: async () => ({ ...ONE_PERCENT, vtxoMaxAmount: 1_000_000n }),
    })
    await expect(renewExpiringVtxos(d)).rejects.toThrow('No VTXOs available to renew')
    expect(settled).toEqual([])
  })

  /**
   * And it declines in wording `BENIGN_RENEWAL` matches, so the pass reports no
   * failure at all. An operator watching `failures` reads a healthy float right
   * up until the coin expires out from under it — which is the argument for
   * splitting near-expiry coins rather than skipping them.
   */
  it('reports the unrenewable oversized coin as a quiet, failure-free pass', async () => {
    const oversized = coin(2_000_000, 10 * HOUR, 9 * HOUR)
    const { deps: d } = renewDeps([oversized], {
      serverInfo: async () => ({ ...ONE_PERCENT, vtxoMaxAmount: 1_000_000n }),
    })
    const report = await runVtxoLifecycle({
      renewVtxos: () => renewExpiringVtxos(d),
      recoverVtxos: async () => 'recover-txid',
      recoverableVtxos: async () => [],
      lockupDeadlines: async () => [],
      nowSeconds: () => 0,
    })
    expect(report.renewed).toBeNull()
    expect(report.failures).toEqual([])
  })

  /**
   * Escrow safety does not live in this function — it lives in the GATED read
   * the caller supplies. This pins the contract that makes that true: whatever
   * `expiringVtxos` hands over is what gets settled, so wiring it to an ungated
   * read would sweep a counterparty's lockup into the solver's own address.
   */
  it('settles exactly the coins the gated read supplied, and nothing else', async () => {
    const { deps: d, settled } = renewDeps([DUE])
    await renewExpiringVtxos(d)
    expect(settled[0]!.inputs).toEqual([DUE])
  })
})

/**
 * Height-denominated batch expiry, where a height and a clock get confused.
 *
 * A coin can carry `expiresAtHeight` instead of `expiresAt` — the SDK's wire
 * parser reads any expiry too small to be a plausible 2025+ timestamp as a
 * height. Two different questions are asked of that number, and they have
 * different right answers: the FEE programs must see exactly what the server
 * sees, while SCHEDULING must not pretend a height is a time.
 */
describe('height-denominated batch expiry', () => {
  const CURRENT_HEIGHT = 890_000

  const heightCoin = (value: number, expiresAtHeight = CURRENT_HEIGHT, elapsedMs = HOUR): RenewableVtxo => ({
    value,
    createdAt: new Date(NOW - elapsedMs),
    expiresAtHeight,
  })

  /**
   * The regression this guards. `expiresAtHeight * 1000` at any real height is
   * an instant in January 1970, so a wall-clock comparison against it made the
   * coin's whole lifetime read as zero and collapsed the threshold to 0 —
   * silently disabling the treadmill cap for exactly these coins. The threshold
   * now falls back to the flat default instead of being computed from a number
   * that is not a time.
   */
  it('does not collapse the renewal threshold to zero', () => {
    expect(renewalThresholdMs(heightCoin(1_000_000))).toBe(RENEWAL_THRESHOLD_MS)
    expect(renewalThresholdMs(heightCoin(1_000_000))).toBeGreaterThan(0)
  })

  /**
   * Still due — deliberately, and not because of the arithmetic above. The
   * gated read's near-expiry arm (`isVtxoExpiringSoon`) returns false without an
   * `expiresAt`, so the only arm that can surface a height-denominated coin is
   * `canRecoverOnchain` — already swept, or already past its expiry height.
   * Renewing those at once is right; deferring them stalls until they strand,
   * and hands them to the still-unpriced `recoverVtxos`.
   */
  it('treats a height-denominated coin as due, so it is never left to strand', async () => {
    expect(isRenewalDue(heightCoin(1_000_000), NOW)).toBe(true)
    const { deps: d, settled } = renewDeps([heightCoin(1_000_000)])
    await renewExpiringVtxos(d)
    expect(settled).toHaveLength(1)
    expect(settled[0]!.output.amount).toBe(990_000n)
  })

  /** A coin carrying no expiry of either kind is still never due. */
  it('does not confuse "no expiry at all" with a height', () => {
    expect(isRenewalDue({ value: 1_000_000, createdAt: new Date(NOW - HOUR) }, NOW)).toBe(false)
  })

  /**
   * The half of the split that must NOT change. `toOffchainInputFeeParams` feeds
   * the fee program `toBatchExpiry`, which is `expiresAtHeight * 1000` ms — and
   * the server evaluates its own copy of that program over the same number, so
   * any correction here would silently price against a different expiry than the
   * server does. The estimator hands CEL the expiry in seconds, so a program of
   * `expiry` returns the raw height, which is what makes this observable at all.
   */
  it('still feeds the fee program the raw height, exactly as the server sees it', async () => {
    const { deps: d, settled } = renewDeps([heightCoin(2_000_000)], {
      serverInfo: async () => ({ ...ONE_PERCENT, intentFee: { offchainInput: 'expiry', offchainOutput: '0.0' } }),
    })
    await renewExpiringVtxos(d)
    // `expiry` seconds == expiresAtHeight, charged as satoshis.
    expect(settled[0]!.output.amount).toBe(2_000_000n - BigInt(CURRENT_HEIGHT))
  })
})
