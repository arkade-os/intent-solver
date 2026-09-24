/**
 * Cancel-by-conflict: the conflict is real PSBT bytes signed by a real key, the
 * store is the real SQLite one, and only arkd and the indexer are doubles.
 */

import { describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  buildOffchainTx,
  createAssetPacket,
  CSVMultisigTapscript,
  DefaultVtxo,
  Extension,
  SingleKey,
  Transaction,
  type ArkProvider,
} from '@arkade-os/sdk'
import { digestJointGraph, OFFER_FILL_TEMPLATE } from '@arkade-taxi/client'
import {
  AssetRfqSwapStore,
  type AssetRfqCarrierTerms,
  type AssetRfqSwapRow,
} from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { CarrierAttempt } from '@arkade-os/solver-corridors/db/carrierAttempt.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import {
  createCarrierPinLedger,
  type CarrierCoin,
  type CarrierOutpoint,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import {
  createTaxiReceiveCarrierObserver,
  type CarrierChainReader,
  type CarrierSpentVtxo,
} from '@arkade-os/solver-app/ops/assetRfqTaxiProof.js'
import {
  CARRIER_CONFLICT_AFTER_SECONDS,
  CarrierConflictStalledError,
  createCarrierConflictCanceller,
  type CarrierConflictDeps,
} from '@arkade-os/solver-app/ops/assetRfqTaxiCancel.js'

const ASSET = `${'aa'.repeat(31)}bb0100`
const DEPOSIT_TXID = '1'.repeat(64)
const COIN_A = '2'.repeat(64)
const COIN_B = '4'.repeat(64)
const SPONSOR_TXID = '3'.repeat(64)
const THIRD = 'ff'.repeat(32)
type PendingTx = Awaited<ReturnType<ArkProvider['getPendingTxs']>>[number]

const secret = (seed: number) => new Uint8Array(32).fill(seed)
const xonly = (seed: number): string => hex.encode(schnorr.getPublicKey(secret(seed)))
const SERVER = xonly(9)
const SOLVER_KEY = xonly(2)
const SIGNER = SingleKey.fromPrivateKey(secret(2))

const vtxoScript = (seed: number) =>
  new DefaultVtxo.Script({
    pubKey: hex.decode(xonly(seed)),
    serverPubKey: hex.decode(SERVER),
    csvTimelock: { type: 'blocks', value: 144n },
  })
const SERVER_UNROLL = CSVMultisigTapscript.encode({
  timelock: { type: 'blocks', value: 144n },
  pubkeys: [hex.decode(SERVER)],
})

const MAKER = vtxoScript(4).pkScript
const PROCEEDS = vtxoScript(6).pkScript
const SPONSOR_SCRIPT = vtxoScript(5).pkScript

const coinInput = (seed: number, txid: string, vout: number, value: number) => {
  const s = vtxoScript(seed)
  return { txid, vout, value, tapLeafScript: s.forfeit(), tapTree: s.encode() }
}

/** The fill the Taxi holds: deposit, the solver's COIN_A, a sponsor — as the observer's own fixture. */
const fillGraph = () => {
  const assetExt = Extension.create([
    createAssetPacket(new Map([[1, [{ assetId: ASSET, amount: 10n }]]]), [
      { address: '', assets: [{ assetId: ASSET, amount: 10n }] },
    ]),
  ]).txOut()
  const built = buildOffchainTx(
    [coinInput(1, DEPOSIT_TXID, 1, 1_000), coinInput(2, COIN_A, 0, 2_000), coinInput(3, SPONSOR_TXID, 7, 500)],
    [
      { script: MAKER, amount: 330n },
      { script: SPONSOR_SCRIPT, amount: 4n },
      { script: SPONSOR_SCRIPT, amount: 171n },
      { script: PROCEEDS, amount: 2_995n },
      assetExt,
    ],
    SERVER_UNROLL,
  )
  const arkTx = base64.encode(built.arkTx.toPSBT())
  const checkpoints = built.checkpoints.map((c) => base64.encode(c.toPSBT()))
  const inputOwners = [null, 'solver', 'sponsor']
  return {
    arkTx,
    checkpoints,
    inputOwners,
    graphId: digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE),
    finalTxid: built.arkTx.id,
    checkpointTxids: built.checkpoints.map((c) => c.id),
  }
}
const FILL = fillGraph()

