/**
 * The float pass's way out of a recovery its own guard has wedged: four swept
 * send-leg lockups on mainnet, each needing the TRADER's key, so recovery
 * declined to touch anything while they sat in the recoverable set — and with
 * no spend fact, nothing retired them either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { ArkAddress } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { lockupContractRegistration } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { migrationClock, resetSweptRefundThrottle, runFloatLifecycle } from '@arkade-os/solver-app/ops/float.js'
import { readerSetFromDeps, type FlatCorridorDeps } from '@arkade-os/solver-app/ops/corridorSet.js'
import type { SweptLockupRefund } from '@arkade-os/solver-arkade/arkade/sweptLockupRefund.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'

const SOLVER = schnorr.getPublicKey(new Uint8Array(32).fill(4))
const TRADER = schnorr.getPublicKey(new Uint8Array(32).fill(11))
const FLOAT_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

const sendLockup = (client: Uint8Array = TRADER): CovenantSwapScript =>
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

const stores = {
  store: { findRecoverable: async () => [] },
  onchainStore: { findRecoverable: async () => [] },
  receiveStore: { findRecoverable: async () => [] },
}

const servicesWith = (options: {
  script: CovenantSwapScript
  confirmedRecoverable?: boolean
  refundSweptLockup?: (pkScript: string) => Promise<SweptLockupRefund>
  recoverVtxos?: () => Promise<string>
}): Services =>
  ({
    arkade: {
      wallet: {
        settle: async () => 'settle-txid',
        getBoardingUtxos: async () => [],
        getSpendableVtxos: async () => [],
        getVtxoManager: async () => ({
          migrateDeprecatedSignerVtxos: async () => ({ skipped: 'no-deprecated-vtxos' }),
          getExpiringVtxos: async () => [],
          getExpiredBoardingUtxos: async () => [],
          recoverVtxos: options.recoverVtxos ?? (async () => 'recover-txid'),
        }),
        getContractManager: async () => ({
          getContracts: async () => [lockupContractRegistration(options.script, 'ark1test')],
          getContractsWithVtxos: async () => [],
        }),
        getVtxos: async () => [
          {
            txid: 'a'.repeat(64),
            vout: 0,
            script: hex.encode(options.script.pkScript),
            isSwept: options.confirmedRecoverable !== false,
          },
        ],
        arkProvider: { getInfo: async () => ({ fees: { intentFee: {} }, vtxoMaxAmount: 1_000_000n, dust: 330n }) },
        getAddress: async () => FLOAT_ADDRESS,
      },
      reservations: createReservationLedger(),
      identity: { xOnlyPublicKey: async () => SOLVER },
    },
    ...stores,
    readers: readerSetFromDeps(stores as unknown as FlatCorridorDeps),
    ...(options.refundSweptLockup ? { service: { refundSweptLockup: options.refundSweptLockup } } : {}),
    config: { limits: { maxSats: 100_000 }, maxExposedSats: 1_000_000, lnBackend: null },
  }) as unknown as Services

describe('the float pass refunds the swept lockups that wedge recovery', () => {
  beforeEach(() => {
    resetSweptRefundThrottle()
    migrationClock.nowMs = () => Date.now()
  })

  it('reports the blocking outputs as data, not only as a sentence', async () => {
    const script = sendLockup()
    const report = await runFloatLifecycle(servicesWith({ script }))
    expect(report.recoverySkipped).toMatch(/no refund key of ours/)
    expect(report.recoveryBlockedBy).toEqual([
      {
        txid: 'a'.repeat(64),
        vout: 0,
        script: hex.encode(script.pkScript),
        reason: expect.stringContaining('no refund key of ours'),
        notOurs: true,
      },
    ])
  })

  it('refunds a refused row holding the blocking lockup', async () => {
    const script = sendLockup()
    const refundSweptLockup = vi.fn(async (): Promise<SweptLockupRefund> => ({
      swapId: 'swap-1',
      txid: 'batch-txid',
      recorded: true,
    }))
    const report = await runFloatLifecycle(servicesWith({ script, refundSweptLockup }))

    expect(refundSweptLockup).toHaveBeenCalledWith(hex.encode(script.pkScript), expect.any(Function))
    expect(report.failures).toEqual([])
  })

  it('names, and does not touch, a row the verdict will not clear', async () => {
    const script = sendLockup()
    const refundSweptLockup = async (): Promise<SweptLockupRefund> => ({
      swapId: 'swap-2',
      heldInState: 'stuck',
      why: '{"verdict":"undecided-push-nothing"}',
    })
    const report = await runFloatLifecycle(servicesWith({ script, refundSweptLockup }))

    expect(report.failures).toEqual([
      expect.stringContaining('held by send swap swap-2 (stuck): {"verdict":"undecided-push-nothing"}'),
    ])
  })

  it('names a blocking lockup no send swap of ours owns', async () => {
    const script = sendLockup()
    const report = await runFloatLifecycle(servicesWith({ script, refundSweptLockup: async () => null }))
    expect(report.failures).toEqual([expect.stringContaining('no send swap of ours owns it')])
  })

  it('keeps the pass alive when the batch refund throws, and backs off after it', async () => {
    const script = sendLockup()
    const refundSweptLockup = vi.fn(async (): Promise<SweptLockupRefund> => {
      throw new Error('INTENT_INSUFFICIENT_FEE')
    })
    const services = servicesWith({ script, refundSweptLockup })

    const first = await runFloatLifecycle(services)
    expect(first.failures).toEqual([expect.stringContaining('INTENT_INSUFFICIENT_FEE')])
    const second = await runFloatLifecycle(services)
    expect(refundSweptLockup).toHaveBeenCalledTimes(1)
    expect(second.failures).toEqual([])
  })

  it('retries once the backoff has elapsed', async () => {
    const script = sendLockup()
    const refundSweptLockup = vi.fn(async (): Promise<SweptLockupRefund> => {
      throw new Error('emulator unreachable')
    })
    const services = servicesWith({ script, refundSweptLockup })
    let now = 1_000_000
    migrationClock.nowMs = () => now

    await runFloatLifecycle(services)
    now += 5 * 60_000
    await runFloatLifecycle(services)
    expect(refundSweptLockup).toHaveBeenCalledTimes(2)
  })

  it('leaves an IMMATURE lockup alone: its own clock clears it, and a refund would rob a live swap', async () => {
    const script = sendLockup(SOLVER)
    const pkScript = hex.encode(script.pkScript)
    const refundSweptLockup = vi.fn(async (): Promise<SweptLockupRefund> => null)
    const services = servicesWith({ script, refundSweptLockup })
    // Client refund key IS ours, so the deadline is compared rather than
    // refused outright — the immature arm, not the not-ours one.
    const live = {
      ...stores,
      store: {
        findRecoverable: async () => [
          {
            id: 'swap-live',
            receiverPubkey: hex.encode(SOLVER),
            serverPubkey: hex.encode(SOLVER),
            paymentHash: 'aa'.repeat(32),
            pkScript,
            refundLocktime: 4_000_000_000,
            claimDelay: 4096,
            refundWithoutReceiverDelay: 6144,
            refundDelay: 5120,
            emulatorPubkey: null,
            refundPkScript: null,
            clientRefundPubkey: hex.encode(SOLVER),
            receiverPkScript: null,
            nonInteractiveParameters: true,
          },
        ],
      },
    }
    ;(services as unknown as { readers: unknown }).readers = readerSetFromDeps(live as unknown as FlatCorridorDeps)
    ;(services.arkade.wallet as unknown as Record<string, unknown>).getContractManager = async () => ({
      getContracts: async () => [],
      getContractsWithVtxos: async () => [],
    })

    const report = await runFloatLifecycle(services)
    expect(report.recoveryBlockedBy).toEqual([expect.objectContaining({ notOurs: false })])
    expect(report.recoverySkipped).toMatch(/not yet safely past CLTV/)
    expect(refundSweptLockup).not.toHaveBeenCalled()
  })
})
