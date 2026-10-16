import { describe, it, expect, vi, beforeEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { base64, hex } from '@scure/base'
import { ArkAddress, Extension, MnemonicIdentity, MultisigTapscript, Transaction, VtxoScript } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { ArkadeContext, FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'

// Constructed inside the module under test, so a file-scoped mock is the only
// seam. What this asserts is the INTENT registered.
// `vi.hoisted`: this file imports the mocked module at top level, so the
// factory runs before a plain const would exist.
const { submitIntent, join } = vi.hoisted(() => ({
  submitIntent: vi.fn(async ({ proof }: { proof: string }) => proof),
  join: vi.fn(async () => 'commitment-txid'),
}))
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>()
  return {
    ...actual,
    RestEmulatorProvider: vi.fn().mockImplementation(() => ({ submitIntent })),
    Batch: { ...actual.Batch, join },
  }
})

const { refundSweptSwapScript, sweptRefundBatchHandler } =
  await import('@arkade-os/solver-arkade/arkade/sweptRefund.js')

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const identity = MnemonicIdentity.fromMnemonic(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  { isMainnet: false },
)
const RECEIVER = await identity.xOnlyPublicKey()
const SERVER = key(3)
const CLIENT_REFUND = p2tr(key(5))
const SOLVER_PAYOUT = p2tr(key(13))

const swapScript = () =>
  new CovenantSwapScript({
    receiver: RECEIVER,
    server: SERVER,
    preimageHash: ripemd160(sha256(new Uint8Array(32).fill(7))),
    refundLocktime: 1_800_000_000,
    claimDelay: 512,
    client: key(11),
    clientRefundDelay: 6144,
    refundWithoutServerDelay: 5120,
    nonInteractiveParameters: {
      emulatorPubkey: key(9),
      receiverPkScript: SOLVER_PAYOUT,
      senderPkScript: CLIENT_REFUND,
    },
  })

const sourceTx = (vout: number, amount: bigint): { id: string; b64: string } => {
  const tx = new Transaction({ allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true })
  tx.addInput({ txid: 'c'.repeat(64), index: vout, witnessUtxo: { script: CLIENT_REFUND, amount: 1_000_000n } })
  tx.addOutput({ script: CLIENT_REFUND, amount })
  return { id: tx.id, b64: base64.encode(tx.toPSBT()) }
}

const FLOAT_FORFEIT = MultisigTapscript.encode({ pubkeys: [RECEIVER, SERVER] }).script
const FLOAT_SCRIPT = new VtxoScript([FLOAT_FORFEIT])
const FLOAT_TAPTREE = FLOAT_SCRIPT.encode()
const FLOAT_LEAF = FLOAT_SCRIPT.findLeaf(hex.encode(FLOAT_FORFEIT))

interface Stack {
  ctx: ArkadeContext
  registered: { proof: string }[]
  topics: string[][]
}

const stack = (options: {
  swept: readonly FundedOutput[]
  inputFee?: string
  floatCoins?: { txid: string; vout: number; value: number; isSwept?: boolean }[]
  duringFloatRead?: (reservations: ReturnType<typeof createReservationLedger>) => void
}): Stack => {
  const virtualTxs = new Map<string, string>()
  for (const output of options.swept) virtualTxs.set(output.txid, sourceTx(output.vout, BigInt(output.value)).b64)
  for (const coin of options.floatCoins ?? []) virtualTxs.set(coin.txid, sourceTx(coin.vout, BigInt(coin.value)).b64)
  const registered: { proof: string }[] = []
  const topics: string[][] = []
  const reservations = createReservationLedger()

  const ctx = {
    identity,
    hrp: 'ark',
    dustSats: 330n,
    vtxoMinSats: 1n,
    reservations,
    wallet: {
      arkServerPublicKey: SERVER,
      getAddress: async () => new ArkAddress(SERVER, key(21), 'ark').encode(),
      // Honours `withRecoverable` as the SDK read does: off, a swept coin is not returned.
      getSpendableVtxos: async (filter?: { withRecoverable?: boolean }) => {
        options.duringFloatRead?.(reservations)
        return (options.floatCoins ?? [])
          .filter((coin) => filter?.withRecoverable === true || coin.isSwept !== true)
          .map((coin) => ({
            ...coin,
            isSwept: coin.isSwept === true,
            createdAt: new Date(0),
            tapTree: FLOAT_TAPTREE,
            forfeitTapLeafScript: FLOAT_LEAF,
            intentTapLeafScript: FLOAT_LEAF,
          }))
      },
      arkProvider: {
        getInfo: async () => ({
          network: 'regtest',
          dust: 330n,
          vtxoTreeExpiry: 180n,
          forfeitPubkey: hex.encode(SERVER),
          forfeitAddress: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
          fees: { intentFee: { offchainInput: options.inputFee ?? '', offchainOutput: '' } },
        }),
        registerIntent: async (intent: { proof: string }) => {
          registered.push(intent)
          return 'intent-1'
        },
        getEventStream: (_signal: AbortSignal, subscribed: string[]) => {
          topics.push(subscribed)
          return (async function* () {})()
        },
      },
      indexerProvider: {
        getVirtualTxs: async (txids: string[]) => ({
          txs: txids.map((id) => virtualTxs.get(id)).filter((tx): tx is string => tx !== undefined),
        }),
      },
    },
  } as unknown as ArkadeContext
  return { ctx, registered, topics }
}

