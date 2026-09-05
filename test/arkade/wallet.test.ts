import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { hex, base64 } from '@scure/base'
import {
  MnemonicIdentity,
  Transaction,
  CSVMultisigTapscript,
  setArkPsbtField,
  getArkPsbtFields,
  asset,
  ConditionWitness,
  Extension,
  PrevArkTxField,
} from '@arkade-os/sdk'
import { CovenantSwapScript, parseAssetId } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { ArkadeContext, FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'

interface AssetGroupView {
  assetId: { toString(): string }
  outputs: { vout: number; amount: bigint | string }[]
}

// refundSwapScript constructs RestEmulatorProvider itself (not injected), so
// the only way to intercept the submitted PSBTs without changing production
// code is a module mock — scoped to this file only.
const submitTx = vi.fn(async (arkTxB64: string, _checkpointsB64: string[]) => ({ signedArkTx: arkTxB64 }))
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>()
  return {
    ...actual,
    RestEmulatorProvider: vi.fn().mockImplementation(() => ({ submitTx })),
  }
})

// Imported AFTER the mock is declared (vi.mock is hoisted above imports by
// vitest, but the module under test still needs to resolve @arkade-os/sdk's
// mocked RestEmulatorProvider at call time, not at this file's own import
// time) — dynamic import keeps that ordering explicit rather than relying on
// hoisting semantics.
const {
  claimSwapScript,
  refundSwapScript,
  refundWithoutReceiverSwapScript,
  findClaimPreimage,
  findLockups,
  findLockupOutpoints,
  lockupProvablySpent,
} = await import('@arkade-os/solver-arkade/arkade/wallet.js')

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const RECEIVER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const receiverIdentity = MnemonicIdentity.fromMnemonic(RECEIVER_MNEMONIC, { isMainnet: false })
const RECEIVER = await receiverIdentity.xOnlyPublicKey()

const SERVER = key(3)
const EMULATOR = key(9)
const CLIENT = key(11)
const DEST = p2tr(key(5))
const RECEIVER_PAYOUT = p2tr(key(13))
const PREIMAGE_HASH = ripemd160(sha256(new Uint8Array(32).fill(7)))
const REFUND_LOCKTIME = 1_800_000_000
const CLAIM_DELAY = 512
const CLIENT_REFUND_DELAY = 6144
const REFUND_WITHOUT_SERVER_DELAY = 5120

/** Renamed from `baseScript`: there is one script shape now, not two. */
const baseScript = () =>
  new CovenantSwapScript({
    receiver: RECEIVER,
    server: SERVER,
    preimageHash: PREIMAGE_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: CLAIM_DELAY,
    client: CLIENT,
    clientRefundDelay: CLIENT_REFUND_DELAY,
    refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
    nonInteractiveParameters: {
      emulatorPubkey: EMULATOR,
      receiverPkScript: RECEIVER_PAYOUT,
      senderPkScript: DEST,
    },
  })

const extendedScript = () =>
  new CovenantSwapScript({
    receiver: RECEIVER,
    server: SERVER,
    preimageHash: PREIMAGE_HASH,
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: CLAIM_DELAY,
    client: CLIENT,
    clientRefundDelay: CLIENT_REFUND_DELAY,
    refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
    nonInteractiveParameters: {
      emulatorPubkey: EMULATOR,
      receiverPkScript: RECEIVER_PAYOUT,
      senderPkScript: DEST,
    },
  })

const buildFundingTx = (
  outputs: { script: Uint8Array; amount: bigint }[],
): { id: string; b64: string; bytes: Uint8Array } => {
  const tx = new Transaction({ allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true })
  tx.addInput({ txid: 'c'.repeat(64), index: 0, witnessUtxo: { script: DEST, amount: 100_000n } })
  for (const output of outputs) tx.addOutput(output)
  return { id: tx.id, b64: base64.encode(tx.toPSBT()), bytes: tx.toBytes(true) }
}

const FUNDING = buildFundingTx([{ script: DEST, amount: 50_000n }])
const FUNDED: FundedOutput[] = [{ txid: FUNDING.id, vout: 0, value: 50_000 }]

// A minimal but real serverUnrollScript — buildOffchainTx only needs a
// well-formed CSVMultisigTapscript, not the actual connected server's.
const serverUnrollScript = CSVMultisigTapscript.encode({
  timelock: { type: 'seconds', value: 512n },
  pubkeys: [SERVER],
})

const ctx = (virtualTxs: Record<string, string> = { [FUNDING.id]: FUNDING.b64 }): ArkadeContext =>
  ({
    identity: receiverIdentity,
    wallet: {
      serverUnrollScript,
      indexerProvider: {
        getVirtualTxs: vi.fn(async (txids: string[]) => ({
          txs: txids.map((id) => virtualTxs[id]).filter((tx): tx is string => tx !== undefined),
        })),
      },
    } as unknown as ArkadeContext['wallet'],
  }) as ArkadeContext

