/**
 * The asset packet `fulfillOffer` actually submits, read back off the Arkade transaction.
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
import { describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  fulfillOffer,
  OfferNotSubmittedError,
  OfferSubmitRejectedError,
} from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { RFQ_ASSET_SWAP_V4 } from '@arkade-os/solver-core/core/rfqContract.js'

const state = vi.hoisted(() => ({
  vtxos: [] as unknown[],
  arkTx: undefined as string | undefined,
  prevTxs: new Map<string, string>(),
  submitError: undefined as Error | undefined,
}))

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@arkade-os/sdk')>()
  const SERVER = hex.decode('4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa')
  // The SDK's `fillOffer` builds `RestOperatorProvider`; older SDKs named it `RestArkProvider`.
  class OperatorProvider {
    async getInfo() {
      return {
        signerPubkey: `02${hex.encode(SERVER)}`,
        checkpointTapscript: hex.encode(
          mod.CSVMultisigTapscript.encode({
            timelock: { type: 'seconds', value: 512n },
            pubkeys: [SERVER],
          }).script,
        ),
      }
    }
  }
  return {
    ...mod,
    RestArkProvider: OperatorProvider,
    RestOperatorProvider: OperatorProvider,
    RestIndexerProvider: class {
      async getVtxos() {
        return { vtxos: state.vtxos }
      }
      async getVirtualTxs(txids: string[]) {
        return { txs: txids.map((t) => state.prevTxs.get(t)).filter((p): p is string => p !== undefined) }
      }
    },
    RestEmulatorProvider: class {
      constructor(readonly url: string) {}
      async submitTx(arkTx: string, checkpointTxs: string[]) {
        if (state.submitError) throw state.submitError
        state.arkTx = arkTx
        return { signedArkTx: arkTx, signedCheckpointTxs: checkpointTxs }
      }
    },
  }
})

// Calls through, so every fill below still runs the real builder.
vi.mock('@arkade-os/swap/protocol', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@arkade-os/swap/protocol')>()
  return { ...mod, fillOffer: vi.fn(mod.fillOffer) }
})

const { ArkAddress, Extension, MultisigTapscript, Transaction, VtxoScript, asset } = await import('@arkade-os/sdk')
const { fillOffer, offerVtxoScript } = await import('@arkade-os/swap/protocol')
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
const ctx = (spendable: unknown[], read: () => Promise<unknown[]> = async () => spendable): ArkadeContext =>
  ({
    wallet: {
      identity,
      arkServerPublicKey: SERVER_KEY,
      getSpendableVtxos: read,
      getAddress: async () => new ArkAddress(SERVER_KEY, hex.decode('22'.repeat(32)), 'tark').encode(),
      getContractManager: async () => null,
    },
    identity,
    operatorUrl: 'http://arkade',
    reservations: createReservationLedger(),
  }) as unknown as ArkadeContext

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
  return { ...terms, swapPkScript: offerVtxoScript(terms, SERVER_KEY).pkScript } as Offer
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
  if (state.arkTx === undefined) throw new Error('no Arkade transaction reached the emulator: the fill did not submit')
  return groupIds(Extension.fromTx(Transaction.fromPSBT(base64.decode(state.arkTx))).getAssetPacket())
}

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
      ctx(coins),
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
      ctx(coins),
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
      ctx([fundingCoin(80_000)]),
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
    )

    expect(packetGroups()).toEqual([ASSET_B])
  })

  it('submits once, and refuses the other fill, when two race for one coin', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coins = [fundingCoin(80_000)]
    let entered = 0
    let open: () => void = () => {}
    const barrier = new Promise<void>((resolve) => (open = resolve))
    // Both read the float before either pins it, so the second sees the first's coin only if the pin lands in that turn.
    const racing = ctx(coins, async () => {
      entered += 1
      if (entered === 2) open()
      await barrier
      return coins
    })
    const offer = offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) })

    const results = await Promise.allSettled([
      fulfillOffer(racing, 'http://emulator.test', offer, at),
      fulfillOffer(racing, 'http://emulator.test', offer, at),
    ])

    const refusals = results.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(refusals).toEqual([expect.stringMatching(/no spendable coins/)])
    expect(racing.reservations.reserved().size).toBe(0)
  })

  it('latches the row once, and before anything reaches the emulator', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const submittedAtLatch: (string | undefined)[] = []
    const markSubmitting = vi.fn(async () => {
      submittedAtLatch.push(state.arkTx)
      return true
    })

    await fulfillOffer(
      ctx([fundingCoin(80_000)]),
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
      { markSubmitting },
    )

    expect(markSubmitting).toHaveBeenCalledTimes(1)
    expect(submittedAtLatch).toEqual([undefined])
    expect(state.arkTx).toBeDefined()
  })

  it('submits nothing when the latch is lost, and says so retryably', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const spending = ctx([fundingCoin(80_000)])

    const outcome = await fulfillOffer(
      spending,
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
      { markSubmitting: async () => false },
    ).then(
      () => null,
      (error: unknown) => error,
    )

    expect(outcome).toBeInstanceOf(OfferNotSubmittedError)
    expect(state.arkTx).toBeUndefined()
    expect(spending.reservations.reserved().size).toBe(0)
  })

  it('leaves a FAILED latch write untyped — a broken database is not a clean refusal', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const spending = ctx([fundingCoin(80_000)])
    const broken = new Error('database is locked')

    const outcome = await fulfillOffer(
      spending,
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
      {
        markSubmitting: async () => {
          throw broken
        },
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )

    expect(outcome).toBe(broken)
    expect(outcome).not.toBeInstanceOf(OfferNotSubmittedError)
    expect(state.arkTx).toBeUndefined()
    expect(spending.reservations.reserved().size).toBe(0)
  })

  it('leaves a rejection from the submission itself untyped, so no loop can retry it', async () => {
    state.arkTx = undefined
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const spending = ctx([fundingCoin(80_000)])
    const rejected = new Error('emulator refused the fill')
    state.submitError = rejected
    try {
      const outcome = await fulfillOffer(
        spending,
        'http://emulator.test',
        offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
        at,
      ).then(
        () => null,
        (error: unknown) => error,
      )
      expect(outcome).toBe(rejected)
      expect(outcome).not.toBeInstanceOf(OfferNotSubmittedError)
      expect(spending.reservations.reserved().size).toBe(0)
    } finally {
      state.submitError = undefined
    }
  })
})

/** The bodies are arkd's own shape, `vtxo_outpoints` included. @see outpointsIn */
const SUBMIT_PREFIX = 'Failed to submit tx to emulator: '

