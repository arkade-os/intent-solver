/**
 * Settling one recycle fill: the three durable checkpoints and the three
 * external boundaries they precede.
 *
 * ORDER is the property, asserted from inside each boundary — the injected
 * `fetch` and signer read the real store as the request arrives and record the
 * phase already committed, so a write moved after its boundary reddens a real
 * read rather than a call-order tally. The store, the `TaxiClient` and its two
 * verifications are the production ones.
 */

import { describe, it, expect, vi } from 'vitest'
import { base64, hex } from '@scure/base'
import { DefaultVtxo, DelegateVtxo, scriptFromTapLeafScript, SingleKey, Transaction } from '@arkade-os/sdk'
import { digestJointGraph, OFFER_FILL_TEMPLATE } from '@arkade-taxi/client'
import {
  AssetRfqSwapStore,
  type AssetRfqCarrierTerms,
  type AssetRfqSwapRow,
} from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import {
  AssetRfqSwapService,
  type ReceiveCarrierQuote,
  type ReceiveCarrierQuoteRequest,
  type ReceiveCarrierQuotes,
} from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  carrierTaprootEvidence,
  createCarrierPinLedger,
  type CarrierCoin,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import {
  carrierFillSigner,
  createTaxiReceiveCarrierSettler,
  sameInputOwners,
  selectCarrierInputs,
  type CarrierAttemptStore,
  type CarrierFillSeams,
  type TaxiCarrierSettleDeps,
} from '@arkade-os/solver-app/ops/assetRfqTaxiSettle.js'
import { carrierTaxiFor, CarrierTaxiRefusedError } from '@arkade-os/solver-app/ops/assetRfqTaxiAdapter.js'
import type { TaxiUrlPolicy } from '@arkade-os/solver-app/ops/taxiUrlGuard.js'

const ASSET = `${'aa'.repeat(31)}bb0100`
const MAKER_PK_SCRIPT = `5120${'c'.repeat(64)}`
const MAKER_KEY = 'b'.repeat(64)
const PROCEEDS = `5120${'e'.repeat(64)}`
// Real x-only keys, not arbitrary bytes: `DefaultVtxo.Script` builds a real
// taproot tree, and a repeated-byte "pubkey" is not a point on the curve.
const SOLVER_KEY = hex.encode(await SingleKey.fromHex('21'.repeat(32)).xOnlyPublicKey())
const SERVER_KEY = hex.encode(await SingleKey.fromHex('22'.repeat(32)).xOnlyPublicKey())
const OTHER_KEY = hex.encode(await SingleKey.fromHex('23'.repeat(32)).xOnlyPublicKey())
const DEPOSIT_TXID = '1'.repeat(64)
const COIN_A = '2'.repeat(64)
const COIN_B = '3'.repeat(64)
/** Sorts before `COIN_A`, unlike `COIN_B` — so a filter that let an ineligible
 * coin through would pick it FIRST, rather than passing either way. */
const INELIGIBLE_TXID = '0'.repeat(64)
const OFFER_HEX = 'abcd'
const TAXI = 'http://taxi.example:7080'
const NAMED = 'https://taxi.example'
const KEY = 'a1'.repeat(32)
const POLICY: TaxiUrlPolicy = { isMainnet: false, allowPrivate: false }
const NOW = 2_000
const FLOOR = { kind: 'height' as const, value: 1_100_000n }

/** A real default-wallet script for the solver key: forfeit is the
 * collaborative leaf the Taxi requires; exit is the CSV leaf it must reject. */
const SOLVER_SCRIPT = new DefaultVtxo.Script({
  pubKey: hex.decode(SOLVER_KEY),
  serverPubKey: hex.decode(SERVER_KEY),
  csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
const TAP_TREE = SOLVER_SCRIPT.encode()
const FORFEIT_LEAF = SOLVER_SCRIPT.forfeit()
const EXIT_LEAF = SOLVER_SCRIPT.exit()
/** Collaborative, but with someone else's key: excluded for the wrong owner,
 * not for the wrong shape. */
const OTHER_SCRIPT = new DefaultVtxo.Script({
  pubKey: hex.decode(OTHER_KEY),
  serverPubKey: hex.decode(SERVER_KEY),
  csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
/** A second qualifying shape: same forfeit leaf, plus a 3-key delegate leaf
 * that must never pass as one. */
const DELEGATE_SCRIPT = new DelegateVtxo.Script({
  pubKey: hex.decode(SOLVER_KEY),
  serverPubKey: hex.decode(SERVER_KEY),
  delegatePubKey: hex.decode(OTHER_KEY),
  csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
const SERVER_KEY_BYTES = hex.decode(SERVER_KEY)

const carrierQuote = (over: Partial<ReceiveCarrierQuote> = {}): ReceiveCarrierQuote => ({
  quoteId: 'q-1',
  makerPkScript: MAKER_PK_SCRIPT,
  makerPublicKey: MAKER_KEY,
  assetId: ASSET,
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 4n,
  inputExpiryFloor: FLOOR,
  expiresAt: 9_000,
  ...over,
})

const coin = (over: Partial<CarrierCoin> & { txid: string }): CarrierCoin => ({
  vout: 0,
  value: 10_000,
  expiresAtHeight: 1_200_000,
  assets: [{ assetId: ASSET, amount: 10n }],
  tapTree: TAP_TREE,
  forfeitTapLeafScript: FORFEIT_LEAF,
  script: hex.encode(SOLVER_SCRIPT.pkScript),
  ...over,
})

/** REAL unsigned PSBTs: `verifyOfferFillPlan` parses them and recomputes the
 * digest, so a graph fixture that is merely well-shaped would be refused. */
const psbtOf = (ins: readonly (readonly [string, number])[]): string => {
  const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true })
  for (const [txid, index] of ins) tx.addInput({ txid, index })
  tx.addOutput({ script: hex.decode(PROCEEDS), amount: 1_000n })
  return base64.encode(tx.toPSBT())
}

const ARK_TX = psbtOf([
  [DEPOSIT_TXID, 1],
  [COIN_A, 0],
])
const CHECKPOINTS = [psbtOf([[DEPOSIT_TXID, 1]]), psbtOf([[COIN_A, 0]])]
const INPUT_OWNERS: readonly (string | null)[] = [null, 'solver']
const GRAPH_ID = digestJointGraph(
  { arkTx: ARK_TX, checkpoints: CHECKPOINTS, inputOwners: INPUT_OWNERS },
  OFFER_FILL_TEMPLATE,
)
const REBUILT = { arkTx: ARK_TX, checkpoints: CHECKPOINTS, graphId: GRAPH_ID, inputOwners: INPUT_OWNERS }

const fillQuoteBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fillId: 'fill-1',
  operationId: 'swap-1',
  expiresAt: 8_000,
  template: 'taxi-fill/1',
  contributionSats: '329',
  fare: { currency: 'sats', units: '4' },
  graph: {
    arkTx: ARK_TX,
    checkpoints: [...CHECKPOINTS],
    graphId: GRAPH_ID,
    template: 'taxi-fill/1',
    inputs: [
      { owner: 'offer-covenant', txid: DEPOSIT_TXID, vout: 1 },
      { owner: 'solver', txid: COIN_A, vout: 0 },
    ],
    outputs: [
      { role: 'receiver', vout: 0, script: MAKER_PK_SCRIPT, sats: '330', assets: [] },
      { role: 'solver', vout: 1, script: PROCEEDS, sats: '1000', assets: [] },
    ],
  },
  ...over,
})

const statusBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fillId: 'fill-1',
  operationId: 'swap-1',
  state: 'submitting',
  updatedAt: 2_100,
  expiresAt: 8_000,
  ...over,
})