const VALID_UNTIL = 9_000
const DUE = VALID_UNTIL + CARRIER_CONFLICT_AFTER_SECONDS

const RECYCLE: AssetRfqCarrierTerms = {
  mode: 'recycle',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 4n,
  pricedSats: 5n,
  expiresAt: VALID_UNTIL,
}

const PIN_A: CarrierOutpoint = { txid: COIN_A, vout: 0 }
const PIN_B: CarrierOutpoint = { txid: COIN_B, vout: 3 }

const liveCoin = (pin: CarrierOutpoint, value: number, assets?: CarrierCoin['assets'], seed = 2): CarrierCoin => {
  const s = vtxoScript(seed)
  return {
    ...pin,
    value,
    expiresAtHeight: 2_000_000,
    tapTree: s.encode(),
    forfeitTapLeafScript: s.forfeit(),
    script: hex.encode(s.pkScript),
    ...(assets === undefined ? {} : { assets }),
  }
}
const LIVE = [liveCoin(PIN_A, 2_000, [{ assetId: ASSET, amount: 10n }]), liveCoin(PIN_B, 700)]

const ROW = {
  id: 'swap-1',
  state: 'filling',
  toAssetId: ASSET,
  toAmount: 10n,
  makerPkScript: hex.encode(MAKER),
  depositTxid: DEPOSIT_TXID,
  depositVout: 1,
} as AssetRfqSwapRow

const key = (o: { txid: string; vout: number }) => `${o.txid}:${o.vout}`

/** The indexer: pinned coins and the deposit exist; a conflict output exists once "finalized". */
const chainFake = (pinned: readonly CarrierOutpoint[]) => {
  const spent = new Map<string, Omit<CarrierSpentVtxo, 'txid' | 'vout'>>()
  const outputs = new Set<string>([...pinned.map(key), `${DEPOSIT_TXID}:1`])
  const served = new Map<string, string>()
  const reader: CarrierChainReader = {
    getVtxos: async ({ outpoints }) => ({
      vtxos: outpoints.flatMap((o) => (outputs.has(key(o)) ? [{ ...o, ...spent.get(key(o)) }] : [])),
    }),
    getVirtualTxs: async (txids) => ({ txs: txids.flatMap((id) => (served.has(id) ? [served.get(id)!] : [])) }),
  }
  return {
    reader,
    spendPinned: (spentBy: string, arkTxId?: string) => {
      for (const pin of pinned) spent.set(key(pin), { spentBy, ...(arkTxId === undefined ? {} : { arkTxId }) })
    },
    finalize: (txid: string) => outputs.add(`${txid}:0`),
    proveFill: () => {
      spent.set(`${DEPOSIT_TXID}:1`, { spentBy: FILL.checkpointTxids[0]! })
      served.set(FILL.finalTxid, FILL.arkTx)
      served.set(FILL.checkpointTxids[0]!, FILL.checkpoints[0]!)
    },
  }
}

const arkFake = (log: string[]) => {
  const fake = {
    submitted: [] as { arkTx: string; checkpoints: string[] }[],
    finalized: [] as { txid: string; checkpoints: string[] }[],
    intents: [] as Transaction[],
    submitError: undefined as Error | undefined,
    pending: [] as PendingTx[],
    beforeSubmit: async (_arkTx: string): Promise<void> => {},
    submitTx: async (arkTx: string, checkpoints: string[]) => {
      await fake.beforeSubmit(arkTx)
      log.push('submit')
      fake.submitted.push({ arkTx, checkpoints })
      if (fake.submitError) throw fake.submitError
      return {
        arkTxid: Transaction.fromPSBT(base64.decode(arkTx)).id,
        finalArkTx: arkTx,
        signedCheckpointTxs: checkpoints,
      }
    },
    finalizeTx: async (txid: string, checkpoints: string[]) => {
      log.push('finalize')
      fake.finalized.push({ txid, checkpoints })
    },
    getPendingTxs: async (intent: { proof: string; message: { type: string } }) => {
      log.push('pending')
      expect(intent.message.type).toBe('get-pending-tx')
      fake.intents.push(Transaction.fromPSBT(base64.decode(intent.proof)))
      return fake.pending
    },
  }
  return fake
}