describe('a submission arkd refused as already spent', () => {
  const refusalBody = (outpoints: string[], over: Record<string, unknown> = {}) =>
    JSON.stringify({
      code: 3,
      message: 'VTXO_ALREADY_SPENT (6): vtxo(s) already spent',
      details: [
        {
          '@type': 'type.googleapis.com/ark.v1.ErrorDetails',
          code: 6,
          name: 'VTXO_ALREADY_SPENT',
          message: 'vtxo(s) already spent',
          metadata: { vtxo_outpoint: outpoints[0] ?? '', vtxo_outpoints: `[${outpoints.join(' ')}]` },
          ...over,
        },
      ],
    })

  const submitting = async (body: string, coins: ReturnType<typeof fundingCoin>[], at: ReturnType<typeof deposit>) => {
    state.arkTx = undefined
    const spending = ctx(coins)
    state.submitError = new Error(`Failed to submit tx to emulator: ${body}`)
    try {
      const outcome = await fulfillOffer(
        spending,
        'http://emulator.test',
        offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
        at,
      ).then(
        () => null,
        (error: unknown) => error,
      )
      return { outcome, spending, sent: state.submitError }
    } finally {
      state.submitError = undefined
    }
  }

  const deposit = (assets?: { assetId: string; amount: bigint }[]) => {
    const coin = { ...mintCoin(60_000), ...(assets ? { assets } : {}) }
    state.vtxos = [coin]
    return { txid: coin.txid, vout: coin.vout, value: coin.value }
  }

  /** Row d13acd93's stored `failure_reason`, byte for byte; its deposit reads
   * `isSpent: true, spentBy: 76ff78fd…` at the public indexer. */
  const INCIDENT_BODY =
    'Failed to submit tx to emulator: {"code":3,"message":"VTXO_ALREADY_SPENT (6): vtxo(s) already spent","details":[{"@type":"type.googleapis.com/ark.v1.ErrorDetails","code":6,"name":"VTXO_ALREADY_SPENT","message":"VTXO_ALREADY_SPENT (6): vtxo(s) already spent","metadata":{"vtxo_outpoint":"7da3508518eb5fec43370d26fb85e2fe105796f1869d183e16a38dbe41e05730:0","vtxo_outpoints":"[7da3508518eb5fec43370d26fb85e2fe105796f1869d183e16a38dbe41e05730:0]"}}]}'
  const INCIDENT_DEPOSIT = '7da3508518eb5fec43370d26fb85e2fe105796f1869d183e16a38dbe41e05730:0'

  it('parses the stored body from row d13acd93 verbatim, Go-slice metadata and all', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const { outcome } = await submitting(INCIDENT_BODY.slice(SUBMIT_PREFIX.length), [fundingCoin(80_000)], at)

    expect(outcome).toBeInstanceOf(OfferSubmitRejectedError)
    // Read out of `[<txid>:0]`, unquoted.
    expect(outcome).toMatchObject({ spentOutpoints: [INCIDENT_DEPOSIT] })
    expect(outcome).toMatchObject({ depositSpent: false })
  })

  it('calls it the deposit when that stored body names the outpoint we were given', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    // Only the txid swapped: the SDK needs a deposit whose prevout it can resolve.
    const body = INCIDENT_BODY.slice(SUBMIT_PREFIX.length).replaceAll(INCIDENT_DEPOSIT.split(':')[0] as string, at.txid)
    const { outcome } = await submitting(body, [fundingCoin(80_000)], at)

    expect(outcome).toMatchObject({ depositSpent: true, spentOutpoints: [`${at.txid}:0`] })
  })

  it('refuses to build the fill when the deposit is gone, and says nothing was sent', async () => {
    // After the latch, before any submission — and no claim the deposit is spent.
    state.arkTx = undefined
    state.vtxos = []
    const at = { txid: 'c'.repeat(64), vout: 0, value: 900 }
    const spending = ctx([fundingCoin(80_000)])
    const latched: string[] = []

    const outcome = await fulfillOffer(
      spending,
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
      {
        markSubmitting: async () => {
          latched.push('latched')
          return true
        },
      },
    ).then(
      () => null,
      (error: unknown) => error,
    )

    expect(outcome).toBeInstanceOf(OfferSubmitRejectedError)
    // The latch HAD flipped, which is why the 'selecting' walk-back cannot serve.
    expect(latched).toEqual(['latched'])
    expect(outcome).toMatchObject({ depositSpent: false, spentOutpoints: [] })
    expect(state.arkTx).toBeUndefined()
    expect(spending.reservations.reserved().size).toBe(0)
  })

  it('names the DEPOSIT when that is the outpoint arkd refused over', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const outpoint = `${at.txid}:${at.vout}`
    const { outcome, spending } = await submitting(refusalBody([outpoint]), [fundingCoin(80_000)], at)

    expect(outcome).toBeInstanceOf(OfferSubmitRejectedError)
    expect(outcome).toMatchObject({ depositSpent: true, spentOutpoints: [outpoint.toLowerCase()] })
    expect(spending.reservations.reserved().size).toBe(0)
  })

  it('says the deposit is NOT spent when one of our own coins is the one named', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coin = fundingCoin(80_000)
    const outpoint = `${coin.txid}:${coin.vout}`
    const { outcome } = await submitting(refusalBody([outpoint]), [coin], at)

    expect(outcome).toBeInstanceOf(OfferSubmitRejectedError)
    expect(outcome).toMatchObject({ depositSpent: false, spentOutpoints: [outpoint.toLowerCase()] })
  })

  it('reads every outpoint out of the space-separated slice, not just the first', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coin = fundingCoin(80_000)
    const theirs = `${'9'.repeat(64)}:3`
    const { outcome } = await submitting(refusalBody([theirs, `${at.txid}:${at.vout}`]), [coin], at)

    expect(outcome).toMatchObject({
      depositSpent: true,
      spentOutpoints: [theirs, `${at.txid}:${at.vout}`.toLowerCase()],
    })
  })

  /** The deposit named BESIDE a coin of ours is also what a fill of ours that
   * landed looks like. @see spec/tla OfferFill_RejectedProof.cfg */
  it('refuses to classify the deposit and one of our own coins named TOGETHER', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const coin = fundingCoin(80_000)
    const body = refusalBody([`${at.txid}:${at.vout}`, `${coin.txid}:${coin.vout}`])
    const { outcome, sent } = await submitting(body, [coin], at)

    expect(outcome).toBe(sent)
    expect(outcome).not.toBeInstanceOf(OfferSubmitRejectedError)
  })

  it('leaves another arkd refusal exactly as it was', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const body = refusalBody([`${at.txid}:${at.vout}`], { code: 11, name: 'ASSET_NOT_FOUND' })
    const { outcome, sent } = await submitting(body, [fundingCoin(80_000)], at)

    expect(outcome).toBe(sent)
    expect(outcome).not.toBeInstanceOf(OfferSubmitRejectedError)
  })

  it('leaves a body it cannot parse alone, because an unreadable refusal proves nothing', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const { outcome, sent } = await submitting('<html>502 Bad Gateway</html>', [fundingCoin(80_000)], at)

    expect(outcome).toBe(sent)
    expect(outcome).not.toBeInstanceOf(OfferSubmitRejectedError)
  })

  it('leaves a VTXO_ALREADY_SPENT carrying no outpoint alone: nothing identifies what was spent', async () => {
    const at = deposit([{ assetId: ASSET_B, amount: 900n }])
    const { outcome, sent } = await submitting(refusalBody([]), [fundingCoin(80_000)], at)

    expect(outcome).toBe(sent)
    expect(outcome).not.toBeInstanceOf(OfferSubmitRejectedError)
  })
})

