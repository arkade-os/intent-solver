/**
 * The asset packet `fulfillOffer` actually submits, read back off the ark tx.
 *
 * These assertions used to hold against this repo's own `buildAssetPacket`.
 * That builder is gone — the spend is the SDK's `fillOffer` now — so they hold
 * against the real thing instead: only the REST providers are stubbed, the
 * Arkade builder runs, and the packet is decoded out of what reached the
 * emulator.
 *
 * The rule they pin is the covenant's: the WANTED asset must be group 0,
 * because the fulfill script's `OP_INSPECTOUTASSETLOOKUP` reads `lookup_index
 * = 0`. Every other asset on every input must still be declared or arkd
 * answers ASSET_NOT_FOUND.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { fulfillOffer, offerInventoryFor } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { sqliteExecutor } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { DirectFillAttempts } from '@arkade-os/solver-arkade/arkade/directFillAttempts.js'
import { createDirectFillRecovery } from '@arkade-os/solver-app/ops/directFillRecovery.js'

const state = vi.hoisted(() => ({
  vtxos: [] as unknown[],
  arkTx: undefined as string | undefined,
  prevTxs: new Map<string, string>(),
  submissions: [] as { arkTx: string; checkpointTxs: string[] }[],
  submissionError: undefined as string | undefined,
  finalized: true,
}))

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@arkade-os/sdk')>()
  const SERVER = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
  return {
    ...mod,
    RestArkProvider: class {
      async getInfo() {
        return {
          signerPubkey: `02${hex.encode(SERVER)}`,
          checkpointTapscript: hex.encode(
            mod.CSVMultisigTapscript.encode({
              timelock: { type: 'blocks', value: 10n },
              pubkeys: [SERVER],
            }).script,
          ),
        }
      }
    },
    RestIndexerProvider: class {
      async getVtxos(options?: { outpoints?: { txid: string; vout: number }[] }) {
        if (options?.outpoints && state.submissions.length) {
          if (!state.finalized) return { vtxos: [] }
          const sent = state.submissions.at(-1)!
          const ark = mod.Transaction.fromPSBT(base64.decode(sent.arkTx))
          const checkpoints = sent.checkpointTxs.map((psbt) => mod.Transaction.fromPSBT(base64.decode(psbt)))
          return {
            vtxos: options.outpoints.flatMap(
              (
                point,
              ): Array<{
                txid: string
                vout: number
                spentBy?: string
                arkTxId?: string
                script?: string
                value?: number
              }> => {
                const index = checkpoints.findIndex((tx) => {
                  const input = tx.getInput(0)
                  return input.txid && hex.encode(input.txid) === point.txid && input.index === point.vout
                })
                if (index >= 0) return [{ ...point, spentBy: checkpoints[index]!.id, arkTxId: ark.id }]
                if (point.txid !== ark.id) return []
                const output = ark.getOutput(point.vout)
                return [{ ...point, script: hex.encode(output.script!), value: Number(output.amount) }]
              },
            ),
          }
        }
        return { vtxos: state.vtxos }
      }
      async getVirtualTxs(txids: string[]) {
        return { txs: txids.map((t) => state.prevTxs.get(t)).filter((p): p is string => p !== undefined) }
      }
    },
    RestEmulatorProvider: class {
      constructor(readonly url: string) {}
      async submitTx(arkTx: string, checkpointTxs: string[]) {
        state.arkTx = arkTx
        state.submissions.push({ arkTx, checkpointTxs })
        for (const raw of [arkTx, ...checkpointTxs]) {
          state.prevTxs.set(mod.Transaction.fromPSBT(base64.decode(raw)).id, raw)
        }
        if (state.submissionError !== undefined) throw new Error(state.submissionError)
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs }
      }
    },
  }
})

const { ArkAddress, Extension, MultisigTapscript, Transaction, VtxoScript, RestIndexerProvider, asset } =
  await import('@arkade-os/sdk')
const { offerContract } = await import('@arkade-os/swap/protocol')
type Offer = import('@arkade-os/swap/protocol').Offer

const SERVER_KEY = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
const MAKER_KEY = '71102fc86b5c576c72f411e083cc03eb83d1b55065406ba2a483208dbb5074ab'
const EMULATOR_KEY = '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27'
const ASSET_A = `${'aa'.repeat(32)}0000`
const ASSET_B = `${'bb'.repeat(32)}0000`

const takerKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x7a))
const identity = { xOnlyPublicKey: async () => takerKey, sign: async (tx: unknown) => tx }

/** Only what `fulfillOffer` and the SDK client below it reach for. `spendable`
 * is what the gate would have handed back, which is the half this repo keeps. */