describe('refundSwapScript', () => {
  it('does not throw on the base program leaf, where the receiver is not a signer', async () => {
    submitTx.mockClear()
    await expect(refundSwapScript(ctx(), 'http://emulator.test', baseScript(), FUNDED, DEST)).resolves.toBeTruthy()
    expect(submitTx).toHaveBeenCalledOnce()
  })

  it('signs the checkpoint on the extended leaf, where the receiver IS a signer', async () => {
    submitTx.mockClear()
    await refundSwapScript(ctx(), 'http://emulator.test', extendedScript(), FUNDED, DEST)
    expect(submitTx).toHaveBeenCalledOnce()
    const [, checkpointsB64] = submitTx.mock.calls[0] as [string, string[]]
    const checkpoint = Transaction.fromPSBT(base64.decode(checkpointsB64[0]!))
    const input = checkpoint.getInput(0)
    // A real schnorr signature was attached for the receiver's own leaf —
    // this is the property the checkpoint-signing bug broke: it either threw
    // before reaching here, or (pre-fix, on a broken submit path) left this
    // empty because signing was skipped entirely.
    expect(input.tapScriptSig).toBeDefined()
    expect(input.tapScriptSig!.length).toBeGreaterThan(0)
    const [sigKey, sig] = input.tapScriptSig![0]!
    expect(hex.encode(sigKey.pubKey)).toBe(hex.encode(RECEIVER))
    expect(sig.length).toBeGreaterThanOrEqual(64)
  })

  it('rejects when there is nothing funded to refund', async () => {
    await expect(refundSwapScript(ctx(), 'http://emulator.test', baseScript(), [], DEST)).rejects.toThrow(
      /nothing to refund/,
    )
  })

  it('attaches each input funding virtual tx as a PrevArkTx field, on the input it funds', async () => {
    submitTx.mockClear()
    const script = extendedScript()
    const fundingA = buildFundingTx([{ script: script.pkScript, amount: 50_000n }])
    const fundingB = buildFundingTx([
      { script: DEST, amount: 1_000n },
      { script: script.pkScript, amount: 30_000n },
    ])
    const funded: FundedOutput[] = [
      { txid: fundingA.id, vout: 0, value: 50_000 },
      { txid: fundingB.id, vout: 1, value: 30_000 },
    ]
    await refundSwapScript(
      ctx({ [fundingA.id]: fundingA.b64, [fundingB.id]: fundingB.b64 }),
      'http://emulator.test',
      script,
      funded,
      DEST,
    )
    const [arkTxB64] = submitTx.mock.calls[0] as [string, string[]]
    const arkTx = Transaction.fromPSBT(base64.decode(arkTxB64))
    const fieldsA = getArkPsbtFields(arkTx, 0, PrevArkTxField)
    const fieldsB = getArkPsbtFields(arkTx, 1, PrevArkTxField)
    expect(fieldsA).toHaveLength(1)
    expect(hex.encode(fieldsA[0]!)).toBe(hex.encode(fundingA.bytes))
    expect(fieldsB).toHaveLength(1)
    expect(hex.encode(fieldsB[0]!)).toBe(hex.encode(fundingB.bytes))
  })

  it('refuses to submit when the indexer cannot produce a funding tx the emulator will demand', async () => {
    submitTx.mockClear()
    await expect(refundSwapScript(ctx({}), 'http://emulator.test', baseScript(), FUNDED, DEST)).rejects.toThrow(
      /virtual tx/,
    )
    expect(submitTx).not.toHaveBeenCalled()
  })
})

describe('refundWithoutReceiverSwapScript', () => {
  // The RECEIVE-leg role assignment, modelled honestly: WE are the covenant's
  // `client` (the solver funds the lockup and is the one owed the refund) and
  // the trader — whose key we do not hold — is `receiver`. That is exactly the
  // shape in which `refundSwapScript`'s leaf is unspendable by us.
  const receiveLegScript = () =>
    new CovenantSwapScript({
      receiver: key(2),
      server: SERVER,
      preimageHash: PREIMAGE_HASH,
      refundLocktime: REFUND_LOCKTIME,
      claimDelay: CLAIM_DELAY,
      client: RECEIVER,
      clientRefundDelay: CLIENT_REFUND_DELAY,
      refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
      nonInteractiveParameters: {
        emulatorPubkey: EMULATOR,
        receiverPkScript: RECEIVER_PAYOUT,
        senderPkScript: DEST,
      },
    })

  const arkSubmitTx = vi.fn(async (_arkTxB64: string, checkpointsB64: string[]) => ({
    arkTxid: 'a'.repeat(64),
    signedCheckpointTxs: checkpointsB64,
  }))
  const arkFinalizeTx = vi.fn(async () => undefined)
  const arkCtx = (): ArkadeContext =>
    ({
      identity: receiverIdentity,
      wallet: { serverUnrollScript, arkProvider: { submitTx: arkSubmitTx, finalizeTx: arkFinalizeTx } },
    }) as unknown as ArkadeContext

  it('spends the refundWithoutReceiver leaf, not the receiver-dependent refund leaf', async () => {
    arkSubmitTx.mockClear()
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), FUNDED, DEST)
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    const leaf = Transaction.fromPSBT(base64.decode(arkTxB64)).getInput(0).tapLeafScript!
    // A PSBT's tapLeafScript entry is `script || leafVersion`, so drop the
    // trailing version byte (0xc0) before comparing against the raw script.
    // This is the assertion that fails if the wiring ever falls back to
    // `script.refund()` — it compares the leaf actually committed to.
    const committed = hex.encode(leaf[0]![1])
    expect(committed.slice(-2)).toBe('c0')
    expect(committed.slice(0, -2)).toBe(receiveLegScript().refundWithoutReceiverScript)
  })

  it('never contacts the emulator: this leaf carries no covenant to co-sign', async () => {
    submitTx.mockClear()
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), FUNDED, DEST)
    expect(submitTx).not.toHaveBeenCalled()
  })

  it('sets the transaction locktime to refundLocktime so the CLTV is enforced', async () => {
    arkSubmitTx.mockClear()
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), FUNDED, DEST)
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    expect(Transaction.fromPSBT(base64.decode(arkTxB64)).lockTime).toBe(REFUND_LOCKTIME)
  })

  it('rejects when there is nothing funded to refund', async () => {
    await expect(refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), [], DEST)).rejects.toThrow(
      /nothing to refund/,
    )
  })
})