/** The same probe one step lower, where `resolveDeposit` refuses to build. */
describe('the deposit-gone probe under the latch', () => {
  const DEPOSIT_TXID = 'c'.repeat(64)
  const gone = (vtxos: unknown[]) => ({ getVtxos: async () => ({ vtxos: vtxos as never }) })

  const building = async (probe?: { getVtxos: () => Promise<{ vtxos: never }> }) => {
    state.arkTx = undefined
    state.vtxos = []
    const at = { txid: DEPOSIT_TXID, vout: 0, value: 900 }
    const spending = ctx([fundingCoin(80_000)])
    const outcome = await fulfillOffer(
      spending,
      'http://emulator.test',
      offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B) }),
      at,
      { markSubmitting: async () => true, ...(probe ? { probe } : {}) },
    ).then(
      () => null,
      (error: unknown) => error,
    )
    return { outcome, at, spending }
  }

  it('claims the deposit spent when the indexer names a foreign spender', async () => {
    const { outcome } = await building(
      gone([{ txid: DEPOSIT_TXID, vout: 0, isSpent: true, spentBy: 'e5'.repeat(32), isUnrolled: false }]),
    )
    expect(outcome).toMatchObject({
      depositSpent: true,
      spentOutpoints: [`${DEPOSIT_TXID}:0`],
      spentBy: 'e5'.repeat(32),
    })
  })

  it('withholds the claim when the indexer names no spender', async () => {
    const { outcome, spending } = await building(
      gone([{ txid: DEPOSIT_TXID, vout: 0, isSpent: true, spentBy: '', isUnrolled: false }]),
    )
    expect(outcome).toBeInstanceOf(OfferSubmitRejectedError)
    expect(outcome).toMatchObject({ depositSpent: false, spentOutpoints: [] })
    expect(spending.reservations.reserved().size).toBe(0)
  })

  it('withholds the claim when no indexer is wired', async () => {
    const { outcome } = await building()
    expect(outcome).toMatchObject({ depositSpent: false, spentOutpoints: [] })
  })
})

