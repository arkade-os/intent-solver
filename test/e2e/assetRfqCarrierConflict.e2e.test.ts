/**
 * E2E — cancel-by-conflict (Ruling 5) against a real arkd: a `submitting` attempt past both deadlines
 * spends its pinned coins back to the solver, and its pin is freed only once the conflict's `txid:0` is
 * indexed. No Taxi runs here, so the attempt is seeded from real wallet coins; the clock is injected.
 * Needs arkd, the emulator, spendable sats and a minted asset. Run: `pnpm test:e2e`.
 */

import { randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ArkAddress, buildOffchainTx, DefaultVtxo } from '@arkade-os/sdk'
import { digestJointGraph, OFFER_FILL_TEMPLATE } from '@arkade-taxi/client'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  carrierTaprootEvidence,
  createCarrierPinLedger,
  encodeCarrierAttemptInputs,
  spendableCarrierCoins,
  type CarrierCoin,
} from '@arkade-os/solver-app/ops/assetRfqTaxi.js'
import {
  CARRIER_CONFLICT_AFTER_SECONDS,
  createCarrierConflictCanceller,
  type CarrierConflictArk,
} from '@arkade-os/solver-app/ops/assetRfqTaxiCancel.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const NEEDED_SATS = 20_000
const ASSET_UNITS = 10n
const TAXI_URL = 'https://taxi.invalid'
const TAXI_KEY = 'ab'.repeat(32)

let arkade: E2eArkade
let dir: string
let assetId: string
let solverKey: string
let proceedsScript: string

beforeAll(async () => {
  await requireStack('arkade carrier conflict', ['arkd', 'emulator'])
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
  const held = ((await arkade.ctx.wallet.getBalance()).availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) >= ASSET_UNITS)
  if (!usable) {
    throw new Error(
      'this wallet holds no asset; mint one before running the carrier conflict e2e:\n' +
        `  node --experimental-eventsource --env-file=${process.env.E2E_ENV_FILE ?? '.env.regtest.lnd'} scripts/regtest-mint-asset.mjs 1000000 ARFQ`,
    )
  }
  assetId = usable.assetId
  solverKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
  proceedsScript = hex.encode(ArkAddress.decode(await arkade.ctx.wallet.getAddress()).pkScript)
  dir = tempStoreDir()
}, SETUP_TIMEOUT_MS)

afterAll(() => arkade?.close())

const coins = async (): Promise<readonly CarrierCoin[]> =>
  spendableCarrierCoins(await arkade.ctx.wallet.getContractManager())

const spendable = (coin: CarrierCoin) => carrierTaprootEvidence(coin, [solverKey], arkade.ctx.wallet.arkServerPublicKey)

/** Sent to ourselves at a jittered value, so it is new, told apart from change, and renewed by nothing. */
const freshCoin = async (units?: bigint): Promise<CarrierCoin> => {
  const sats = 2_000 + randomInt(1, 400)
  const txid = await arkade.ctx.wallet.send({
    address: await arkade.ctx.wallet.getAddress(),
    amount: sats,
    ...(units === undefined ? {} : { assets: [{ assetId, amount: units }] }),
  })
  return poll(
    async () =>
      (await coins()).find((coin) => coin.txid === txid && coin.value === sats && spendable(coin) !== undefined) ??
      null,
    { attempts: 30, intervalMs: 2000, whenExhausted: `the ${sats}-sat coin from ${txid} never became spendable` },
  )
}

const randomTxid = (): string => randomBytes(32).toString('hex')

const assetsOf = (coin: { assets?: readonly { assetId: string; amount: bigint | string }[] }) =>
  (coin.assets ?? []).map((held) => ({ assetId: held.assetId, amount: BigInt(held.amount) }))