/** Refunding an ASSET-carrying lockup. `buildOffchainTx` outputs are sats alone,
 *  so nothing in a sats-only test notices a missing packet. */
describe('refunding an asset-carrying lockup', () => {
  const ASSET_A = 'ab'.repeat(32) + '0100'
  const ASSET_B = 'cd'.repeat(32) + '0000'

  const packetOn = (arkTxB64: string) => {
    const tx = Transaction.fromPSBT(base64.decode(arkTxB64))
    return Extension.fromTx(tx).getPacketByType(asset.Packet.PACKET_TYPE)
  }

  /** Every group's `(assetId, output index, amount)`. */
  const allocations = (packet: ReturnType<typeof packetOn>) =>
    (packet as unknown as { groups: AssetGroupView[] }).groups.flatMap((group) =>
      group.outputs.map((entry) => ({
        assetId: group.assetId.toString(),
        vout: entry.vout,
        amount: BigInt(entry.amount),
      })),
    )

  const receiveLegScript = () =>
    new CovenantSwapScript({
      receiver: key(2),
      server: SERVER,
      preimageHash: PREIMAGE_HASH,
      refundLocktime: REFUND_LOCKTIME,
      claimDelay: CLAIM_DELAY,
      client: RECEIVER,
      clientRefundDelay: CLIENT_REFUND_DELAY,
      refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
      nonInteractiveParameters: {
        emulatorPubkey: EMULATOR,
        receiverPkScript: RECEIVER_PAYOUT,
        senderPkScript: DEST,
      },
      asset: parseAssetId(ASSET_A),
    })

  const arkSubmitTx = vi.fn(async (_arkTxB64: string, checkpointsB64: string[]) => ({
    arkTxid: 'a'.repeat(64),
    signedCheckpointTxs: checkpointsB64,
  }))
  const arkCtx = (): ArkadeContext =>
    ({
      identity: receiverIdentity,
      wallet: {
        serverUnrollScript,
        arkProvider: { submitTx: arkSubmitTx, finalizeTx: vi.fn(async () => undefined) },
        indexerProvider: {
          getVirtualTxs: vi.fn(async (txids: string[]) => ({ txs: txids.map(() => FUNDING.b64) })),
        },
      },
    }) as unknown as ArkadeContext

  it('routes the whole carried amount to the refund destination', async () => {
    arkSubmitTx.mockClear()
    const funded: FundedOutput[] = [{ ...FUNDED[0]!, assets: [{ assetId: ASSET_A, amount: 500n }] }]
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), funded, DEST)
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    expect(allocations(packetOn(arkTxB64))).toEqual([{ assetId: ASSET_A, vout: 0, amount: 500n }])
  })

  it('sums a lockup funded by more than one payment onto the single aggregate output', async () => {
    arkSubmitTx.mockClear()
    const funded: FundedOutput[] = [
      { ...FUNDED[0]!, assets: [{ assetId: ASSET_A, amount: 500n }] },
      { txid: FUNDING.id, vout: 1, value: 1_000, assets: [{ assetId: ASSET_A, amount: 250n }] },
    ]
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), funded, DEST)
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    expect(allocations(packetOn(arkTxB64))).toEqual([{ assetId: ASSET_A, vout: 0, amount: 750n }])
  })

  it('declares EVERY asset the lockup carries, not only the one it is denominated in', async () => {
    // An undeclared stray is answered with ASSET_NOT_FOUND, taking the refund down.
    arkSubmitTx.mockClear()
    const funded: FundedOutput[] = [
      {
        ...FUNDED[0]!,
        assets: [
          { assetId: ASSET_A, amount: 500n },
          { assetId: ASSET_B, amount: 7n },
        ],
      },
    ]
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), funded, DEST)
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    expect(allocations(packetOn(arkTxB64))).toEqual(
      expect.arrayContaining([
        { assetId: ASSET_A, vout: 0, amount: 500n },
        { assetId: ASSET_B, vout: 0, amount: 7n },
      ]),
    )
  })

  it('attaches no packet at all when the lockup carries no asset', async () => {
    arkSubmitTx.mockClear()
    await refundWithoutReceiverSwapScript(arkCtx(), receiveLegScript(), FUNDED, DEST)
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    expect(() => Extension.fromTx(Transaction.fromPSBT(base64.decode(arkTxB64)))).toThrow()
  })

  it('keeps the covenant refund index-aligned: input i’s asset lands on output i', async () => {
    submitTx.mockClear()
    const script = receiveLegScript()
    const funded: FundedOutput[] = [
      { txid: FUNDING.id, vout: 0, value: 50_000, assets: [{ assetId: ASSET_A, amount: 500n }] },
      { txid: FUNDING.id, vout: 1, value: 30_000, assets: [{ assetId: ASSET_A, amount: 250n }] },
    ]
    await refundSwapScript(ctx(), 'http://emulator.test', script, funded, DEST)
    const [arkTxB64] = submitTx.mock.calls[0] as [string, string[]]
    expect(allocations(packetOn(arkTxB64))).toEqual([
      { assetId: ASSET_A, vout: 0, amount: 500n },
      { assetId: ASSET_A, vout: 1, amount: 250n },
    ])
  })

  it('holds that alignment when only ONE of the inputs carries an asset', async () => {
    // A sats-only input still owns an output: if the positional counter did not
    // advance across it, input 1's asset would land on output 0.
    const carrying = (vout: number): FundedOutput => ({
      txid: FUNDING.id,
      vout,
      value: 50_000,
      assets: [{ assetId: ASSET_A, amount: 500n }],
    })
    const satsOnly = (vout: number): FundedOutput => ({ txid: FUNDING.id, vout, value: 30_000 })
    const arrangements: [FundedOutput[], number][] = [
      [[carrying(0), satsOnly(1)], 0],
      [[satsOnly(0), carrying(1)], 1],
    ]
    for (const [funded, vout] of arrangements) {
      submitTx.mockClear()
      await refundSwapScript(ctx(), 'http://emulator.test', receiveLegScript(), funded, DEST)
      const [arkTxB64] = submitTx.mock.calls[0] as [string, string[]]
      expect(allocations(packetOn(arkTxB64))).toEqual([{ assetId: ASSET_A, vout, amount: 500n }])
    }
  })

  it('refuses an index-aligned refund of an input carrying two assets', async () => {
    // Unsatisfiable, and the emulator would report only `OP_VERIFY failed`.
    const funded: FundedOutput[] = [
      {
        ...FUNDED[0]!,
        assets: [
          { assetId: ASSET_A, amount: 500n },
          { assetId: ASSET_B, amount: 7n },
        ],
      },
    ]
    await expect(refundSwapScript(ctx(), 'http://emulator.test', receiveLegScript(), funded, DEST)).rejects.toThrow(
      /exactly one asset/,
    )
  })

  /**
   * The CLAIM side of the same gap, and the one `arkade:<asset>->lightning:BTC`
   * settles on: the solver pays the invoice and then claims the client's asset
   * lockup. With no packet arkd answers `no asset packet` — and by then the
   * sats have already left.
   */
  describe('claiming an asset-carrying lockup', () => {
    const PREIMAGE = new Uint8Array(32).fill(7)

    // Returns the txid `assertSubmittedArkTxid` demands, so the guard the claim
    // path runs against a hostile server is exercised rather than stubbed away.
    const claimSubmitTx = vi.fn(async (arkTxB64: string, checkpointsB64: string[]) => ({
      arkTxid: Transaction.fromPSBT(base64.decode(arkTxB64)).id,
      signedCheckpointTxs: checkpointsB64,
    }))
    const claimCtx = (): ArkadeContext =>
      ({
        identity: receiverIdentity,
        wallet: {
          serverUnrollScript,
          arkProvider: { submitTx: claimSubmitTx, finalizeTx: vi.fn(async () => undefined) },
        },
      }) as unknown as ArkadeContext

    /** The claim leaf needs the RECEIVER's key, so these are the send leg's roles. */
    const sendLegScript = () =>
      new CovenantSwapScript({
        receiver: RECEIVER,
        server: SERVER,
        preimageHash: PREIMAGE_HASH,
        refundLocktime: REFUND_LOCKTIME,
        claimDelay: CLAIM_DELAY,
        client: CLIENT,
        clientRefundDelay: CLIENT_REFUND_DELAY,
        refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
        nonInteractiveParameters: {
          emulatorPubkey: EMULATOR,
          receiverPkScript: RECEIVER_PAYOUT,
          senderPkScript: DEST,
        },
        asset: parseAssetId(ASSET_A),
      })

    const DEST_ADDRESS = baseScript().address('tark', SERVER).encode()

    it('routes the whole carried amount to the claim destination', async () => {
      claimSubmitTx.mockClear()
      const funded: FundedOutput[] = [{ ...FUNDED[0]!, assets: [{ assetId: ASSET_A, amount: 500n }] }]
      await claimSwapScript(claimCtx(), sendLegScript(), funded, PREIMAGE, DEST_ADDRESS)
      const [arkTxB64] = claimSubmitTx.mock.calls[0] as [string, string[]]
      expect(allocations(packetOn(arkTxB64))).toEqual([{ assetId: ASSET_A, vout: 0, amount: 500n }])
    })

    it('sums a lockup funded by more than one payment onto the single claim output', async () => {
      claimSubmitTx.mockClear()
      const funded: FundedOutput[] = [
        { ...FUNDED[0]!, assets: [{ assetId: ASSET_A, amount: 500n }] },
        { txid: FUNDING.id, vout: 1, value: 1_000, assets: [{ assetId: ASSET_A, amount: 250n }] },
      ]
      await claimSwapScript(claimCtx(), sendLegScript(), funded, PREIMAGE, DEST_ADDRESS)
      const [arkTxB64] = claimSubmitTx.mock.calls[0] as [string, string[]]
      expect(allocations(packetOn(arkTxB64))).toEqual([{ assetId: ASSET_A, vout: 0, amount: 750n }])
    })

    it('declares a stray asset alongside the denominating one', async () => {
      claimSubmitTx.mockClear()
      const funded: FundedOutput[] = [
        {
          ...FUNDED[0]!,
          assets: [
            { assetId: ASSET_A, amount: 500n },
            { assetId: ASSET_B, amount: 7n },
          ],
        },
      ]
      await claimSwapScript(claimCtx(), sendLegScript(), funded, PREIMAGE, DEST_ADDRESS)
      const [arkTxB64] = claimSubmitTx.mock.calls[0] as [string, string[]]
      expect(allocations(packetOn(arkTxB64))).toEqual(
        expect.arrayContaining([
          { assetId: ASSET_A, vout: 0, amount: 500n },
          { assetId: ASSET_B, vout: 0, amount: 7n },
        ]),
      )
    })

    /** The regression that matters most: every existing sats lockup is untouched. */
    it('attaches no packet at all when the lockup carries no asset', async () => {
      claimSubmitTx.mockClear()
      await claimSwapScript(claimCtx(), sendLegScript(), FUNDED, PREIMAGE, DEST_ADDRESS)
      const [arkTxB64] = claimSubmitTx.mock.calls[0] as [string, string[]]
      expect(() => Extension.fromTx(Transaction.fromPSBT(base64.decode(arkTxB64)))).toThrow()
    })
  })
})