let database: ReturnType<typeof sqliteExecutor>
const ctx = async (spendable: unknown[]): Promise<ArkadeContext> => {
  const reservations = createReservationLedger()
  const address = new ArkAddress(SERVER_KEY, hex.decode('22'.repeat(32)), 'tark').encode()
  const directFills = await DirectFillAttempts.open(
    database,
    reservations,
    'packet-test-wallet',
    hex.encode(ArkAddress.decode(address).pkScript),
  )
  return {
    wallet: {
      identity,
      arkServerPublicKey: SERVER_KEY,
      indexerProvider: new RestIndexerProvider('http://ark'),
      getSpendableVtxos: async () => spendable,
      getAddress: async () => address,
      getContractManager: async () => null,
    },
    identity,
    reservations,
    directFills,
    dustSats: 330n,
    arkServerUrl: 'http://ark',
  } as unknown as ArkadeContext
}

let minted = 0
const mintCoin = (value: number) => {
  const seed = ++minted
  const key = new Uint8Array([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(seed))])
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: new Uint8Array(32).fill(seed), index: seed, witnessUtxo: { script: key, amount: BigInt(value) } })
  tx.addOutput({ script: key, amount: BigInt(value) })
  state.prevTxs.set(tx.id, base64.encode(tx.toPSBT()))
  return { txid: tx.id, vout: 0, value }
}

const fundingCoin = (value: number, assets?: { assetId: string; amount: bigint }[]) => {
  const vs = new VtxoScript([MultisigTapscript.encode({ pubkeys: [takerKey, SERVER_KEY] }).script])
  // `forfeitTapLeafScript`, not `tapLeafScript`: that is the field a real
  // ExtendedVirtualCoin carries and the one `fulfillOffer` forwards.
  return {
    ...mintCoin(value),
    forfeitTapLeafScript: vs.leaves[0],
    tapTree: vs.encode(),
    ...(assets ? { assets } : {}),
  }
}

const offerFor = (over: Record<string, unknown>): Offer => {
  const terms = {
    wantAmount: 500n,
    makerPkScript: hex.decode(`5120${MAKER_KEY}`),
    makerPublicKey: hex.decode(MAKER_KEY),
    emulatorPubkey: hex.decode(EMULATOR_KEY),
    ...over,
  } as Omit<Offer, 'swapPkScript'>
  return { ...terms, swapPkScript: offerContract(terms, SERVER_KEY).pkScript } as Offer
}

/**
 * Group ids in packet order — the covenant's own requirement.
 *
 * `assetId` is an `asset.AssetId`, not a string: the SDK models it as a class
 * and `toString()` is its canonical hex. Comparing the object would compare
 * identity, which passes or fails for reasons unrelated to the packet.
 */
const groupIds = (packet: unknown): string[] =>
  ((packet as { groups?: { assetId: { toString(): string } }[] }).groups ?? []).map((g) => g.assetId.toString())

/** Decoded once per call site: a second decode of the same tx would report a
 * mismatch as two separate failures. Throws rather than dereferencing an absent
 * tx, so "the fill never reached the emulator" says so. */
const packetGroups = (): string[] => {
  if (state.arkTx === undefined) throw new Error('no ark tx reached the emulator: the fill did not submit')
  return groupIds(Extension.fromTx(Transaction.fromPSBT(base64.decode(state.arkTx))).getAssetPacket())
}

beforeEach(() => {
  database = sqliteExecutor(':memory:')
  state.submissions = []
  state.submissionError = undefined
  state.finalized = true
  state.arkTx = undefined
})
afterEach(() => database.close())