const RECYCLE: AssetRfqCarrierTerms = {
  mode: 'recycle',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 4n,
  pricedSats: 5n,
  expiresAt: 9_000,
}

/** Spelled un-normalised on purpose: the attempt must record the guard's form. */
const RECEIVER_PAID: AssetRfqCarrierTerms = {
  mode: 'recycle_receiver',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 330n,
  receiptSats: 0n,
  serviceFareSats: 0n,
  pricedSats: 0n,
  expiresAt: 9_000,
  taxiUrl: 'https://Taxi.Example/',
  taxiKey: KEY,
}

const openStore = async (
  over: { validUntil?: number; toAmount?: bigint; state?: 'funded'; terms?: AssetRfqCarrierTerms } = {},
) => {
  const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
  await store.insertQuote({
    id: 'swap-1',
    rfqId: 'a'.repeat(64),
    pair: `arkade:BTC->arkade:${ASSET}`,
    fromAssetId: null,
    toAssetId: ASSET,
    fromAmount: 1_000n,
    toAmount: over.toAmount ?? 10n,
    makerPkScript: MAKER_PK_SCRIPT,
    makerPublicKey: MAKER_KEY,
    offerPkScript: `5120${'d'.repeat(64)}`,
    offerAddress: 'ark1qoffer',
    solverPubkey: SOLVER_KEY,
    validUntil: over.validUntil ?? 9_000,
    carrierTerms: over.terms ?? RECYCLE,
  })
  await store.transition('swap-1', 'quoted', 'funded', { deposit_txid: DEPOSIT_TXID, deposit_vout: 1 })
  if (over.state !== 'funded') await store.transition('swap-1', 'funded', 'filling', {})
  return store
}

interface Harness {
  settle: ReceiveCarrierQuotes['settle']
  store: AssetRfqSwapStore
  row: () => Promise<AssetRfqSwapRow>
  seen: Map<string, unknown>
  requests: string[]
  bodies: Record<string, unknown>[]
  ledger: ReturnType<typeof createReservationLedger>
  pins: ReturnType<typeof createCarrierPinLedger>
  attempt: () => Promise<unknown>
  resolves: ReceiveCarrierQuoteRequest[]
  submitted: string[]
  sleeps: number[]
}

const harness = async (
  over: {
    quotes?: (() => ReceiveCarrierQuote)[]
    coins?: readonly CarrierCoin[]
    reserved?: ReadonlySet<string>
    fill?: Partial<CarrierFillSeams>
    body?: Record<string, unknown>
    status?: Record<string, unknown>
    quoteStatus?: number
    submitStatus?: number
    validUntil?: number
    toAmount?: bigint
    terms?: AssetRfqCarrierTerms
    policy?: TaxiUrlPolicy
    /** The first submits' answers, in order; later ones answer `status`. */
    submits?: (() => Response)[]
    /** Seconds each backoff moves the clock. */
    sleepAdvances?: number
    deps?: Partial<TaxiCarrierSettleDeps>
  } = {},
): Promise<Harness> => {
  const store = await openStore({ validUntil: over.validUntil, toAmount: over.toAmount, terms: over.terms })
  const seen = new Map<string, unknown>()
  const requests: string[] = []
  const bodies: Record<string, unknown>[] = []
  const resolves: ReceiveCarrierQuoteRequest[] = []
  const submitted: string[] = []
  const sleeps: number[] = []
  let clock = NOW
  const record = async (label: string) => {
    seen.set(label, await store.readCarrierAttempt('swap-1'))
  }

  const answers = over.quotes ?? [() => carrierQuote()]
  let asked = 0

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (init?.body !== undefined) bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/v1/swap-fills')) {
      await record('quote-post')
      if (over.quoteStatus !== undefined) return json({ code: 'operation_conflict', message: 'no' }, over.quoteStatus)
      return json(over.body ?? fillQuoteBody())
    }
    if (url.endsWith('/submit')) {
      await record('submit-post')
      const answer = over.submits?.[submitted.length]
      submitted.push(init?.body ?? '')
      if (answer !== undefined) return answer()
      if (over.submitStatus !== undefined) {
        return json({ code: 'swap_fill_submission_ambiguous', message: 'unknown' }, over.submitStatus)
      }
      return json(over.status ?? statusBody())
    }
    return json({})
  }) as typeof fetch

  const ledger = createReservationLedger()
  const pins = createCarrierPinLedger()
  const deps: TaxiCarrierSettleDeps = {
    store,
    taxiFor: carrierTaxiFor({ taxiUrl: TAXI, policy: over.policy ?? POLICY, fetch: fetchImpl }),
    resolve: async (request) => {
      resolves.push(request)
      const answer = answers[Math.min(asked, answers.length - 1)]!
      asked += 1
      return answer()
    },
    coins: async () => over.coins ?? [coin({ txid: COIN_A })],
    reserved: () => over.reserved ?? ledger.reserved(),
    reserve: (outpoints) => ledger.reserve(outpoints),
    pins,
    dustSats: 330n,
    offerHex: () => OFFER_HEX,
    proceedsScript: hex.decode(PROCEEDS),
    solverKeys: [SOLVER_KEY],
    serverKey: () => SERVER_KEY_BYTES,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += over.sleepAdvances ?? 0
    },
    fill: {
      rebuild: over.fill?.rebuild ?? (async () => REBUILT),
      sign: async (expected) => {
        await record('sign')
        return over.fill?.sign ? over.fill.sign(expected) : expected
      },
    },
    ...over.deps,
  }
  const { settle } = createTaxiReceiveCarrierSettler(deps)
  return {
    settle,
    store,
    row: () => store.get('swap-1'),
    seen,
    requests,
    bodies,
    ledger,
    pins,
    attempt: () => store.readCarrierAttempt('swap-1'),
    resolves,
    submitted,
    sleeps,
  }
}