describe('findLockups', () => {
  const lockupCtx = (vtxos: unknown[]): ArkadeContext =>
    ({
      wallet: {
        indexerProvider: { getVtxos: vi.fn(async () => ({ vtxos, page: { current: 0, total: 1 } })) },
      },
    }) as unknown as ArkadeContext

  it('reports the assets an output carries, as bigints', async () => {
    const found = await findLockups(
      lockupCtx([{ txid: 'd'.repeat(64), vout: 0, value: '50000', assets: [{ assetId: 'ab', amount: '500' }] }]),
      'aa',
    )
    expect(found).toEqual([{ txid: 'd'.repeat(64), vout: 0, value: 50_000, assets: [{ assetId: 'ab', amount: 500n }] }])
  })

  it('carries an amount larger than a double can hold, without rounding it', async () => {
    // Through a `number` this comes back as ...992 and the refund under-declares.
    const huge = '9007199254740993'
    const found = await findLockups(
      lockupCtx([{ txid: 'd'.repeat(64), vout: 0, value: '330', assets: [{ assetId: 'ab', amount: huge }] }]),
      'aa',
    )
    expect(found[0]!.assets![0]!.amount).toBe(BigInt(huge))
  })

  it('leaves a sats-only output with no assets field', async () => {
    const found = await findLockups(lockupCtx([{ txid: 'd'.repeat(64), vout: 0, value: '50000' }]), 'aa')
    expect(found[0]!.assets).toBeUndefined()
  })
})