/** The graph a Taxi would hold: a deposit, our coin, a sponsor. Never sent; the canceller re-hashes it. */
const fillOver = (coin: CarrierCoin) => {
  const serverPubKey = arkade.ctx.wallet.arkServerPublicKey
  const stranger = () =>
    new DefaultVtxo.Script({
      pubKey: schnorr.getPublicKey(randomBytes(32)),
      serverPubKey,
      csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    })
  const theirs = (txid: string) => {
    const script = stranger()
    return { txid, vout: 0, value: 1_000, tapLeafScript: script.forfeit(), tapTree: script.encode() }
  }
  const depositTxid = randomTxid()
  const built = buildOffchainTx(
    [
      theirs(depositTxid),
      {
        txid: coin.txid,
        vout: coin.vout,
        value: coin.value,
        tapLeafScript: coin.forfeitTapLeafScript!,
        tapTree: spendable(coin)!.tapTree,
      },
      theirs(randomTxid()),
    ],
    [
      { script: stranger().pkScript, amount: arkade.ctx.dustSats },
      { script: hex.decode(proceedsScript), amount: BigInt(coin.value) + 2_000n - arkade.ctx.dustSats },
    ],
    arkade.ctx.wallet.serverUnrollScript,
  )
  const arkTx = base64.encode(built.arkTx.toPSBT())
  const checkpoints = built.checkpoints.map((tx) => base64.encode(tx.toPSBT()))
  const inputOwners = [null, 'solver', 'sponsor']
  const id = digestJointGraph({ arkTx, checkpoints, inputOwners }, OFFER_FILL_TEMPLATE)
  return { depositTxid, graph: { id, ark_tx: arkTx, checkpoints, input_owners: inputOwners } }
}

/** A receiver-paid row `filling`, its attempt `submitting` over `coin`, and the coin pinned as settle pins it. */
const seed = async (coin: CarrierCoin) => {
  const store = await AssetRfqSwapStore.open(join(dir, `conflict-${randomBytes(6).toString('hex')}.sqlite`))
  const id = `conflict-${randomBytes(6).toString('hex')}`
  const deadline = nowSeconds()
  const dust = arkade.ctx.dustSats
  const fill = fillOver(coin)
  await store.insertQuote({
    id,
    rfqId: randomTxid(),
    pair: `arkade:BTC->arkade:${assetId}`,
    fromAssetId: null,
    toAssetId: assetId,
    fromAmount: 5_000n,
    toAmount: ASSET_UNITS,
    makerPkScript: `5120${'c'.repeat(64)}`,
    makerPublicKey: 'b'.repeat(64),
    offerPkScript: `5120${randomTxid()}`,
    offerAddress: 'ark1qoffer',
    solverPubkey: solverKey,
    validUntil: deadline,
    carrierTerms: {
      mode: 'recycle_receiver',
      quoteId: 'q-conflict',
      physicalSats: dust,
      loanSats: dust,
      receiptSats: 0n,
      serviceFareSats: 0n,
      pricedSats: 0n,
      expiresAt: deadline,
      taxiUrl: TAXI_URL,
      taxiKey: TAXI_KEY,
    },
  })
  expect(await store.transition(id, 'quoted', 'funded', { deposit_txid: fill.depositTxid, deposit_vout: 0 })).toBe(true)
  expect(await store.transition(id, 'funded', 'filling', {})).toBe(true)
  const pinned = [{ txid: coin.txid, vout: coin.vout }]
  expect(
    await store.prepareCarrierAttempt(id, {
      ...encodeCarrierAttemptInputs(pinned),
      operation: id,
      provider: TAXI_URL,
      provider_key: TAXI_KEY,
      offer: 'ab',
      deposit: { txid: fill.depositTxid, vout: 0 },
      quote: { id: 'q-conflict', expires_at: deadline },
      input_expiry_floor: { kind: 'time', value: String(deadline) },
      proceeds_script: proceedsScript,
      physical_sats: String(dust),
      contribution_sats: String(dust),
      max_fare_sats: '0',
      valid_until: deadline,
    }),
  ).toBe(true)
  const prepared = (await store.readCarrierAttempt(id))!
  expect(
    await store.bindCarrierAttempt(id, prepared, { fill_id: 'fill-conflict', expires_at: deadline, graph: fill.graph }),
  ).toBe(true)
  expect(await store.markCarrierAttemptSubmitting(id, (await store.readCarrierAttempt(id))!)).toBe(true)

  const pins = createCarrierPinLedger()
  pins.adopt(id, arkade.ctx.reservations.reserve(pinned))
  return { store, id, pins, due: deadline + CARRIER_CONFLICT_AFTER_SECONDS }
}