/** THE point of this slice. Each assertion reads the durable row from inside
 * the boundary it guards, so moving a write after that boundary reddens it. */
describe('every checkpoint is committed before the boundary it guards', () => {
  it('has the attempt prepared before one byte is asked of the operator', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.seen.get('quote-post')).toMatchObject({ phase: 'prepared' })
    expect((h.seen.get('quote-post') as { binding?: unknown }).binding).toBeUndefined()
    await h.store.close()
  })

  it('has the rebuilt graph bound before the first signature exists', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.seen.get('sign')).toMatchObject({ phase: 'quoted' })
    expect((h.seen.get('sign') as { binding: { fill_id: string } }).binding.fill_id).toBe('fill-1')
    await h.store.close()
  })

  it('has the submitting marker committed before the submit is sent', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.seen.get('submit-post')).toMatchObject({ phase: 'submitting' })
    await h.store.close()
  })

  it('reaches the boundaries in the one order the checkpoints allow', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.requests).toEqual([`POST ${TAXI}/v1/swap-fills`, `POST ${TAXI}/v1/swap-fills/fill-1/submit`])
    expect([...h.seen.keys()]).toEqual(['quote-post', 'sign', 'submit-post'])
    await h.store.close()
  })

  it('holds the reservation before the checkpoint that names it', async () => {
    // A write naming coins nothing has pinned leaves them free for the float.
    const store = await openStore()
    const ledger = createReservationLedger()
    let pinnedAtWrite: string[] = []
    const h = await harness({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          prepareCarrierAttempt: async (id: string, snapshot: never) => {
            pinnedAtWrite = [...ledger.reserved()]
            return store.prepareCarrierAttempt(id, snapshot)
          },
        }),
        reserve: ledger.reserve,
        reserved: () => ledger.reserved(),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).resolves.toEqual({ status: 'submitted' })
    expect(pinnedAtWrite).toEqual([`${COIN_A}:0`])
    await store.close()
    await h.store.close()
  })

  it('asks the operator nothing when the first checkpoint cannot be written', async () => {
    const h = await harness()
    // The row leaves `filling` under the caller, so the CAS finds nothing to pin.
    await h.store.fail('swap-1', 'filling', 'gone')
    await expect(h.settle({ ...(await h.store.get('swap-1')), state: 'filling' })).rejects.toThrow(/prepare/)
    expect(h.requests).toEqual([])
    expect(h.ledger.reserved().size).toBe(0)
    await h.store.close()
  })
})

describe('the snapshot is the attempt authority, written through the one codec', () => {
  it('will not compile a store call that skipped the codec', async () => {
    const store = await openStore()
    const narrowed: CarrierAttemptStore = store
    // @ts-expect-error a plain JsonObject is not a minted snapshot. Removing
    // the brand removes this error, and `pnpm typecheck` fails on the unused
    // directive — which is what makes this enforcement rather than convention.
    await expect(narrowed.prepareCarrierAttempt('swap-1', { inputs: [] })).resolves.toBeDefined()
    await store.close()
  })

  it('names the exact inputs it reserved, and the ceiling it will resend', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    const attempt = (await h.attempt()) as { snapshot: Record<string, unknown> }
    expect(attempt.snapshot.inputs).toEqual([{ txid: COIN_A, vout: 0 }])
    expect(attempt.snapshot.operation).toBe('swap-1')
    expect(attempt.snapshot.valid_until).toBe(9_000)
    expect(attempt.snapshot.provider).toBe(TAXI)
    expect(attempt.snapshot.deposit).toEqual({ txid: DEPOSIT_TXID, vout: 1 })
    await h.store.close()
  })

  it('pins the operator floor it admitted inventory against', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    const attempt = (await h.attempt()) as { snapshot: { input_expiry_floor: unknown } }
    expect(attempt.snapshot.input_expiry_floor).toEqual({ kind: 'height', value: '1100000' })
    await h.store.close()
  })

  it('sends the ceiling it pinned, never one recomputed at the boundary', async () => {
    // `validUntil` participates in request identity: a recomputed value is a 409.
    const h = await harness({ validUntil: 7_000 })
    await expect(h.settle(await h.row())).rejects.toThrow()
    const attempt = (await h.attempt()) as { snapshot: { valid_until: number } }
    expect(attempt.snapshot.valid_until).toBe(7_000)
    expect(h.bodies[0]).toMatchObject({ validUntil: 7_000, operationId: 'swap-1', receiveQuoteId: 'q-1' })
    await h.store.close()
  })

  it('names the row as the operation, so a restart cannot mint a second one', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    const attempt = (await h.attempt()) as { snapshot: { operation: string } }
    expect(h.bodies[0]!.operationId).toBe(attempt.snapshot.operation)
    expect(h.bodies[0]).toMatchObject({ offerHex: OFFER_HEX, fundingTxid: DEPOSIT_TXID, fundingVout: 1 })
    await h.store.close()
  })
})