describe('the asset packet fulfillOffer submits', () => {
  const deposit = (assets?: { assetId: string; amount: bigint }[]) => {
    const coin = { ...mintCoin(60_000), ...(assets ? { assets } : {}) }
    state.vtxos = [coin]
    return { txid: coin.txid, vout: coin.vout, value: coin.value }
  }

  it('puts the WANTED asset at group index 0', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coins = [fundingCoin(80_000, [{ assetId: ASSET_A, amount: 600n }])]

    await fulfillOffer(
      await ctx(coins),
      'http://emulator.test',
      offerFor({ wantAsset: asset.AssetId.fromString(ASSET_A) }),
      at,
    )

    const groups = packetGroups()
    expect(groups[0]).toBe(ASSET_A)
    expect(groups).toEqual([ASSET_A, ASSET_B])
  })

  it('hoists the wanted asset even when ONE COIN carries it second', async () => {
    // the tight case: entry order alone cannot hoist it
    state.arkTx = undefined
    const at = deposit()
    const coins = [
      fundingCoin(80_000, [
        { assetId: ASSET_B, amount: 7n },
        { assetId: ASSET_A, amount: 500n },
      ]),
    ]

    await fulfillOffer(
      await ctx(coins),
      'http://emulator.test',
      offerFor({ wantAsset: asset.AssetId.fromString(ASSET_A) }),
      at,
    )

    expect(packetGroups()).toEqual([ASSET_A, ASSET_B])
  })

  it('routes a deposit asset to the taker when the maker wants sats', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])

    await fulfillOffer(
      await ctx([fundingCoin(80_000)]),
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
    )

    expect(packetGroups()).toEqual([ASSET_B])
  })

  const lostReplyFill = async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coins = [fundingCoin(20_000), fundingCoin(30_000)]
    const context = await ctx(coins)
    const offer = offerFor({ wantAmount: 50_000n, offerAsset: asset.AssetId.fromString(ASSET_B) })
    state.submissionError = 'accepted fill reply lost'
    await expect(fulfillOffer(context, 'http://emulator.test', offer, at)).rejects.toThrow('accepted fill reply lost')
    return { context, coins, offer, at }
  }

  it('retains all selected funding after one ambiguous emulator submission without retrying it', async () => {
    const { context, coins, offer, at } = await lostReplyFill()
    expect(state.submissions).toHaveLength(1)
    expect(state.submissions[0]?.checkpointTxs).toHaveLength(3)
    expect(context.reservations.reserved()).toEqual(new Set(coins.map(({ txid, vout }) => `${txid}:${vout}`)))
    expect((await offerInventoryFor(context)).get(null) ?? 0n).toBe(0n)
    await expect(fulfillOffer(context, 'http://emulator.test', offer, at)).rejects.toThrow('no spendable coins')
    expect(state.submissions).toHaveLength(1)
  })

  it('restores ambiguous direct-fill funding holds before a restarted context can admit another fill', async () => {
    const { context, coins } = await lostReplyFill()
    expect(context.reservations.reserved().size).toBe(2)
    const restarted = await ctx(coins)
    expect(restarted.reservations.reserved()).toEqual(new Set(coins.map(({ txid, vout }) => `${txid}:${vout}`)))
    expect((await offerInventoryFor(restarted)).get(null) ?? 0n).toBe(0n)
    expect(state.submissions).toHaveLength(1)
  })

  it('does not treat a successful emulator reply as finality while the indexer is missing it', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const context = await ctx([fundingCoin(80_000)])
    state.finalized = false
    await expect(
      fulfillOffer(context, 'http://emulator.test', offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }), at),
    ).rejects.toThrow('finalization is not yet proven')
    expect(state.submissions).toHaveLength(1)
    expect(context.reservations.reserved().size).toBe(1)
    expect((await context.directFills.list())[0]?.phase).toBe('submitting')
    state.finalized = true
    const recovery = createDirectFillRecovery({
      attempts: context.directFills,
      chain: context.wallet.indexerProvider,
      parent: () => null,
      coins: async () => [],
      serverUnrollScript: {} as never,
      graph: {
        ark: { submitTx: vi.fn(), finalizeTx: vi.fn(), getPendingTxs: vi.fn() },
        signer: identity as never,
        serverKey: SERVER_KEY,
        solverKeys: [hex.encode(takerKey)],
      },
    })
    await recovery.sweep()
    expect(await context.directFills.list()).toEqual([])
    expect(context.reservations.reserved().size).toBe(0)
    expect(state.submissions).toHaveLength(1)
  })

  it('sends nothing when the durable attempt cannot be inserted', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const context = await ctx([fundingCoin(80_000)])
    const original = database.run
    vi.spyOn(database, 'run').mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO direct_fill_attempt')) throw new Error('database full')
      return original(sql, params)
    })
    await expect(
      fulfillOffer(context, 'http://emulator.test', offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }), at),
    ).rejects.toThrow('database full')
    expect(state.submissions).toEqual([])
    expect(context.reservations.reserved().size).toBe(0)
  })

  it('acknowledges a positively finalized standalone fill without requiring an application recovery service', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const context = await ctx([fundingCoin(80_000)])
    const txid = await fulfillOffer(
      context,
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
    )
    expect(txid).toBe(Transaction.fromPSBT(base64.decode(state.submissions[0]!.arkTx)).id)
    expect(state.submissions).toHaveLength(1)
    expect(await context.directFills.list()).toEqual([])
    expect(context.reservations.reserved().size).toBe(0)
    const restarted = await ctx([fundingCoin(80_000)])
    expect(await restarted.directFills.list()).toEqual([])
  })

  it.each(['offer', 'rfq'] as const)(
    'keeps a finalized %s fill pinned until its parent acknowledges it',
    async (kind) => {
      const at = deposit([{ assetId: ASSET_B, amount: 900n }])
      const context = await ctx([fundingCoin(80_000)])
      const txid = await fulfillOffer(
        context,
        'http://emulator.test',
        offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
        at,
        { kind, id: 'row' },
      )
      expect((await context.directFills.list())[0]).toMatchObject({ phase: 'settled', acknowledged: false })
      expect(context.reservations.reserved().size).toBe(1)
      const parent = { recoverDirectFill: vi.fn(async () => true), cancelDirectFill: vi.fn() }
      await createDirectFillRecovery({
        attempts: context.directFills,
        chain: context.wallet.indexerProvider,
        parent: () => parent,
        coins: async () => [],
        serverUnrollScript: {} as never,
        graph: {
          ark: { submitTx: vi.fn(), finalizeTx: vi.fn(), getPendingTxs: vi.fn() },
          signer: identity as never,
          serverKey: SERVER_KEY,
          solverKeys: [hex.encode(takerKey)],
        },
      }).sweep()
      expect(parent.recoverDirectFill).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'row', depositTxid: at.txid }),
        txid,
      )
      expect(context.reservations.reserved().size).toBe(0)
      expect(state.submissions).toHaveLength(1)
    },
  )
})