const cancelByConflict = async (coin: CarrierCoin) => {
  const { store, id, pins, due } = await seed(coin)
  const indexer = arkade.ctx.wallet.indexerProvider
  const provider = arkade.ctx.wallet.arkProvider
  const accepted: string[] = []
  const ark: CarrierConflictArk = {
    submitTx: async (arkTx, checkpoints) => {
      const answer = await provider.submitTx(arkTx, checkpoints)
      accepted.push(answer.arkTxid)
      return answer
    },
    finalizeTx: (txid, checkpoints) => provider.finalizeTx(txid, checkpoints),
    getPendingTxs: (intent) => provider.getPendingTxs(intent),
  }
  const clock = { now: due }
  const pass = async () =>
    createCarrierConflictCanceller({
      store,
      chain: indexer,
      pins,
      ark: () => ark,
      serverUnrollScript: () => arkade.ctx.wallet.serverUnrollScript,
      signer: arkade.ctx.identity,
      coins,
      solverKeys: [solverKey],
      serverKey: () => arkade.ctx.wallet.arkServerPublicKey,
      now: () => clock.now,
    })(await store.get(id), (await store.readCarrierAttempt(id))!)
  const pinKey = `${coin.txid}:${coin.vout}`

  expect(await pass()).toEqual({ status: 'pending' })
  expect(accepted).toEqual([])
  expect((await store.readCarrierAttempt(id))!.phase).toBe('submitting')

  clock.now = due + 1
  expect(await pass()).toEqual({ status: 'pending' })
  const attempt = (await store.readCarrierAttempt(id))!
  expect(attempt.phase).toBe('cancelling')
  const conflict = attempt.binding!.conflict as { txid: string; checkpoint_txids: string[] }
  expect(accepted).toEqual([conflict.txid])
  // Accepted is not proof: the pin outlives the submit's answer.
  expect(pins.heldFor(id)).toHaveLength(1)
  expect(arkade.ctx.reservations.reserved().has(pinKey)).toBe(true)

  const landed = await poll(
    async () =>
      (await indexer.getVtxos({ outpoints: [{ txid: conflict.txid, vout: 0 }] })).vtxos.find(
        (vtxo) => vtxo.txid === conflict.txid && vtxo.vout === 0,
      ) ?? null,
    { attempts: 30, intervalMs: 2000, whenExhausted: `the conflict ${conflict.txid}:0 was never indexed` },
  )
  expect(landed.value).toBe(coin.value)
  expect(landed.script.toLowerCase()).toBe(proceedsScript)

  expect(await pass()).toEqual({ status: 'pending' })
  expect((await store.readCarrierAttempt(id))!.phase).toBe('cancelled')
  const row = await store.get(id)
  expect(row.state).toBe('refused')
  expect(row.failureReason).toContain(conflict.txid)
  expect(pins.heldFor(id)).toEqual([])
  expect(arkade.ctx.reservations.reserved().has(pinKey)).toBe(false)

  const { vtxos } = await indexer.getVtxos({ outpoints: [{ txid: coin.txid, vout: coin.vout }] })
  const spent = vtxos.find((vtxo) => vtxo.txid === coin.txid && vtxo.vout === coin.vout)
  expect(spent?.arkTxId).toBe(conflict.txid)
  expect(conflict.checkpoint_txids).toContain(spent?.spentBy)
  await store.close()
  return landed
}

describe('e2e cancel-by-conflict against a real arkd', () => {
  it(
    'spends a pinned sats coin back to the solver, and frees the pin on the pass after txid:0 is indexed',
    async () => {
      await cancelByConflict(await freshCoin())
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'carries a pinned coin’s asset to the proceeds through the aggregate packet',
    async () => {
      const coin = await freshCoin(ASSET_UNITS)
      expect(assetsOf(coin)).toEqual([{ assetId, amount: ASSET_UNITS }])
      const landed = await cancelByConflict(coin)
      expect(assetsOf(landed as { assets?: { assetId: string; amount: bigint }[] })).toEqual([
        { assetId, amount: ASSET_UNITS },
      ])
    },
    SWAP_TIMEOUT_MS,
  )
})