describe('the pinned floor is what the fill is measured against', () => {
  it('refuses to submit when the operator lowers the floor mid-attempt', async () => {
    const h = await harness({
      quotes: [() => carrierQuote(), () => carrierQuote({ inputExpiryFloor: { kind: 'height', value: 1_000_001n } })],
    })
    await expect(h.settle(await h.row())).rejects.toThrow(/floor/)
    // The widened floor is caught BEFORE the submit marker, so the attempt is
    // still provably never-submitted and its coins come back.
    expect(h.requests.some((r) => r.endsWith('/submit'))).toBe(false)
    expect((await h.row()).state).toBe('refused')
    expect(h.ledger.reserved().size).toBe(0)
    await h.store.close()
  })

  it('refuses just as hard when the operator raises it', async () => {
    const h = await harness({
      quotes: [() => carrierQuote(), () => carrierQuote({ inputExpiryFloor: { kind: 'height', value: 1_100_001n } })],
    })
    await expect(h.settle(await h.row())).rejects.toThrow(/floor/)
    await h.store.close()
  })

  it('refuses when a selected coin stops clearing the floor while the fill is in flight', async () => {
    // The coin AS IT IS AT SPEND, not the object selected before the boundary:
    // re-testing the latter could not fail, whatever had changed.
    let reads = 0
    const h = await harness({
      deps: {
        coins: async () => {
          reads += 1
          return [coin({ txid: COIN_A, expiresAtHeight: reads === 1 ? 1_200_000 : 1_000_001 })]
        },
      },
    })
    await expect(h.settle(await h.row())).rejects.toThrow(/no longer clears its floor/)
    expect(h.requests.some((r) => r.endsWith('/submit'))).toBe(false)
    expect((await h.row()).state).toBe('refused')
    await h.store.close()
  })

  it('refuses when a selected coin is gone by the time it would be spent', async () => {
    let reads = 0
    const h = await harness({
      deps: {
        coins: async () => {
          reads += 1
          return reads === 1 ? [coin({ txid: COIN_A })] : []
        },
      },
    })
    await expect(h.settle(await h.row())).rejects.toThrow(/no longer holds/)
    expect(h.requests.some((r) => r.endsWith('/submit'))).toBe(false)
    await h.store.close()
  })

  it('admits only coins that clear the floor, deterministically ordered', () => {
    const picked = selectCarrierInputs({
      coins: [
        coin({ txid: COIN_B, assets: [{ assetId: ASSET, amount: 6n }] }),
        coin({ txid: COIN_A, assets: [{ assetId: ASSET, amount: 6n }] }),
        coin({ txid: '4'.repeat(64), expiresAtHeight: 1_000_000, assets: [{ assetId: ASSET, amount: 99n }] }),
      ],
      reserved: new Set<string>(),
      floor: FLOOR,
      dustSats: 330n,
      leg: ASSET,
      amount: 10n,
      solverKeys: [SOLVER_KEY],
      serverKey: SERVER_KEY_BYTES,
    })
    expect(picked.map(({ coin }) => coin.txid)).toEqual([COIN_A, COIN_B])
  })

  it('refuses rather than picking a coin another operation pinned', () => {
    expect(() =>
      selectCarrierInputs({
        coins: [coin({ txid: COIN_A })],
        reserved: new Set([`${COIN_A}:0`]),
        floor: FLOOR,
        dustSats: 330n,
        leg: ASSET,
        amount: 10n,
        solverKeys: [SOLVER_KEY],
        serverKey: SERVER_KEY_BYTES,
      }),
    ).toThrow(/inventory/)
  })

  it('excludes a coin with no taproot evidence at all, deterministically ordered', () => {
    const picked = selectCarrierInputs({
      coins: [
        coin({ txid: INELIGIBLE_TXID, tapTree: undefined, forfeitTapLeafScript: undefined }),
        coin({ txid: COIN_A }),
      ],
      reserved: new Set<string>(),
      floor: FLOOR,
      dustSats: 330n,
      leg: ASSET,
      amount: 10n,
      solverKeys: [SOLVER_KEY],
      serverKey: SERVER_KEY_BYTES,
    })
    expect(picked.map(({ coin }) => coin.txid)).toEqual([COIN_A])
  })

  it('excludes a coin whose forfeit leaf is a CSV exit rather than a collaborative multisig', () => {
    const picked = selectCarrierInputs({
      coins: [coin({ txid: INELIGIBLE_TXID, forfeitTapLeafScript: EXIT_LEAF }), coin({ txid: COIN_A })],
      reserved: new Set<string>(),
      floor: FLOOR,
      dustSats: 330n,
      leg: ASSET,
      amount: 10n,
      solverKeys: [SOLVER_KEY],
      serverKey: SERVER_KEY_BYTES,
    })
    expect(picked.map(({ coin }) => coin.txid)).toEqual([COIN_A])
  })

  it('excludes a coin whose collaborative leaf names a different owner key', () => {
    const picked = selectCarrierInputs({
      coins: [
        coin({
          txid: INELIGIBLE_TXID,
          tapTree: OTHER_SCRIPT.encode(),
          forfeitTapLeafScript: OTHER_SCRIPT.forfeit(),
          script: hex.encode(OTHER_SCRIPT.pkScript),
        }),
        coin({ txid: COIN_A }),
      ],
      reserved: new Set<string>(),
      floor: FLOOR,
      dustSats: 330n,
      leg: ASSET,
      amount: 10n,
      solverKeys: [SOLVER_KEY],
      serverKey: SERVER_KEY_BYTES,
    })
    expect(picked.map(({ coin }) => coin.txid)).toEqual([COIN_A])
  })

  it("excludes a coin whose tree doesn't rebuild its own script", () => {
    const picked = selectCarrierInputs({
      coins: [coin({ txid: INELIGIBLE_TXID, script: hex.encode(OTHER_SCRIPT.pkScript) }), coin({ txid: COIN_A })],
      reserved: new Set<string>(),
      floor: FLOOR,
      dustSats: 330n,
      leg: ASSET,
      amount: 10n,
      solverKeys: [SOLVER_KEY],
      serverKey: SERVER_KEY_BYTES,
    })
    expect(picked.map(({ coin }) => coin.txid)).toEqual([COIN_A])
  })

  it('refuses when every candidate lacks a collaborative forfeit leaf', () => {
    expect(() =>
      selectCarrierInputs({
        coins: [coin({ txid: COIN_A, tapTree: undefined, forfeitTapLeafScript: undefined })],
        reserved: new Set<string>(),
        floor: FLOOR,
        dustSats: 330n,
        leg: ASSET,
        amount: 10n,
        solverKeys: [SOLVER_KEY],
        serverKey: SERVER_KEY_BYTES,
      }),
    ).toThrow(/inventory/)
  })
})

describe('carrierTaprootEvidence accepts only a coin whose tree, script and forfeit leaf all agree', () => {
  it('accepts the default two-leaf forfeit', () => {
    expect(carrierTaprootEvidence(coin({ txid: COIN_A }), [SOLVER_KEY], SERVER_KEY_BYTES)).toEqual({
      tapTree: TAP_TREE,
      spendLeaf: scriptFromTapLeafScript(FORFEIT_LEAF),
    })
  })

  it('accepts a delegate coin: the same two-key forfeit, in its own three-leaf tree', () => {
    const delegateCoin = coin({
      txid: COIN_A,
      tapTree: DELEGATE_SCRIPT.encode(),
      forfeitTapLeafScript: DELEGATE_SCRIPT.forfeit(),
      script: hex.encode(DELEGATE_SCRIPT.pkScript),
    })
    expect(carrierTaprootEvidence(delegateCoin, [SOLVER_KEY], SERVER_KEY_BYTES)).toEqual({
      tapTree: DELEGATE_SCRIPT.encode(),
      spendLeaf: scriptFromTapLeafScript(DELEGATE_SCRIPT.forfeit()),
    })
  })

  it.each<[string, CarrierCoin, readonly string[]]>([
    ['a CSV exit leaf', coin({ txid: COIN_A, forfeitTapLeafScript: EXIT_LEAF }), [SOLVER_KEY]],
    [
      "a stranger's multisig",
      coin({
        txid: COIN_A,
        tapTree: OTHER_SCRIPT.encode(),
        forfeitTapLeafScript: OTHER_SCRIPT.forfeit(),
        script: hex.encode(OTHER_SCRIPT.pkScript),
      }),
      [SOLVER_KEY],
    ],
    ['a leaf outside its own tree', coin({ txid: COIN_A, forfeitTapLeafScript: OTHER_SCRIPT.forfeit() }), [SOLVER_KEY]],
    [
      "a tree that rebuilds a different coin's script",
      coin({ txid: COIN_A, script: hex.encode(OTHER_SCRIPT.pkScript) }),
      [SOLVER_KEY],
    ],
    [
      'the 3-key delegate leaf, even with the delegate key listed as a solver key',
      coin({
        txid: COIN_A,
        tapTree: DELEGATE_SCRIPT.encode(),
        forfeitTapLeafScript: DELEGATE_SCRIPT.delegate(),
        script: hex.encode(DELEGATE_SCRIPT.pkScript),
      }),
      [SOLVER_KEY, OTHER_KEY],
    ],
  ])('rejects %s', (_why, badCoin, solverKeys) => {
    expect(carrierTaprootEvidence(badCoin, solverKeys, SERVER_KEY_BYTES)).toBeUndefined()
  })
})