const harness = async (over: { inputs?: readonly CarrierOutpoint[]; quoteExpiresAt?: number } = {}) => {
  const pinned = over.inputs ?? [PIN_A]
  const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
  await store.insertQuote({
    id: 'swap-1',
    rfqId: 'a'.repeat(64),
    pair: `arkade:BTC->arkade:${ASSET}`,
    fromAssetId: null,
    toAssetId: ASSET,
    fromAmount: 1_000n,
    toAmount: 10n,
    makerPkScript: hex.encode(MAKER),
    makerPublicKey: 'b'.repeat(64),
    offerPkScript: `5120${'d'.repeat(64)}`,
    offerAddress: 'ark1qoffer',
    solverPubkey: SOLVER_KEY,
    validUntil: VALID_UNTIL,
    carrierTerms: RECYCLE,
  })
  await store.transition('swap-1', 'quoted', 'funded', { deposit_txid: DEPOSIT_TXID, deposit_vout: 1 })
  await store.transition('swap-1', 'funded', 'filling', {})
  await store.prepareCarrierAttempt('swap-1', {
    inputs: pinned.map(({ txid, vout }) => ({ txid, vout })),
    operation: 'swap-1',
    provider: 'http://taxi.example:7080',
    offer: 'abcd',
    deposit: { txid: DEPOSIT_TXID, vout: 1 },
    quote: { id: 'q-1', expires_at: over.quoteExpiresAt ?? VALID_UNTIL },
    input_expiry_floor: { kind: 'height', value: '1100000' },
    proceeds_script: hex.encode(PROCEEDS),
    physical_sats: '330',
    contribution_sats: '329',
    max_fare_sats: '4',
    valid_until: VALID_UNTIL,
  })
  await store.bindCarrierAttempt('swap-1', (await store.readCarrierAttempt('swap-1'))!, {
    fill_id: 'fill-1',
    expires_at: 8_000,
    graph: { id: FILL.graphId, ark_tx: FILL.arkTx, checkpoints: FILL.checkpoints, input_owners: FILL.inputOwners },
  })
  await store.markCarrierAttemptSubmitting('swap-1', (await store.readCarrierAttempt('swap-1'))!)

  const ledger = createReservationLedger()
  const pins = createCarrierPinLedger()
  pins.adopt('swap-1', ledger.reserve(pinned))
  const chain = chainFake(pinned)
  const log: string[] = []
  const clock = { now: DUE + 1 }
  const wallet = { coins: async (): Promise<readonly CarrierCoin[]> => LIVE }

  /** A fresh canceller each call: nothing it holds survives, as across a restart. */
  const depsWith = (ark: ReturnType<typeof arkFake>): CarrierConflictDeps => ({
    store: {
      cancelCarrierAttempt: async (id, expected, next) => {
        log.push('cas:cancelling')
        return store.cancelCarrierAttempt(id, expected, next)
      },
      refuseCancelledCarrierAttempt: (id, expected, reason) =>
        store.refuseCancelledCarrierAttempt(id, expected, reason),
      readCarrierAttempt: (id) => store.readCarrierAttempt(id),
    },
    chain: chain.reader,
    pins,
    ark: () => ark,
    serverUnrollScript: () => SERVER_UNROLL,
    signer: SIGNER,
    coins: () => wallet.coins(),
    solverKeys: [SOLVER_KEY],
    serverKey: () => hex.decode(SERVER),
    now: () => clock.now,
  })
  const attempt = async (): Promise<CarrierAttempt> => (await store.readCarrierAttempt('swap-1'))!
  type Recorded = { txid: string; ark_tx: string; checkpoints: string[]; checkpoint_txids: string[] }
  const conflict = async () => (await attempt()).binding!.conflict as Recorded
  const ark = arkFake(log)
  return {
    store,
    ledger,
    pins,
    chain,
    log,
    clock,
    wallet,
    ark,
    attempt,
    conflict,
    depsWith,
    cancel: async (with_ = ark) => createCarrierConflictCanceller(depsWith(with_))(ROW, await attempt()),
    observe: async (over: Partial<ReturnType<typeof wrapStore>> = {}) =>
      createTaxiReceiveCarrierObserver({
        store: { ...wrapStore(store), ...over },
        chain: chain.reader,
        pins,
        cancel: createCarrierConflictCanceller(depsWith(ark)),
      }).reconcile(ROW),
    pendingCopy: async (): Promise<PendingTx> => {
      const recorded = await conflict()
      return { arkTxid: recorded.txid, finalArkTx: recorded.ark_tx, signedCheckpointTxs: recorded.checkpoints }
    },
  }
}