describe('findClaimPreimage', () => {
  const OUTPOINT = { txid: 'a'.repeat(64), vout: 0 }
  const SPEND_TXID = 'b'.repeat(64)
  const PREIMAGE = new Uint8Array(32).fill(9)
  const PAYMENT_HASH = hex.encode(sha256(PREIMAGE))
  const WRONG_PREIMAGE = new Uint8Array(32).fill(0xee)

  /**
   * A spend transaction for OUTPOINT, base64-PSBT-encoded exactly like a real
   * `getVirtualTxs` response (proven against the real SDK in wallet.ts's own
   * `refundSwapScript`/`claimSwapScript`: `Transaction.fromPSBT(base64.decode(...))`
   * with no options — see also the `getVirtualTxs` implementation these
   * fixtures mirror, which does the identical round trip internally).
   *
   * `matchingInputIndex` lets a test put OUR outpoint at a non-zero index,
   * proving the reader searches for the right input rather than assuming 0.
   */
  const buildSpendTxB64 = (opts: {
    spends?: { txid: string; vout: number }
    matchingInputIndex?: number
    conditionWitness?: Uint8Array[]
    finalScriptWitness?: Uint8Array[]
  }): string => {
    const spends = opts.spends ?? OUTPOINT
    const matchingInputIndex = opts.matchingInputIndex ?? 0
    const tx = new Transaction({ allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true })
    for (let i = 0; i <= matchingInputIndex; i++) {
      const txid = i === matchingInputIndex ? spends.txid : 'c'.repeat(64)
      const index = i === matchingInputIndex ? spends.vout : 0
      tx.addInput({
        txid,
        index,
        witnessUtxo: { script: DEST, amount: 50_000n },
      })
    }
    tx.addOutput({ script: DEST, amount: 49_000n })
    if (opts.conditionWitness) setArkPsbtField(tx, matchingInputIndex, ConditionWitness, opts.conditionWitness)
    if (opts.finalScriptWitness) {
      tx.updateInput(matchingInputIndex, { finalScriptWitness: opts.finalScriptWitness }, true)
    }
    return base64.encode(tx.toPSBT())
  }

  /** A fake indexerProvider — getVtxos/getVirtualTxs are the only two calls findClaimPreimage makes. */
  const indexerCtx = (opts: {
    spentBy?: string
    virtualTxs?: Record<string, string>
    getVtxos?: ReturnType<typeof vi.fn>
  }): ArkadeContext =>
    ({
      wallet: {
        indexerProvider: {
          getVtxos:
            opts.getVtxos ??
            vi.fn(async () => ({
              vtxos:
                opts.spentBy === undefined
                  ? []
                  : [{ txid: OUTPOINT.txid, vout: OUTPOINT.vout, value: 50_000, status: {}, spentBy: opts.spentBy }],
            })),
          getVirtualTxs: vi.fn(async (txids: string[]) => ({
            txs: txids.map((id) => opts.virtualTxs?.[id]).filter((tx): tx is string => tx !== undefined),
          })),
        },
      } as unknown as ArkadeContext['wallet'],
    }) as ArkadeContext

  it('returns null when the outpoint has not been spent yet', async () => {
    const ctx = indexerCtx({ spentBy: '' })
    await expect(findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)).resolves.toBeNull()
  })

  it('returns null when the indexer has no record of the outpoint at all', async () => {
    const ctx = indexerCtx({})
    await expect(findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)).resolves.toBeNull()
  })

  it('reads a spend named only by settledBy, which spentBy alone would miss', async () => {
    // The SDK's own `hasTerminalSpend` documents that the wire contract permits
    // `isSpent: true` with an EMPTY `spentBy` — so a reader that consults only
    // that field can look straight past a claim that really landed, and never
    // learn `P` for it. Union both, and this resolves.
    const spendTx = buildSpendTxB64({ conditionWitness: [PREIMAGE] })
    const ctx = {
      wallet: {
        indexerProvider: {
          getVtxos: vi.fn(async () => ({
            vtxos: [
              {
                txid: OUTPOINT.txid,
                vout: OUTPOINT.vout,
                value: 50_000,
                status: {},
                isSpent: true,
                spentBy: '',
                settledBy: SPEND_TXID,
              },
            ],
          })),
          getVirtualTxs: vi.fn(async () => ({ txs: [spendTx] })),
        },
      } as unknown as ArkadeContext['wallet'],
    } as ArkadeContext
    await expect(findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)).resolves.toEqual(PREIMAGE)
  })

  it('reads the preimage from the ConditionWitness field of the transaction that spent the outpoint', async () => {
    const spendTx = buildSpendTxB64({ conditionWitness: [PREIMAGE] })
    const ctx = indexerCtx({ spentBy: SPEND_TXID, virtualTxs: { [SPEND_TXID]: spendTx } })
    const found = await findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)
    expect(found).toEqual(PREIMAGE)
  })

  it('finds the right input by outpoint, not by assuming index 0', async () => {
    const spendTx = buildSpendTxB64({ matchingInputIndex: 2, conditionWitness: [PREIMAGE] })
    const ctx = indexerCtx({ spentBy: SPEND_TXID, virtualTxs: { [SPEND_TXID]: spendTx } })
    const found = await findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)
    expect(found).toEqual(PREIMAGE)
  })

  it('falls back to the finalized witness stack when there is no ConditionWitness field', async () => {
    // A signature-shaped decoy plus the real preimage, out of order — the
    // reader must not assume a fixed stack position, only verify by hash.
    const decoySignature = new Uint8Array(64).fill(0x42)
    const spendTx = buildSpendTxB64({ finalScriptWitness: [decoySignature, PREIMAGE] })
    const ctx = indexerCtx({ spentBy: SPEND_TXID, virtualTxs: { [SPEND_TXID]: spendTx } })
    const found = await findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)
    expect(found).toEqual(PREIMAGE)
  })

  it('never returns a candidate that does not hash to the expected payment hash', async () => {
    // The spend is real and the field is populated, but with something that
    // is NOT our preimage — must not be trusted just because it was found in
    // the right place.
    const spendTx = buildSpendTxB64({ conditionWitness: [WRONG_PREIMAGE] })
    const ctx = indexerCtx({ spentBy: SPEND_TXID, virtualTxs: { [SPEND_TXID]: spendTx } })
    await expect(findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)).resolves.toBeNull()
  })

  it('returns null when the spending tx is reported but the indexer cannot produce it', async () => {
    const ctx = indexerCtx({ spentBy: SPEND_TXID, virtualTxs: {} })
    await expect(findClaimPreimage(ctx, [OUTPOINT], PAYMENT_HASH)).resolves.toBeNull()
  })

  it('checks every outpoint given in one batch, mirroring findLockups checking every output', async () => {
    // Mirrors a multi-output lockup: OUTPOINT is still sitting there unspent,
    // `other` is the one covclaimd actually claimed. The reader must find the
    // preimage via `other` rather than stopping after OUTPOINT looks empty.
    const other = { txid: 'd'.repeat(64), vout: 1 }
    const spendTxForOther = buildSpendTxB64({ spends: other, conditionWitness: [PREIMAGE] })
    const getVtxos = vi.fn(async ({ outpoints }: { outpoints: { txid: string; vout: number }[] }) => ({
      vtxos: outpoints.map((o) =>
        o.txid === other.txid
          ? { txid: o.txid, vout: o.vout, value: 1_000, status: {}, spentBy: SPEND_TXID }
          : { txid: o.txid, vout: o.vout, value: 50_000, status: {}, spentBy: '' },
      ),
    }))
    const ctx = indexerCtx({ getVtxos, virtualTxs: { [SPEND_TXID]: spendTxForOther } })
    const found = await findClaimPreimage(ctx, [OUTPOINT, other], PAYMENT_HASH)
    expect(found).toEqual(PREIMAGE)
    expect(getVtxos).toHaveBeenCalledWith({ outpoints: [OUTPOINT, other] })
  })
})