describe('a solver input carries the taproot evidence the Taxi will check', () => {
  it("sends the coin's own tree and forfeit leaf, byte-equal to what it holds", async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    const body = h.bodies[0] as { solverInputs: { tapTree: string; spendLeaf: string }[] }
    expect(body.solverInputs).toEqual([
      expect.objectContaining({
        tapTree: hex.encode(TAP_TREE),
        spendLeaf: hex.encode(scriptFromTapLeafScript(FORFEIT_LEAF)),
      }),
    ])
    await h.store.close()
  })

  it('never pins or asks the operator when inventory holds only excluded coins', async () => {
    const h = await harness({ coins: [coin({ txid: COIN_A, tapTree: undefined, forfeitTapLeafScript: undefined })] })
    await expect(h.settle(await h.row())).rejects.toThrow(/inventory/)
    expect(h.requests).toEqual([])
    expect(h.ledger.reserved().size).toBe(0)
    expect(h.pins.held()).toEqual([])
    await h.store.close()
  })

  it('picks the eligible coin over one an ineligible leaf would have covered the amount with', async () => {
    const h = await harness({
      coins: [coin({ txid: INELIGIBLE_TXID, forfeitTapLeafScript: EXIT_LEAF }), coin({ txid: COIN_A })],
    })
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
    await h.store.close()
  })
})

const receiverPaid = (over: Parameters<typeof harness>[0] = {}) =>
  harness({
    terms: RECEIVER_PAID,
    body: fillQuoteBody({ contributionSats: '330', fare: { currency: 'sats', units: '0' } }),
    ...over,
  })

describe("a receiver-paid fill settles against the row's own Taxi", () => {
  it('contributes the whole dust and caps the fare at zero', async () => {
    const h = await receiverPaid()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.bodies[0]).toMatchObject({ contributionSats: '330', maxFare: { currency: 'sats', units: '0' } })
    await h.store.close()
  })

  it('asks the row own Taxi for the fill, not the configured one', async () => {
    const h = await receiverPaid()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.requests).toEqual([`POST ${NAMED}/v1/swap-fills`, `POST ${NAMED}/v1/swap-fills/fill-1/submit`])
    await h.store.close()
  })

  it('records the row own Taxi, normalised, and its key on the attempt', async () => {
    const h = await receiverPaid()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(((await h.attempt()) as { snapshot: unknown }).snapshot).toMatchObject({
      provider: NAMED,
      provider_key: KEY,
    })
    await h.store.close()
  })

  it('carries the Taxi into every resolve the settle makes', async () => {
    const h = await receiverPaid()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.resolves.length).toBeGreaterThanOrEqual(2)
    for (const ask of h.resolves) {
      expect(ask).toMatchObject({ taxi: { url: RECEIVER_PAID.taxiUrl, operatorKey: KEY }, receiverPaid: true })
      // `admission` marks quote traffic; a fill's reads must spend the fill budget.
      expect(ask).not.toHaveProperty('admission')
    }
    await h.store.close()
  })

  it('refuses a named Taxi the URL policy refuses, before pinning or asking anything', async () => {
    const h = await receiverPaid({ terms: { ...RECEIVER_PAID, taxiUrl: 'https://taxi.internal' } })
    await expect(h.settle(await h.row())).rejects.toBeInstanceOf(CarrierTaxiRefusedError)
    expect(h.requests).toEqual([])
    expect(h.resolves).toEqual([])
    expect(await h.attempt()).toBeNull()
    expect(h.pins.held()).toEqual([])
    await h.store.close()
  })

  it('guards a named Taxi even where it spells the configured URL, and never the configured one (G3)', async () => {
    const mainnet: TaxiUrlPolicy = { isMainnet: true, allowPrivate: false }
    const named = await receiverPaid({ policy: mainnet, terms: { ...RECEIVER_PAID, taxiUrl: TAXI } })
    await expect(named.settle(await named.row())).rejects.toBeInstanceOf(CarrierTaxiRefusedError)
    expect(named.requests).toEqual([])
    const configured = await harness({ policy: mainnet })
    await expect(configured.settle(await configured.row())).resolves.toEqual({ status: 'submitted' })
    expect(configured.requests[0]).toBe(`POST ${TAXI}/v1/swap-fills`)
    await named.store.close()
    await configured.store.close()
  })

  it('leaves the sender-paid settle on the configured Taxi', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(h.bodies[0]).toMatchObject({ contributionSats: '329', maxFare: { currency: 'sats', units: '4' } })
    expect(h.requests).toEqual([`POST ${TAXI}/v1/swap-fills`, `POST ${TAXI}/v1/swap-fills/fill-1/submit`])
    const { snapshot } = (await h.attempt()) as { snapshot: Record<string, unknown> }
    expect(snapshot.provider).toBe(TAXI)
    expect(snapshot).not.toHaveProperty('provider_key')
    expect(h.resolves.length).toBeGreaterThanOrEqual(2)
    for (const ask of h.resolves) {
      expect(ask).not.toHaveProperty('taxi')
      expect(ask).not.toHaveProperty('receiverPaid')
    }
    await h.store.close()
  })
})