const wrapStore = (store: AssetRfqSwapStore) => ({
  readCarrierAttempt: (id: string) => store.readCarrierAttempt(id),
  settleCarrierAttempt: (id: string, expected: CarrierAttempt, txid: string) =>
    store.settleCarrierAttempt(id, expected, txid),
  refuseNeverSubmittedCarrierAttempt: (id: string, expected: CarrierAttempt, reason: string) =>
    store.refuseNeverSubmittedCarrierAttempt(id, expected, reason),
  refuseUnattemptedCarrierFill: (id: string, reason: string) => store.refuseUnattemptedCarrierFill(id, reason),
})

/** One due pass: the attempt is `cancelling`, its conflict submitted and finalized. */
const inFlight = async (h: Awaited<ReturnType<typeof harness>>) => {
  await h.cancel()
  expect((await h.attempt()).phase).toBe('cancelling')
  h.log.length = 0
  return h.conflict()
}

describe('eligibility — past both deadlines and the grace period, and only then', () => {
  it('does nothing before the deadlines plus the grace period', async () => {
    const h = await harness()
    for (const now of [VALID_UNTIL + 899, DUE]) {
      h.clock.now = now
      await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
    }
    expect(h.log).toEqual([])
    expect((await h.attempt()).phase).toBe('submitting')
  })

  it('waits out the LATER of the two deadlines', async () => {
    const h = await harness({ quoteExpiresAt: VALID_UNTIL + 500 })
    h.clock.now = DUE + 1
    await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
    expect(h.log).toEqual([])
    h.clock.now = DUE + 501
    await h.cancel()
    expect(h.log[0]).toBe('cas:cancelling')
  })
})