describe('findLockupOutpoints', () => {
  const SPENT = { txid: 'a'.repeat(64), vout: 0, value: 50_000, spent: true }
  const UNSPENT = { txid: 'b'.repeat(64), vout: 3, value: 1_000, spent: false }

  const ctxReturning = (vtxos: unknown[]): ArkadeContext =>
    ({
      wallet: { indexerProvider: { getVtxos: vi.fn(async () => ({ vtxos })) } } as unknown as ArkadeContext['wallet'],
    }) as ArkadeContext

  it('reports SPENT outpoints too — the whole reason it exists next to findLockups', async () => {
    // findLockups passes spendableOnly and so goes empty the moment a claim
    // lands; this must still hand back the outpoint findClaimPreimage needs in
    // order to look up what did the claiming.
    const ctx = ctxReturning([
      { txid: SPENT.txid, vout: SPENT.vout, value: SPENT.value, isSpent: true, spentBy: 'c'.repeat(64) },
      { txid: UNSPENT.txid, vout: UNSPENT.vout, value: UNSPENT.value, isSpent: false, spentBy: '' },
    ])
    await expect(findLockupOutpoints(ctx, 'aa'.repeat(17))).resolves.toEqual([SPENT, UNSPENT])
  })

  it('carries the VALUE and the spend fact, not just the outpoint', async () => {
    // The Lightning receive leg funds its own lockup and decides whether to
    // fund by comparing this value against the row's payout — an outpoint
    // alone cannot tell its own funding from a stray dust payment to a public
    // address. `spent` is `hasTerminalSpend`, so `isSpent: true` with an empty
    // `spentBy` (which the wire contract permits) still reads as spent.
    const ctx = ctxReturning([
      { txid: SPENT.txid, vout: 0, value: 4_900, isSpent: true, spentBy: '', settledBy: '' },
      { txid: UNSPENT.txid, vout: 1, value: 10, isSpent: false, spentBy: '', settledBy: '' },
    ])
    await expect(findLockupOutpoints(ctx, 'aa'.repeat(17))).resolves.toEqual([
      { txid: SPENT.txid, vout: 0, value: 4_900, spent: true },
      { txid: UNSPENT.txid, vout: 1, value: 10, spent: false },
    ])
  })

  it('asks the indexer without the spendable filter', async () => {
    const getVtxos = vi.fn(async () => ({ vtxos: [] }))
    const ctx = { wallet: { indexerProvider: { getVtxos } } as unknown as ArkadeContext['wallet'] } as ArkadeContext
    await findLockupOutpoints(ctx, 'bb'.repeat(17))
    // spendableOnly absent, not merely false: passing it at all would reinstate
    // exactly the filtering this function exists to avoid.
    expect(getVtxos).toHaveBeenCalledWith({ scripts: ['bb'.repeat(17)], pageIndex: 0, pageSize: 500 })
  })

  it('walks every page — a truncated first page would undercount the lockup', async () => {
    // Same reasoning findLockups documents, and now load-bearing here too: the
    // funding decision compares VALUES, so an outpoint stranded on page two is
    // an outpoint this leg would fund a second time.
    const getVtxos = vi.fn(async ({ pageIndex }: { pageIndex: number }) =>
      pageIndex === 0
        ? {
            vtxos: [{ txid: SPENT.txid, vout: 0, value: 4_900, isSpent: true, spentBy: 'c'.repeat(64) }],
            page: { current: 0, total: 2 },
          }
        : {
            vtxos: [{ txid: UNSPENT.txid, vout: 1, value: 4_900, isSpent: false, spentBy: '' }],
            page: { current: 1, total: 2 },
          },
    )
    const ctx = { wallet: { indexerProvider: { getVtxos } } as unknown as ArkadeContext['wallet'] } as ArkadeContext
    await expect(findLockupOutpoints(ctx, 'dd'.repeat(17))).resolves.toEqual([
      { txid: SPENT.txid, vout: 0, value: 4_900, spent: true },
      { txid: UNSPENT.txid, vout: 1, value: 4_900, spent: false },
    ])
    expect(getVtxos).toHaveBeenCalledTimes(2)
  })

  it('returns an empty list for a script the indexer knows nothing about', async () => {
    await expect(findLockupOutpoints(ctxReturning([]), 'cc'.repeat(17))).resolves.toEqual([])
  })
})