describe('a failure before any attempt is written ends the row refused, never stuck', () => {
  const expectRefused = async (h: Harness, why: RegExp) => {
    const row = await h.row()
    expect(row.state).toBe('refused')
    expect(row.failureReason).toMatch(why)
    expect(await h.attempt()).toBeNull()
    expect(h.requests).toEqual([])
    expect(h.pins.held()).toEqual([])
    expect(h.ledger.reserved().size).toBe(0)
  }

  it('refuses a row whose named Taxi the URL policy refuses', async () => {
    const h = await receiverPaid({ terms: { ...RECEIVER_PAID, taxiUrl: 'https://taxi.internal' } })
    await expect(h.settle(await h.row())).rejects.toBeInstanceOf(CarrierTaxiRefusedError)
    await expectRefused(h, /^not filled: carrier fill swap-1 names Taxi https:\/\/taxi\.internal/)
    await h.store.close()
  })

  it.each([
    ['cannot be reached', 'fetch failed'],
    ['refuses the read', 'taxi: service is not ready'],
    ['serves a quote that does not verify', 'taxi: receive covenant address does not match its terms'],
  ])('refuses a row whose named Taxi %s at the fill-time read', async (_why, message) => {
    const failure = new Error(message)
    const h = await receiverPaid({
      deps: {
        resolve: async () => {
          throw failure
        },
      },
    })
    await expect(h.settle(await h.row())).rejects.toBe(failure)
    await expectRefused(h, new RegExp(`^not filled: ${message}$`))
    await h.store.close()
  })

  it('refuses a row whose inventory no longer covers it', async () => {
    const h = await receiverPaid({ coins: [] })
    await expect(h.settle(await h.row())).rejects.toThrow(/inventory holds 0/)
    await expectRefused(h, /inventory holds 0/)
    await h.store.close()
  })

  it('refuses a row whose attempt write threw before landing, freeing the pin it took', async () => {
    const store = await openStore({ terms: RECEIVER_PAID })
    const h = await receiverPaid({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          prepareCarrierAttempt: async () => {
            throw new Error('database is locked')
          },
        }),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).rejects.toThrow(/database is locked/)
    expect((await store.get('swap-1')).state).toBe('refused')
    expect(await store.readCarrierAttempt('swap-1')).toBeNull()
    expect(h.pins.held()).toEqual([])
    expect(h.ledger.reserved().size).toBe(0)
    await store.close()
    await h.store.close()
  })
})