describe('the conflict spend', () => {
  it('writes the conflict transaction before submitting it', async () => {
    const h = await harness()
    h.ark.beforeSubmit = async (arkTx) => {
      expect((await h.attempt()).phase).toBe('cancelling')
      expect((await h.conflict()).ark_tx).toBe(arkTx)
    }
    await h.cancel()
    expect(h.log).toEqual(['cas:cancelling', 'submit', 'finalize'])
  })

  it('spends every pinned input, each via its collaborative leaf, paying the total to the proceeds script', async () => {
    const h = await harness({ inputs: [PIN_A, PIN_B] })
    await h.cancel()
    const recorded = await h.conflict()
    const tx = Transaction.fromPSBT(base64.decode(recorded.ark_tx))
    const spent = recorded.checkpoints.map((psbt) => {
      const input = Transaction.fromPSBT(base64.decode(psbt)).getInput(0)
      return { outpoint: `${hex.encode(input.txid!)}:${input.index}`, leaf: input.tapLeafScript![0]![1] }
    })
    expect(spent.map((s) => s.outpoint)).toEqual([key(PIN_A), key(PIN_B)])
    for (const s of spent) expect(hex.encode(s.leaf)).toBe(hex.encode(vtxoScript(2).forfeit()[1]))
    expect(hex.encode(tx.getOutput(0)!.script!)).toBe(hex.encode(PROCEEDS))
    expect(tx.getOutput(0)!.amount).toBe(2_700n)
    expect(Extension.isExtension(tx.getOutput(1)!.script!)).toBe(true)
    expect(tx.id).toBe(recorded.txid)
  })

  it('re-submits the same bytes after a restart, and builds nothing new', async () => {
    const h = await harness()
    h.ark.submitError = new Error('connection reset')
    await expect(h.cancel()).rejects.toThrow(/connection reset/)
    const first = await h.conflict()

    const restarted = arkFake(h.log)
    h.wallet.coins = async () => {
      throw new Error('a cancelling attempt must never rebuild')
    }
    await expect(h.cancel(restarted)).resolves.toEqual({ status: 'pending' })
    expect(restarted.submitted).toEqual([{ arkTx: first.ark_tx, checkpoints: first.checkpoints }])
    expect(await h.conflict()).toEqual(first)
    expect(h.log.filter((entry) => entry === 'cas:cancelling')).toHaveLength(1)
  })

  it('refuses to re-send stored bytes that no longer hash to their recorded id', async () => {
    const h = await harness()
    h.ark.submitError = new Error('connection reset')
    await expect(h.cancel()).rejects.toThrow()
    const recorded = await h.conflict()
    const tampered = { ...(await h.attempt()) }
    tampered.binding = { ...tampered.binding, conflict: { ...recorded, txid: 'e'.repeat(64) } }
    const restarted = arkFake(h.log)

    await expect(createCarrierConflictCanceller(h.depsWith(restarted))(ROW, tampered)).rejects.toThrow(/hash/)
    expect(restarted.submitted).toEqual([])
  })

  it('refuses stored bytes whose transaction does not spend exactly the stored checkpoints', async () => {
    const h = await harness()
    h.ark.submitError = new Error('connection reset')
    await expect(h.cancel()).rejects.toThrow()
    const recorded = await h.conflict()
    // Self-consistent bytes: the fill's own transaction, hashing to the id recorded beside it.
    const forged = { ...recorded, ark_tx: FILL.arkTx, txid: FILL.finalTxid }
    const tampered = { ...(await h.attempt()) }
    tampered.binding = { ...tampered.binding, conflict: forged }
    const restarted = arkFake(h.log)

    await expect(createCarrierConflictCanceller(h.depsWith(restarted))(ROW, tampered)).rejects.toThrow(
      /does not spend exactly its own checkpoints/,
    )
    expect(restarted.submitted).toEqual([])
  })

  it('never builds over an input the wallet no longer lists', async () => {
    const h = await harness({ inputs: [PIN_A, PIN_B] })
    h.wallet.coins = async () => [LIVE[0]!]
    await expect(h.cancel()).rejects.toThrow(CarrierConflictStalledError)
    expect(h.log).toEqual([])
    expect((await h.attempt()).phase).toBe('submitting')
  })

  it('waits, building nothing, while a pinned coin is spent by the fill itself', async () => {
    const h = await harness()
    h.chain.spendPinned(FILL.checkpointTxids[1]!, FILL.finalTxid)
    await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
    expect(h.log).toEqual([])
  })

  it('throws before the cancelling CAS when the signer cannot sign every input, recording no conflict', async () => {
    const h = await harness()
    h.wallet.coins = async () => [liveCoin(PIN_A, 2_000, undefined, 7)]
    const deps = { ...h.depsWith(h.ark), solverKeys: [SOLVER_KEY, xonly(7)] }

    await expect(createCarrierConflictCanceller(deps)(ROW, await h.attempt())).rejects.toThrow(
      /No taproot scripts signed/,
    )
    expect(h.log).toEqual([])
    expect((await h.attempt()).phase).toBe('submitting')
    expect((await h.attempt()).binding?.conflict).toBeUndefined()
  })

  it('submits nothing, and pends, when it loses the cancelling CAS', async () => {
    const h = await harness()
    const deps = h.depsWith(h.ark)
    const lost = { ...deps, store: { ...deps.store, cancelCarrierAttempt: async () => false } }

    await expect(createCarrierConflictCanceller(lost)(ROW, await h.attempt())).resolves.toEqual({ status: 'pending' })
    expect(h.ark.submitted).toEqual([])
  })
})

