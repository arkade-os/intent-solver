import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import { REFUND_SAFETY_MARGIN, unilateralLadderFor } from '@arkade-os/solver-core/core/send.js'
import {
  assertClientSoloCsvWindow,
  checkedFutureOriginLowerBoundMtp,
  CSV_REORG_BUDGET_BLOCKS,
  type CsvWindowOrigin,
} from '@arkade-os/solver-corridors/send/csvWindow.js'
import { describe, expect, it } from 'vitest'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])
const receiver = key(1)
const server = key(3)
const emulator = key(9)
const client = key(11)
const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(7)))
const refundLocktime = 1_800_000_000
const soloDelay = 1_266_176
const claimDelay = 605_184
const refundDelay = 950_272

const row = (): CovenantScriptRow => {
  const script = new CovenantSwapScript({
    receiver,
    server,
    preimageHash: ripemd160(hex.decode(paymentHash)),
    refundLocktime,
    claimDelay,
    client,
    clientRefundDelay: soloDelay,
    refundWithoutServerDelay: refundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: emulator,
      receiverPkScript: p2tr(key(13)),
      senderPkScript: p2tr(key(5)),
    },
  })
  return {
    id: 'csv-window-test',
    receiverPubkey: hex.encode(receiver),
    serverPubkey: hex.encode(server),
    paymentHash,
    refundLocktime,
    claimDelay,
    emulatorPubkey: hex.encode(emulator),
    refundPkScript: hex.encode(p2tr(key(5))),
    pkScript: hex.encode(script.pkScript),
    clientRefundPubkey: hex.encode(client),
    refundWithoutReceiverDelay: soloDelay,
    refundDelay,
    receiverPkScript: hex.encode(p2tr(key(13))),
    nonInteractiveParameters: true,
  }
}

const point = { txid: 'ab'.repeat(32), vout: 0, value: 5_000_000_000 }
type ConfirmedOrigin = Extract<CsvWindowOrigin, { kind: 'confirmed' }>

const makeOrigin = (swap: CovenantScriptRow, overrides: Partial<ConfirmedOrigin> = {}): ConfirmedOrigin => ({
  kind: 'confirmed',
  txid: point.txid,
  vout: point.vout,
  value: point.value,
  pkScript: swap.pkScript,
  blockHash: '01'.repeat(32),
  blockHeight: 100,
  confirmations: CSV_REORG_BUDGET_BLOCKS + 1,
  priorBlockMtp: 1_798_750_000,
  originLowerBoundMtp: 1_798_750_000,
  tipHash: '02'.repeat(32),
  tipHeight: 106,
  reorgBudgetBlocks: CSV_REORG_BUDGET_BLOCKS,
  ...overrides,
})

describe('client solo CSV window', () => {
  it('stretches a seconds CSV from the conservative common-ancestor MTP', () => {
    const deadline = 1_795_173_670
    const originLowerBoundMtp = 1_793_907_970
    const base = {
      unilateralClaimDelay: 604_800,
      unilateralRefundDelay: 1_000_000,
      unilateralRefundWithoutReceiverDelay: 1_266_176,
    }

    const ladder = unilateralLadderFor(base, deadline, originLowerBoundMtp, {
      originLowerBoundMtp,
      marginSeconds: REFUND_SAFETY_MARGIN,
    })

    expect(ladder.unilateralRefundWithoutReceiverDelay).toBe(1_273_344)
    expect(originLowerBoundMtp + ladder.unilateralRefundWithoutReceiverDelay).toBeGreaterThan(
      deadline + REFUND_SAFETY_MARGIN,
    )
  })

  it('rejects a quote floor that is not the six block common ancestor', () => {
    expect(() => checkedFutureOriginLowerBoundMtp({ ...originFloor(), reorgBudgetBlocks: 5 })).toThrow(
      /six block common ancestor/,
    )
  })

  it('rejects a confirmed output with only six confirmations under a six block reorg budget', async () => {
    const swap = row()
    const origin = makeOrigin(swap, { confirmations: 6, tipHeight: 105 })
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async () => origin,
      }),
    ).rejects.toThrow(/six block common ancestor|incomplete active-chain evidence/)
  })

  it('admits the exact script and a >32-bit sat value when its solo refund stays behind deadline plus margin', async () => {
    const swap = row()
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async (_point, expectedPkScript) => {
          expect(expectedPkScript).toBe(swap.pkScript)
          return makeOrigin(swap)
        },
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects equality at the deadline plus margin', async () => {
    const swap = row()
    const exactOriginMtp = swap.refundLocktime + REFUND_SAFETY_MARGIN - soloDelay
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async () =>
          makeOrigin(swap, {
            priorBlockMtp: exactOriginMtp,
            originLowerBoundMtp: exactOriginMtp,
          }),
      }),
    ).rejects.toThrow(/mature before the scripted refund deadline plus safety margin/)
  })

  it('rejects missing or conflicting origin evidence', async () => {
    const swap = row()
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async () => makeOrigin(swap, { value: point.value + 1 }),
      }),
    ).rejects.toThrow(/does not match/)
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async () => makeOrigin(swap, { reorgBudgetBlocks: 5 }),
      }),
    ).rejects.toThrow(/incomplete active-chain evidence/)
  })

  it('requires a virtual origin to match the pinned tip and positive ancestry proof', async () => {
    const swap = row()
    const tipHash = '02'.repeat(32)
    const origin: CsvWindowOrigin = {
      kind: 'virtual',
      txid: point.txid,
      vout: point.vout,
      value: point.value,
      pkScript: swap.pkScript,
      absentAtTipHash: tipHash,
      tipHash,
      tipHeight: 106,
      originLowerBoundMtp: 1_798_750_000,
      ancestorHash: '03'.repeat(32),
      ancestorHeight: 100,
      ancestorMedianTimePast: 1_798_750_000,
      reorgBudgetBlocks: CSV_REORG_BUDGET_BLOCKS,
      ancestryProofRef: 'batch-tree:commitment-1:leaf-0',
    }
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async () => origin,
      }),
    ).resolves.toBeUndefined()
    await expect(
      assertClientSoloCsvWindow(swap, [point], {
        futureOriginLowerBoundMtp: async () => originFloor(),
        origin: async () => ({ ...origin, absentAtTipHash: '04'.repeat(32) }),
      }),
    ).rejects.toThrow(/incomplete active-chain evidence/)
  })

  it('rejects a block CSV because a block count cannot guarantee a wall-clock margin', () => {
    expect(() =>
      unilateralLadderFor(
        { unilateralClaimDelay: 20, unilateralRefundDelay: 30, unilateralRefundWithoutReceiverDelay: 40 },
        refundLocktime,
        1_799_000_000,
        { originLowerBoundMtp: 1_799_000_000, marginSeconds: REFUND_SAFETY_MARGIN },
      ),
    ).toThrow(/block CSV cannot guarantee/)
  })
})

const originFloor = () => ({
  originLowerBoundMtp: 1_798_750_000,
  tipHash: '02'.repeat(32),
  tipHeight: 106,
  ancestorHash: '03'.repeat(32),
  ancestorHeight: 100,
  ancestorMedianTimePast: 1_798_750_000,
  reorgBudgetBlocks: CSV_REORG_BUDGET_BLOCKS,
})