describe("a Taxi's not_ready is answered with the same bytes again, never with a release", () => {
  const notReady = () =>
    new Response(JSON.stringify({ code: 'not_ready', error: 'runtime_checking' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })

  const expectLiable = async (h: Harness) => {
    expect((await h.row()).state).toBe('filling')
    expect(await h.attempt()).toMatchObject({ phase: 'submitting' })
    expect(h.pins.heldFor('swap-1')).toHaveLength(1)
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
  }

  it('re-posts the identical signed graph after two not_ready answers, then submits', async () => {
    let signs = 0
    const h = await receiverPaid({
      submits: [notReady, notReady],
      fill: {
        sign: async (expected) => {
          signs += 1
          return expected
        },
      },
    })
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect(signs).toBe(1)
    expect(h.submitted).toHaveLength(3)
    expect(new Set(h.submitted).size).toBe(1)
    expect(h.sleeps).toHaveLength(2)
    await expectLiable(h)
    await h.store.close()
  })

  it('stops once the swap-fill quote has expired, still submitting and still pinned', async () => {
    // NOW + 2 x 3000 lands exactly on the quote's expiresAt, before the retry cap.
    const h = await receiverPaid({ submits: Array(9).fill(notReady), sleepAdvances: 3_000 })
    await expect(h.settle(await h.row())).rejects.toMatchObject({ code: 'not_ready' })
    expect(h.submitted).toHaveLength(2)
    await expectLiable(h)
    await h.store.close()
  })

  it('never sleeps into a quote with less time left than the backoff', async () => {
    const h = await receiverPaid({
      body: fillQuoteBody({ contributionSats: '330', fare: { currency: 'sats', units: '0' }, expiresAt: NOW + 1 }),
      submits: [notReady],
    })
    await expect(h.settle(await h.row())).rejects.toMatchObject({ code: 'not_ready' })
    expect(h.sleeps).toEqual([])
    expect(h.submitted).toHaveLength(1)
    await expectLiable(h)
    await h.store.close()
  })

  it('stops at its retry cap even when the clock stands still', async () => {
    const h = await receiverPaid({ submits: Array(9).fill(notReady) })
    await expect(h.settle(await h.row())).rejects.toMatchObject({ code: 'not_ready' })
    expect(h.submitted).toHaveLength(4)
    await expectLiable(h)
    await h.store.close()
  })

  it.each([
    [
      'a network error',
      () => {
        throw new Error('socket hang up')
      },
      'NETWORK_ERROR',
    ],
    ['an HTTP error with no readable code', () => new Response('bad gateway', { status: 503 }), 'HTTP_ERROR'],
  ])('never retries %s: the Taxi may already hold the graph', async (_why, answer, code) => {
    const h = await receiverPaid({ submits: [answer] })
    await expect(h.settle(await h.row())).rejects.toMatchObject({ code })
    expect(h.submitted).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    await expectLiable(h)
    await h.store.close()
  })
})

describe('a reservation outlives every outcome that may have submitted', () => {
  it('releases the pin when the attempt is proven never-submitted', async () => {
    const h = await harness({ quoteStatus: 409 })
    await expect(h.settle(await h.row())).rejects.toThrow()
    expect((await h.row()).state).toBe('refused')
    expect((await h.attempt()) as unknown).toMatchObject({ phase: 'not_submitted' })
    expect(h.ledger.reserved().size).toBe(0)
    await h.store.close()
  })

  it('keeps the pin and the liability when the submit outcome is unknown', async () => {
    const h = await harness({ submitStatus: 502 })
    await expect(h.settle(await h.row())).rejects.toThrow()
    // `filling`, not `refused`: only a human can say what became of it.
    expect((await h.row()).state).toBe('filling')
    expect((await h.attempt()) as unknown).toMatchObject({ phase: 'submitting' })
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
    await h.store.close()
  })

  it('keeps the pin when the fill was submitted and its proof is not in yet', async () => {
    const h = await harness()
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect((await h.row()).state).toBe('filling')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
    await h.store.close()
  })

  it('holds no reservation when the offer refuses before any attempt exists', async () => {
    const h = await harness({
      deps: {
        offerHex: () => {
          throw new Error('the recorded terms derive another offer script')
        },
      },
    })
    await expect(h.settle(await h.row())).rejects.toThrow(/derive another offer script/)
    expect(h.requests).toEqual([])
    expect(await h.attempt()).toBeNull()
    expect(h.ledger.reserved().size).toBe(0)
    expect(h.pins.held()).toEqual([])
    await h.store.close()
  })

  it('holds no reservation when the snapshot cannot be encoded', async () => {
    const h = await harness({ deps: { proceedsScript: undefined as never } })
    await expect(h.settle(await h.row())).rejects.toThrow()
    expect(h.requests).toEqual([])
    expect(await h.attempt()).toBeNull()
    expect(h.ledger.reserved().size).toBe(0)
    await h.store.close()
  })

  it('releases the pin when the first checkpoint was written and its answer was lost', async () => {
    const store = await openStore()
    const h = await harness({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          prepareCarrierAttempt: async (id: string, snapshot: never) => {
            await store.prepareCarrierAttempt(id, snapshot)
            throw new Error('connection reset')
          },
        }),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).rejects.toThrow(/connection reset/)
    expect(h.requests).toEqual([])
    expect((await store.get('swap-1')).state).toBe('refused')
    expect(h.ledger.reserved().size).toBe(0)
    await store.close()
    await h.store.close()
  })

  it('keeps the pin when the submitting marker was written and its answer was lost', async () => {
    // The write landed; only the reply did not. Local belief says "never sent",
    // the durable phase says otherwise, and the durable phase decides.
    const store = await openStore()
    const h = await harness({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          markCarrierAttemptSubmitting: async (id: string, expected: never) => {
            await store.markCarrierAttemptSubmitting(id, expected)
            throw new Error('connection reset')
          },
        }),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).rejects.toThrow(/connection reset/)
    expect((await store.get('swap-1')).state).toBe('filling')
    expect(await store.readCarrierAttempt('swap-1')).toMatchObject({ phase: 'submitting' })
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
    await store.close()
    await h.store.close()
  })

  it('releases the pin when the binding was written and its answer was lost', async () => {
    const store = await openStore()
    const h = await harness({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          bindCarrierAttempt: async (id: string, expected: never, binding: never) => {
            await store.bindCarrierAttempt(id, expected, binding)
            throw new Error('connection reset')
          },
        }),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).rejects.toThrow(/connection reset/)
    expect((await store.get('swap-1')).state).toBe('refused')
    expect(h.ledger.reserved().size).toBe(0)
    await store.close()
    await h.store.close()
  })

  it('keeps the pin when another worker submits between the read and the terminal CAS', async () => {
    const store = await openStore()
    const h = await harness({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          bindCarrierAttempt: async (id: string, expected: never, binding: never) => {
            await store.bindCarrierAttempt(id, expected, binding)
            throw new Error('connection reset')
          },
          refuseNeverSubmittedCarrierAttempt: async (id: string, expected: never, reason: string) => {
            await store.markCarrierAttemptSubmitting(id, expected)
            return store.refuseNeverSubmittedCarrierAttempt(id, expected, reason)
          },
        }),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).rejects.toThrow(/connection reset/)
    // The refusal lost, so the coins are not this caller's to free.
    expect((await store.get('swap-1')).state).toBe('filling')
    expect([...h.ledger.reserved()]).toEqual([`${COIN_A}:0`])
    await store.close()
    await h.store.close()
  })

  it('releases the pin when another caller already proved the attempt never submitted', async () => {
    // The terminal CAS loses because the row is ALREADY `not_submitted`, which
    // that CAS only ever writes over a `prepared`/`quoted` envelope. So it is
    // durable proof nothing was sent, the loser's pin is dead weight, and
    // nothing else can reach it: the row is `refused`, which reconcile never visits.
    const store = await openStore()
    const h = await harness({
      deps: {
        store: Object.assign(Object.create(store) as typeof store, {
          bindCarrierAttempt: async (id: string, expected: never, binding: never) => {
            await store.bindCarrierAttempt(id, expected, binding)
            throw new Error('connection reset')
          },
          readCarrierAttempt: async (id: string) => {
            const current = await store.readCarrierAttempt(id)
            if (current?.phase === 'quoted') {
              await store.refuseNeverSubmittedCarrierAttempt(id, current, 'not filled: another caller got there')
            }
            return store.readCarrierAttempt(id)
          },
        }),
      },
    })
    await expect(h.settle(await store.get('swap-1'))).rejects.toThrow(/connection reset/)
    expect(await store.readCarrierAttempt('swap-1')).toMatchObject({ phase: 'not_submitted' })
    expect(h.ledger.reserved().size).toBe(0)
    await store.close()
    await h.store.close()
  })

  it('refuses a second attempt on a row that already has one', async () => {
    const h = await harness({ submitStatus: 502 })
    await expect(h.settle(await h.row())).rejects.toThrow()
    await expect(h.settle(await h.row())).rejects.toThrow(/already/)
    expect(h.requests.filter((r) => r.endsWith('/submit'))).toHaveLength(1)
    await h.store.close()
  })
})

describe('the input owner comparison is exact, element for element', () => {
  // Every pair below serialises to the same JSON; none names the same owners.
  const holed = new Array<string | null>(2)
  holed[1] = 'solver'

  it.each([
    ['an undefined owner where the covenant is null', [undefined as unknown as null, 'solver'], [null, 'solver']],
    ['a hole on the rebuilt side', holed, [null, 'solver']],
    ['a hole on the quoted side', [null, 'solver'], holed],
  ])('refuses %s', (_why, rebuilt, quoted) => {
    expect(sameInputOwners(rebuilt, quoted)).toBe(false)
  })

  it('accepts the same owners, and refuses a different count', () => {
    expect(sameInputOwners([null, 'solver'], [null, 'solver'])).toBe(true)
    expect(sameInputOwners([null, 'solver'], [null, 'solver', 'solver'])).toBe(false)
  })
})

describe('nothing an operator says is taken as proof of a fill', () => {
  it('reports no txid of its own, whatever the submit answers', async () => {
    const h = await harness({ status: statusBody({ state: 'settled', txid: '9'.repeat(64) }) })
    await expect(h.settle(await h.row())).resolves.toEqual({ status: 'submitted' })
    expect((await h.row()).fillTxid).toBeNull()
    expect((await h.row()).state).toBe('filling')
    await h.store.close()
  })
})

/** Against the REAL `signJointGraphForOwner`, which refuses any binding naming
 * an input the graph does not assign to `solver`. */