describe('what releases the pin', () => {
  it('releases no pin until the chain shows the conflict spend', async () => {
    const h = await harness()
    await inFlight(h)
    await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
    expect(h.ark.submitted).toHaveLength(2)
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect([...h.ledger.reserved()]).toEqual([key(PIN_A)])
    expect((await h.attempt()).phase).toBe('cancelling')
    expect((await h.store.get('swap-1')).state).toBe('filling')
  })

  it.each(['arkTxId', 'spentBy'] as const)(
    'releases every pin and refuses the row once the chain names the conflict itself in %s',
    async (field) => {
      const h = await harness()
      const recorded = await inFlight(h)
      if (field === 'arkTxId') h.chain.spendPinned(recorded.checkpoint_txids[0]!, recorded.txid)
      else h.chain.spendPinned(recorded.txid)
      h.chain.finalize(recorded.txid)

      await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
      expect(h.pins.heldFor('swap-1')).toHaveLength(0)
      expect(h.ledger.reserved().size).toBe(0)
      expect((await h.store.get('swap-1')).state).toBe('refused')
      expect((await h.attempt()).phase).toBe('cancelled')
    },
  )

  it('never takes a checkpoint the fill shares as proof of the conflict', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    expect(recorded.checkpoint_txids[0]).toBe(FILL.checkpointTxids[1])
    h.chain.spendPinned(recorded.checkpoint_txids[0]!)

    await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
    // Re-sent, not looked up as a pending copy: a shared checkpoint is not the conflict's acceptance.
    expect(h.ark.submitted).toHaveLength(2)
    expect(h.ark.intents).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.attempt()).phase).toBe('cancelling')
    expect((await h.store.get('swap-1')).state).toBe('filling')
  })

  it("releases on the conflict's own txid:0, re-sending nothing, while spentBy names only the shared checkpoint", async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    h.chain.spendPinned(recorded.checkpoint_txids[0]!)
    h.chain.finalize(recorded.txid)
    const restarted = arkFake(h.log)

    await expect(h.cancel(restarted)).resolves.toEqual({ status: 'pending' })
    expect(restarted.submitted).toEqual([])
    expect(restarted.intents).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(0)
    expect((await h.store.get('swap-1')).state).toBe('refused')
    expect((await h.attempt()).phase).toBe('cancelled')
  })

  it("pends, never stuck, when the 'third' spender is a sibling's conflict that won the CAS", async () => {
    const h = await harness()
    const stale = await h.attempt()
    const sibling = await inFlight(h)
    h.chain.spendPinned(sibling.checkpoint_txids[0]!, sibling.txid)
    const late = arkFake(h.log)

    await expect(createCarrierConflictCanceller(h.depsWith(late))(ROW, stale)).resolves.toEqual({ status: 'pending' })
    expect(late.submitted).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.store.get('swap-1')).state).toBe('filling')
  })

  it('waits, re-sending nothing, once the chain names the fill as the spender', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    h.chain.spendPinned(recorded.checkpoint_txids[0]!, FILL.finalTxid)
    await expect(h.cancel()).resolves.toEqual({ status: 'pending' })
    expect(h.log).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
  })

  it('is stuck when a pinned coin is spent by a third transaction', async () => {
    const h = await harness()
    await inFlight(h)
    h.chain.spendPinned(THIRD)
    await expect(h.cancel()).resolves.toMatchObject({ status: 'stuck' })
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.attempt()).phase).toBe('cancelling')
  })

  it('is stuck, building nothing, when a pinned coin is spent by a third transaction before any conflict', async () => {
    const h = await harness()
    h.chain.spendPinned(THIRD)
    await expect(h.cancel()).resolves.toMatchObject({ status: 'stuck' })
    expect(h.log).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
  })
})