describe('lockupProvablySpent', () => {
  // The module mock at the top of this file spreads `...actual`, so the
  // `hasTerminalSpend` these exercise is the REAL SDK predicate, not a stub.
  // That is the point: this is the SDK boundary, and the whole safety argument
  // for writing a permanent `refund_outcome: 'external'` rests on what that
  // predicate does with the fixtures below.
  const SCRIPT = 'ab'.repeat(17)

  const ctxReturning = (vtxos: unknown[]): ArkadeContext =>
    ({
      wallet: { indexerProvider: { getVtxos: vi.fn(async () => ({ vtxos })) } } as unknown as ArkadeContext['wallet'],
    }) as ArkadeContext

  /** An indexer row in the shape `getVtxos` returns, with every spend fact stated explicitly. */
  const vtxo = (facts: { isSwept?: boolean; isSpent?: boolean; spentBy?: string; settledBy?: string }) => ({
    txid: 'a'.repeat(64),
    vout: 0,
    value: 50_000,
    isSwept: facts.isSwept ?? false,
    isSpent: facts.isSpent ?? false,
    spentBy: facts.spentBy ?? '',
    settledBy: facts.settledBy ?? '',
  })

  it('is FALSE for a swept-but-unspent lockup: a batch sweep is not a refund', async () => {
    // The case this function exists to get right. The server sweeping the batch
    // this lockup sat in empties the spendable view exactly like a real spend
    // does, but nobody took the money — so answering true here would report a
    // refund the client never received, permanently, via a `refund_outcome`
    // write that `findRefundable` then filters out forever.
    //
    // Holds because the SDK keeps the two facts separate: `hasTerminalSpend` is
    // `isSpent || spentBy || settledBy` and never consults `isSwept`, which is
    // ORed in explicitly (and only) by `canSpendOffchain`/`canRecoverOnchain`.
    const ctx = ctxReturning([vtxo({ isSwept: true, isSpent: false, spentBy: '', settledBy: '' })])
    await expect(lockupProvablySpent(ctx, SCRIPT)).resolves.toBe(false)
  })

  it('is FALSE when only SOME of the outputs at the script are spent', async () => {
    // A lockup can be more than one output. Part of the money still being
    // spendable means no external party has refunded this row, so `every`
    // rather than `some` is what makes the answer honest.
    const ctx = ctxReturning([
      { ...vtxo({ isSpent: true, spentBy: 'c'.repeat(64) }), vout: 0 },
      { ...vtxo({ isSpent: false }), vout: 1 },
    ])
    await expect(lockupProvablySpent(ctx, SCRIPT)).resolves.toBe(false)
  })

  it('is FALSE for a script the indexer knows nothing about: lag is not proof', async () => {
    // The defect this whole fix is about. An empty read means the indexer has
    // not caught up, NOT that the outputs were spent — `every` on an empty
    // array is vacuously true, so the `all.length > 0` guard is the only thing
    // standing between indexer lag and a permanent wrong outcome.
    await expect(lockupProvablySpent(ctxReturning([]), SCRIPT)).resolves.toBe(false)
  })

  it('is TRUE for isSpent with an empty spentBy, which a bare spentBy check would miss', async () => {
    // The wire contract permits this shape (the SDK documents settlement inputs
    // needing no forfeit as written exactly this way). Reading `spentBy` alone
    // would call a genuinely spent lockup unspent and leave the row retrying a
    // refund forever against money that is already gone.
    const ctx = ctxReturning([vtxo({ isSpent: true, spentBy: '' })])
    await expect(lockupProvablySpent(ctx, SCRIPT)).resolves.toBe(true)
  })

  it('asks the indexer without the spendable filter', async () => {
    // None of the cases above can catch this on their own: the fakes ignore
    // their argument, so a `spendableOnly: true` slipped in here would leave
    // them all green while making the function answer the very question
    // ("what can still be spent") it exists to stop trusting.
    const getVtxos = vi.fn(async () => ({ vtxos: [] }))
    const ctx = { wallet: { indexerProvider: { getVtxos } } as unknown as ArkadeContext['wallet'] } as ArkadeContext
    await lockupProvablySpent(ctx, SCRIPT)
    expect(getVtxos).toHaveBeenCalledWith({ scripts: [SCRIPT] })
  })
})