const proofOf = (registered: { proof: string }[]): InstanceType<typeof Transaction> =>
  Transaction.fromPSBT(base64.decode(registered.at(-1)!.proof))

describe('refundSweptSwapScript builds an intent the covenant can satisfy', () => {
  beforeEach(() => {
    submitIntent.mockClear()
    join.mockClear()
    submitIntent.mockImplementation(async ({ proof }: { proof: string }) => proof)
  })

  it('puts the extension at output 0 with value 0, naming every lockup vin', async () => {
    const swept: FundedOutput[] = [
      { txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 },
      { txid: sourceTx(1, 1505n).id, vout: 1, value: 1505 },
    ]
    const { ctx, registered } = stack({ swept })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    const proof = proofOf(registered)
    const extension = proof.getOutput(0)
    expect(extension.amount).toBe(0n)
    // Never vin 0, which is the toSpend copy the emulator synthesises.
    const packet = Extension.fromBytes(extension.script!).getEmulatorPacket()
    expect(packet?.entries.map((entry) => entry.vin)).toEqual([1, 2])
    expect(packet?.entries.map((entry) => hex.encode(entry.script))).toEqual(
      [1, 2].map(() => hex.encode(swapScript().refundArkadeScript)),
    )
  })

  it('answers each lockup at vin k with the refund at output k, for at least its value', async () => {
    const swept: FundedOutput[] = [
      { txid: sourceTx(0, 5016n).id, vout: 0, value: 5016 },
      { txid: sourceTx(1, 1512n).id, vout: 1, value: 1512 },
      { txid: sourceTx(2, 1976n).id, vout: 2, value: 1976 },
    ]
    const { ctx, registered } = stack({ swept })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    const proof = proofOf(registered)
    // The real coins start at 1, and the covenant at vin k reads output k.
    expect(proof.inputsLength).toBe(swept.length + 1)
    swept.forEach((lockup, index) => {
      const vin = index + 1
      expect(hex.encode(proof.getInput(vin).txid!)).toBe(lockup.txid)
      expect(proof.getInput(vin).index).toBe(lockup.vout)
      const refund = proof.getOutput(vin)
      expect(hex.encode(refund.script!)).toBe(hex.encode(CLIENT_REFUND))
      expect(refund.amount).toBe(BigInt(lockup.value))
    })
    expect(proof.outputsLength).toBe(swept.length + 1)
  })

  it('takes no fee coin and leaves no change when the server prices the intent at zero', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const { ctx, registered } = stack({
      swept,
      floatCoins: [{ txid: sourceTx(9, 50_000n).id, vout: 9, value: 50_000 }],
    })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    const proof = proofOf(registered)
    expect(proof.inputsLength).toBe(2)
    expect(proof.outputsLength).toBe(2)
    expect(ctx.reservations.reserved().size).toBe(0)
  })

  it('appends the fee coin LAST and its change LAST when the server charges per input', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const feeCoin = { txid: sourceTx(9, 50_000n).id, vout: 9, value: 50_000 }
    const { ctx, registered } = stack({ swept, inputFee: 'amount * 0.01', floatCoins: [feeCoin] })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    const proof = proofOf(registered)
    expect(proof.inputsLength).toBe(3)
    expect(hex.encode(proof.getInput(2).txid!)).toBe(feeCoin.txid)
    expect(proof.outputsLength).toBe(3)
    const change = proof.getOutput(2)
    expect(change.amount).toBeLessThan(BigInt(feeCoin.value))
    expect(change.amount).toBeGreaterThanOrEqual(330n)
    // What arkd prices: proof inputs minus outputs. 1% of each input here.
    const fee = BigInt(feeCoin.value) + 1976n - (1976n + change.amount!)
    expect(fee).toBeGreaterThanOrEqual(BigInt(Math.floor(50_000 * 0.01)) + BigInt(Math.floor(1976 * 0.01)))
  })

  it("subscribes to the fee coin's outpoint, the topic arkd routes its connector under", async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const feeCoin = { txid: sourceTx(9, 50_000n).id, vout: 9, value: 50_000 }
    const { ctx, topics } = stack({ swept, inputFee: 'amount * 0.01', floatCoins: [feeCoin] })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    expect(topics.at(-1)).toEqual(expect.arrayContaining([`${swept[0]!.txid}:0`, `${feeCoin.txid}:9`]))
  })

  it('passes over a fee coin a funding pins while the float is being read', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const cheapest = { txid: sourceTx(8, 40_000n).id, vout: 8, value: 40_000 }
    const next = { txid: sourceTx(9, 50_000n).id, vout: 9, value: 50_000 }
    const { ctx, registered } = stack({
      swept,
      inputFee: 'amount * 0.01',
      floatCoins: [cheapest, next],
      duringFloatRead: (reservations) => void reservations.reserve([cheapest]),
    })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    expect(hex.encode(proofOf(registered).getInput(2).txid!)).toBe(next.txid)
  })

  // Mining past an expiry, or a solver idle that long, leaves the whole float swept.
  it('pays the fee from a swept coin of its own when nothing spendable is left', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const sweptFloat = { txid: sourceTx(9, 50_000n).id, vout: 9, value: 50_000, isSwept: true }
    const { ctx, registered } = stack({ swept, inputFee: 'amount * 0.01', floatCoins: [sweptFloat] })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)

    expect(hex.encode(proofOf(registered).getInput(2).txid!)).toBe(sweptFloat.txid)
  })

  it('submits no forfeit for a swept fee coin, which arkd does not ask one for', async () => {
    const submitSignedForfeitTxs = vi.fn(async () => {})
    const handler = sweptRefundBatchHandler({
      intentId: 'intent-1',
      arkProvider: { submitSignedForfeitTxs } as unknown as Parameters<
        typeof sweptRefundBatchHandler
      >[0]['arkProvider'],
      identity,
      session: identity.signerSession(),
      network: { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef } as never,
      recipients: [],
      feeCoin: {
        txid: 'f'.repeat(64),
        vout: 0,
        value: 50_000,
        isSwept: true,
        tapTree: FLOAT_TAPTREE,
        forfeitTapLeafScript: FLOAT_LEAF,
        intentTapLeafScript: FLOAT_LEAF,
      } as never,
    })
    const commitment = sourceTx(0, 1_000n)

    await handler.onBatchFinalization!({ commitmentTx: commitment.b64 } as never, undefined as never, undefined)

    expect(submitSignedForfeitTxs).not.toHaveBeenCalled()
  })

  it('releases the fee coin reservation once the batch is over', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const { ctx } = stack({
      swept,
      inputFee: 'amount * 0.01',
      floatCoins: [{ txid: sourceTx(9, 50_000n).id, vout: 9, value: 50_000 }],
    })

    await refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)
    expect(ctx.reservations.reserved().size).toBe(0)
  })

  it('refuses rather than refunding a swept output that carries an Arkade asset', async () => {
    const swept: FundedOutput[] = [
      { txid: sourceTx(0, 1976n).id, vout: 0, value: 1976, assets: [{ assetId: 'a'.repeat(68), amount: 5n }] },
    ]
    const { ctx } = stack({ swept })

    await expect(refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)).rejects.toThrow(
      /carrying Arkade assets/,
    )
  })

  it('refuses when no float coin can pay the fee and still leave dust', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const { ctx } = stack({
      swept,
      inputFee: 'amount * 0.01',
      floatCoins: [{ txid: sourceTx(9, 340n).id, vout: 9, value: 340 }],
    })

    await expect(refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)).rejects.toThrow(
      /no sats-only float coin can pay the intent fee/,
    )
  })

  it('registers nothing when the emulator answers with a different transaction', async () => {
    const swept: FundedOutput[] = [{ txid: sourceTx(0, 1976n).id, vout: 0, value: 1976 }]
    const { ctx, registered } = stack({ swept })
    // Witnesses cannot change a txid, so any other value is not ours.
    const other = new Transaction({ allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true })
    other.addInput({ txid: 'd'.repeat(64), index: 0, witnessUtxo: { script: CLIENT_REFUND, amount: 10n } })
    other.addOutput({ script: CLIENT_REFUND, amount: 10n })
    submitIntent.mockImplementation(async () => base64.encode(other.toPSBT()))

    await expect(refundSweptSwapScript(ctx, 'http://emulator', swapScript(), swept, CLIENT_REFUND)).rejects.toThrow(
      /emulator returned intent proof/,
    )
    expect(registered).toHaveLength(0)
  })

  it('refuses an empty set rather than registering an intent with no inputs', async () => {
    const { ctx } = stack({ swept: [] })
    await expect(refundSweptSwapScript(ctx, 'http://emulator', swapScript(), [], CLIENT_REFUND)).rejects.toThrow(
      /no swept outputs/,
    )
  })
})