describe('a restart between submitTx and finalizeTx', () => {
  it('finalizes the pending copy of an accepted conflict, keeping every pin meanwhile', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    h.chain.spendPinned(recorded.checkpoint_txids[0]!, recorded.txid)
    const restarted = arkFake(h.log)
    restarted.pending = [{ arkTxid: THIRD, finalArkTx: FILL.arkTx, signedCheckpointTxs: [] }, await h.pendingCopy()]

    await expect(h.cancel(restarted)).resolves.toEqual({ status: 'pending' })
    expect(restarted.finalized.map((f) => f.txid)).toEqual([recorded.txid])
    expect(restarted.submitted).toEqual([])
    const proof = restarted.intents[0]!.getInput(1)
    expect(restarted.intents[0]!.inputsLength).toBe(2)
    expect(key({ txid: hex.encode(proof.txid!), vout: proof.index! })).toBe(key(PIN_A))
    for (let i = 0; i < 2; i++) expect(restarted.intents[0]!.getInput(i).tapScriptSig).toHaveLength(1)
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.attempt()).phase).toBe('cancelling')
  })

  it('answers a duplicate resubmit by finalizing the pending copy, never a second transaction', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    const restarted = arkFake(h.log)
    restarted.submitError = new Error(`INVALID_ARK_PSBT: duplicated offchain tx ${recorded.txid}`)
    restarted.pending = [await h.pendingCopy()]

    await expect(h.cancel(restarted)).resolves.toEqual({ status: 'pending' })
    expect(restarted.submitted).toEqual([{ arkTx: recorded.ark_tx, checkpoints: recorded.checkpoints }])
    expect(restarted.finalized.map((f) => f.txid)).toEqual([recorded.txid])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
  })

  it('surfaces a named error, keeping every pin, when arkd holds no pending copy to finalize', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    h.chain.spendPinned(recorded.checkpoint_txids[0]!, recorded.txid)

    await expect(h.cancel(arkFake(h.log))).rejects.toThrow(CarrierConflictStalledError)
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.attempt()).phase).toBe('cancelling')
  })

  it('keeps every pin when the resubmit fails for any other reason', async () => {
    const h = await harness()
    await inFlight(h)
    const restarted = arkFake(h.log)
    restarted.submitError = new Error(`VTXO_ALREADY_SPENT: ${COIN_A}:0 already spent`)

    await expect(h.cancel(restarted)).rejects.toThrow(/already spent/)
    expect(restarted.finalized).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.attempt()).phase).toBe('cancelling')
  })

  it('names every rejection arkd gives the stored conflict, on every pass, keeping every pin', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    const restarted = arkFake(h.log)
    const refusal = new Error('INVALID_VTXO_SCRIPT (7): exit delay is too short')
    restarted.submitError = refusal

    for (let pass = 0; pass < 2; pass += 1) {
      await expect(h.cancel(restarted)).rejects.toMatchObject({
        name: 'CarrierConflictRejectedError',
        message: expect.stringContaining(`${recorded.txid}: ${refusal.message}`),
        cause: refusal,
      })
    }
    const sent = { arkTx: recorded.ark_tx, checkpoints: recorded.checkpoints }
    expect(restarted.submitted).toEqual([sent, sent])
    expect(restarted.finalized).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect((await h.attempt()).phase).toBe('cancelling')
  })
})

describe('order against the chain-proof observer', () => {
  it('settles instead when the fill proves first', async () => {
    const h = await harness()
    h.chain.proveFill()
    await expect(h.observe()).resolves.toMatchObject({ status: 'settled', txid: FILL.finalTxid })
    expect(h.log).toEqual([])
    expect(h.pins.heldFor('swap-1')).toHaveLength(0)
  })

  it('settles a cancelling attempt whose fill won the race', async () => {
    const h = await harness()
    await inFlight(h)
    h.chain.proveFill()
    await expect(h.observe()).resolves.toMatchObject({ status: 'settled', txid: FILL.finalTxid })
    expect((await h.attempt()).phase).toBe('settled')
    expect(h.log).toEqual([])
  })

  it('reaches the canceller only on a pass that proved nothing', async () => {
    const h = await harness()
    await expect(h.observe()).resolves.toEqual({ status: 'pending' })
    expect(h.log).toEqual(['cas:cancelling', 'submit', 'finalize'])
  })

  it('never routes a cancelling attempt into the never-submitted refusal', async () => {
    const h = await harness()
    await inFlight(h)
    const refuseNeverSubmittedCarrierAttempt = vi.fn(async () => true)
    await h.observe({ refuseNeverSubmittedCarrierAttempt })
    expect(refuseNeverSubmittedCarrierAttempt).not.toHaveBeenCalled()
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
  })

  it('frees whatever pin a cancelled attempt still has, asking the chain nothing', async () => {
    const h = await harness()
    const recorded = await inFlight(h)
    h.chain.spendPinned(recorded.checkpoint_txids[0]!, recorded.txid)
    h.chain.finalize(recorded.txid)
    await h.cancel()
    const late = createReservationLedger()
    h.pins.adopt('swap-1', late.reserve([PIN_A]))

    await expect(h.observe()).resolves.toEqual({ status: 'pending' })
    expect(late.reserved().size).toBe(0)
  })
})