describe('a directed deposit', () => {
  const OTHER_TAKER = schnorr.getPublicKey(new Uint8Array(32).fill(0x7b))
  const directed = (taker: Uint8Array) => offerFor({ offerAsset: asset.AssetId.fromString(ASSET_B), taker })
  const deposit = () => {
    const coin = { ...mintCoin(60_000), assets: [{ assetId: ASSET_B, amount: 900n }] }
    state.vtxos = [coin]
    return { txid: coin.txid, vout: coin.vout, value: coin.value }
  }

  it('fills it through a binding that carries the taker', async () => {
    state.arkTx = undefined
    vi.mocked(fillOffer).mockClear()

    await fulfillOffer(ctx([fundingCoin(80_000)]), 'http://emulator.test', directed(takerKey), deposit())

    expect(vi.mocked(fillOffer).mock.calls[0]![2]).toMatchObject({ version: RFQ_ASSET_SWAP_V4, taker: takerKey })
    expect(state.arkTx).toBeDefined()
  })

  it('refuses a deposit quoted for another taker above the latch, sending nothing', async () => {
    state.arkTx = undefined
    const spending = ctx([fundingCoin(80_000)])
    const markSubmitting = vi.fn(async () => true)

    const outcome = await fulfillOffer(spending, 'http://emulator.test', directed(OTHER_TAKER), deposit(), {
      markSubmitting,
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(outcome).toBeInstanceOf(OfferNotSubmittedError)
    expect(markSubmitting).not.toHaveBeenCalled()
    expect(state.arkTx).toBeUndefined()
    expect(spending.reservations.reserved().size).toBe(0)
  })
})