describe('the solver signer claims its own inputs and no others', () => {
  const IDENTITY = SingleKey.fromHex('11'.repeat(32))
  const THREE_OWNERS = (() => {
    const arkTx = psbtOf([
      [DEPOSIT_TXID, 1],
      [COIN_A, 0],
      [COIN_B, 2],
    ])
    const checkpoints = [psbtOf([[DEPOSIT_TXID, 1]]), psbtOf([[COIN_A, 0]]), psbtOf([[COIN_B, 2]])]
    const inputOwners: readonly (string | null)[] = [null, 'solver', 'sponsor']
    return {
      arkTx,
      checkpoints,
      inputOwners,
      graphId: digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE),
    }
  })()

  it('refuses a graph that assigns it no input at all', async () => {
    const none = { ...THREE_OWNERS, inputOwners: [null, 'sponsor', 'sponsor'] as readonly (string | null)[] }
    await expect(carrierFillSigner(IDENTITY)(none)).rejects.toThrow(/assigns no input/)
  })

  it('passes the library ownership gate, so it bound the solver index alone', async () => {
    // The gate runs before the graph's edges do. Binding index 0 or 2 fails as
    // "not assigned to solver", and binding all three fails on the count; only
    // the solver index alone reaches the edge check the fixture cannot satisfy.
    await expect(carrierFillSigner(IDENTITY)(THREE_OWNERS)).rejects.toThrow(/ark input 0 does not spend/)
    await expect(carrierFillSigner(IDENTITY)(THREE_OWNERS)).rejects.not.toThrow(/not assigned to solver/)
  })
})

describe('the pin ledger holds a release until something proves it may go', () => {
  it('releases exactly the adopted outpoints, once', () => {
    const ledger = createReservationLedger()
    const pins = createCarrierPinLedger()
    const first = pins.adopt('swap-1', ledger.reserve([{ txid: COIN_A, vout: 0 }]))
    pins.adopt('swap-2', ledger.reserve([{ txid: COIN_B, vout: 1 }]))
    first.release()
    first.release()
    expect([...ledger.reserved()]).toEqual([`${COIN_B}:1`])
    expect(pins.held()).toEqual(['swap-2'])
  })

  it('will not let one holder of a row free another holder of it', () => {
    // The CAS loser releasing the winner's coins is the never-submitted split
    // defeated through the ledger rather than through a state transition.
    const ledger = createReservationLedger()
    const pins = createCarrierPinLedger()
    const winner = pins.adopt('swap-1', ledger.reserve([{ txid: COIN_A, vout: 0 }]))
    const loser = pins.adopt('swap-1', ledger.reserve([{ txid: COIN_B, vout: 1 }]))
    loser.release()
    expect([...ledger.reserved()]).toEqual([`${COIN_A}:0`])
    expect(pins.heldFor('swap-1')).toEqual([winner])
    winner.release()
    expect(ledger.reserved().size).toBe(0)
    expect(pins.held()).toEqual([])
  })
})

// The REAL orchestrator over the REAL settler, so nothing between them can
// re-shape what a submission reports.
describe('the orchestrator hands a submitted fill to the proof observer, not to onError', () => {
  const drive = async (over: Parameters<typeof harness>[0] = {}) => {
    const store = await openStore({ state: 'funded' })
    const h = await harness({ ...over, deps: { store, ...over.deps } })
    const errors: unknown[] = []
    const reconcile = vi.fn(async () => ({ status: 'pending' as const }))
    const service = new AssetRfqSwapService({
      store,
      markets: [],
      solverPubkey: SOLVER_KEY,
      quoteValiditySeconds: 30,
      dustSats: 330n,
      now: () => NOW,
      fetchPrice: async () => ({ mantissa: 1n, scale: 0 }),
      deriveOffer: () => ({ pkScript: `5120${'d'.repeat(64)}`, address: 'ark1qoffer' }),
      depositAt: async () => ({ txid: DEPOSIT_TXID, vout: 1, sats: 1_000n, assets: [] }),
      balance: async () => {
        throw new Error('a recycle never reads the generic balance')
      },
      settle: async () => {
        throw new Error('a recycle never settles directly')
      },
      receiveCarrierQuotes: {
        resolve: async () => carrierQuote(),
        available: async () => new Map([[ASSET, 10n]]),
        settle: h.settle,
        reconcile,
      },
      onError: (_id, error) => errors.push(error),
    })
    const close = async () => {
      await store.close()
      await h.store.close()
    }
    return { h, store, service, errors, reconcile, close }
  }

  it('reports nothing for a normal submission, and the observer takes the row from there', async () => {
    const { h, store, service, errors, reconcile, close } = await drive()
    await service.tick('swap-1')
    expect(errors).toEqual([])
    expect(h.requests.at(-1)).toBe(`POST ${TAXI}/v1/swap-fills/fill-1/submit`)
    expect(await store.get('swap-1')).toMatchObject({ state: 'filling', fillTxid: null })
    expect(await store.readCarrierAttempt('swap-1')).toMatchObject({ phase: 'submitting' })

    await service.tick('swap-1')
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
    await close()
  })

  it('still reports a submission whose outcome is unknown', async () => {
    const { store, service, errors, reconcile, close } = await drive({ submitStatus: 502 })
    await service.tick('swap-1')
    expect(errors).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('filling')
    await service.tick('swap-1')
    expect(reconcile).toHaveBeenCalledTimes(1)
    await close()
  })

  it('still reports a fill refused before anything was sent', async () => {
    const { h, store, service, errors, close } = await drive({ quoteStatus: 409 })
    await service.tick('swap-1')
    expect(errors).toHaveLength(1)
    expect((await store.get('swap-1')).state).toBe('refused')
    expect(h.requests.some((r) => r.endsWith('/submit'))).toBe(false)
    await close()
  })
})

describe('two settles racing one row cannot free each other', () => {
  it('leaves the winner of the prepare CAS pinned when the loser gives its own up', async () => {
    const store = await openStore()
    const pins = createCarrierPinLedger()
    const ledger = createReservationLedger()
    // Both read the attempt before either writes one, and neither sees the
    // other's pin — `available` is admission-only, so both pick the same coin.
    const shared = {
      submitStatus: 502,
      deps: { store, pins, reserve: ledger.reserve, reserved: () => new Set<string>() },
    }
    const first = await harness(shared)
    const second = await harness(shared)
    const row = await store.get('swap-1')

    const outcomes = await Promise.allSettled([first.settle(row), second.settle(row)])
    const reasons = outcomes.map((o) => (o.status === 'rejected' ? String(o.reason) : 'resolved'))
    expect(reasons.filter((r) => /could not prepare its attempt/.test(r))).toHaveLength(1)
    expect(await store.readCarrierAttempt('swap-1')).toMatchObject({ phase: 'submitting' })
    // The winner is liable, so its coin stays pinned however the loser exits.
    expect([...ledger.reserved()]).toEqual([`${COIN_A}:0`])
    expect(pins.heldFor('swap-1')).toHaveLength(1)
    await store.close()
    for (const h of [first, second]) await h.store.close()
  })
})
