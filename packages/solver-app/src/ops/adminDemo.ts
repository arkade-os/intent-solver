/**
 * The console over seeded data: no Arkade server, Lightning node, chain or relay.
 *
 * For working on the client — `pnpm admin:dev` serves this. The stores, the admin
 * database and every route are the real ones, so a page renders what the API
 * actually returns; only the wallets, rails and price feed are stand-ins. Nothing
 * here moves money: an action reaches its real handler, which answers against the
 * stand-ins or fails, and either is what the console then shows.
 *
 * Never imported by the CLI.
 */

import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { assetRfqDescriptor } from '@arkade-os/solver-corridors/corridors/assetRfq.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { AD_HEARTBEAT_SECONDS, AdPublisher } from '@arkade-os/solver-transport/relay/adPublisher.js'
import { createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import { ArkAddress, MnemonicIdentity } from '@arkade-os/sdk'
import { Address } from '@scure/btc-signer'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { assetMarketPolicy } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { log, messageOf, nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type { FetchPrice } from '@arkade-os/solver-core/price/feed.js'
import { loadConfig, type Config } from '../config.js'
import { readerSetFromDeps } from './corridorSet.js'
import { assetRfqMarketsFrom } from './assetRfqMarkets.js'
import { TickErrorTracker } from './tickErrors.js'
import type { Services } from './services.js'
import { AdminStore } from '../admin/db.js'
import { createOfferRefusalTail } from '../admin/offerRefusals.js'
import { createRfqRefusalTail } from '../admin/rfqRefusals.js'
import { createBidTail } from '../admin/bids.js'
import { createChangeFeed, type ChangeFeed } from '../admin/events.js'
import type { AdminDeps } from '../admin/server.js'
import { deploymentCard } from '../admin/routes/card.js'

export const DEMO_ENV = {
  SWAP_NETWORK: 'regtest',
  LN_BACKEND: 'fake',
  EMULATOR_URL: 'http://127.0.0.1:9',
  ARK_SERVER_URL: 'http://127.0.0.1:9',
  ARK_MNEMONIC: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  SOLVER_NAME: 'demo-solver',
  RELAY_URL: 'wss://relay.demo.invalid',
  APPROVAL_THRESHOLD_SATS: '400000',
  NOSTR_AD_PUBLISH: 'manual',
  LN_SEND_FEE_BPS: '40',
  LN_RECEIVE_FEE_BPS: '50',
  ONCHAIN_SEND_FEE_BPS: '60',
  ONCHAIN_RECEIVE_FEE_BPS: '60',
} as const

/** `loadConfig` reads `process.env`; the caller's own (a real `.env`, say) must not leak into the demo. */
const demoConfig = (): Config => {
  const saved = process.env
  process.env = { ...DEMO_ENV }
  try {
    return loadConfig()
  } finally {
    process.env = saved
  }
}

/** Seeded, so every run (and every screenshot) shows the same rows. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const USDA = '1a'.repeat(34)
const HOUR = 3_600
const DAY = 24 * HOUR

export interface DemoConsole {
  deps: AdminDeps
  close(): Promise<void>
}

/** `live` walks one new swap through its states, a step every 15 s, so live reloads can be watched. */
export const buildDemoConsole = async (options: { live?: boolean } = {}): Promise<DemoConsole> => {
  const config = demoConfig()
  const start = nowSeconds()
  let pinned: number | null = start
  const now = () => pinned ?? nowSeconds()
  const at = (secondsAgo: number) => {
    pinned = nowSeconds() - secondsAgo
  }
  const rand = random(7)
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256))
  const hexOf = (n: number) => hex.encode(bytes(n))
  const uuid = () => {
    const h = hexOf(16)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`
  }
  const between = (low: number, high: number) => Math.round(low + rand() * (high - low))
  // Real encodings, so a layout sees real widths.
  const arkAddress = () => new ArkAddress(bytes(32), bytes(32), 'tark').encode()
  const btcAddress = () => Address(ONCHAIN_NETWORKS.regtest).encode({ type: 'tr', pubkey: bytes(32) })

  const store = await SwapStore.open(':memory:', now)
  const receiveStore = await ReceiveSwapStore.open(':memory:', now)
  const onchainStore = await OnchainSendSwapStore.open(':memory:', now)
  const onchainReceiveStore = await OnchainReceiveSwapStore.open(':memory:', now)
  const adminStore = await AdminStore.open(':memory:', now, { offerMarkets: [], tokens: [] })
  const assetRfqStore = await AssetRfqSwapStore.open(':memory:', now)

  const covenant = () => ({
    serverPubkey: hexOf(32),
    claimDelay: 512,
    refundDelay: 1_024,
    refundWithoutReceiverDelay: 1_536,
    emulatorPubkey: '02' + hexOf(32),
    pkScript: '5120' + hexOf(32),
    lockupAddress: arkAddress(),
    nonInteractiveParameters: true,
  })

  /** Arkade → Lightning. The lockup is the intake; the invoice is what was paid. */
  const send = async (
    ago: number,
    invoiceSats: number,
    end: 'claimed' | 'paid' | 'funded' | 'stuck' | 'refused' | 'quoted',
  ) => {
    at(ago)
    const id = uuid()
    const paymentHash = bytes(32)
    const lockup = invoiceSats + Math.max(150, Math.round(invoiceSats * 0.004))
    await store.insertQuote({
      id,
      invoice: forgeInvoice({
        network: 'bcrt',
        amountSats: invoiceSats,
        timestamp: now(),
        expirySeconds: HOUR,
        paymentHash,
      }),
      paymentHash: hex.encode(paymentHash),
      amountSats: lockup,
      invoiceExpiresAt: now() + HOUR,
      quotedRefundDeadline: now() + 2 * HOUR,
      refundLocktime: now() + 2 * HOUR,
      senderPubkey: hexOf(32),
      receiverPubkey: hexOf(32),
      ...covenant(),
    })
    if (end === 'quoted') return id
    if (end === 'refused') {
      at(ago - 600)
      await store.transition(id, 'quoted', 'refused', { failure_reason: 'quote expired before funding' })
      return id
    }
    at(ago - 40)
    await store.transition(id, 'quoted', 'funded', { lockup_txid: hexOf(32), lockup_vout: 0, lockup_value: lockup })
    if (end === 'funded') return id
    await store.transition(id, 'funded', 'paying', { pay_attempted_at: now() })
    if (end === 'stuck') {
      at(ago - 900)
      await store.transition(id, 'paying', 'stuck', { failure_reason: 'payment outcome unknown after 3 reads' })
      return id
    }
    at(ago - 45)
    await store.transition(id, 'paying', 'paid', { payment_id: hexOf(32) })
    if (end === 'paid') return id
    await store.transition(id, 'paid', 'claiming', { preimage: hexOf(32) })
    at(ago - 52)
    await store.transition(id, 'claiming', 'claimed', { claim_ark_txid: hexOf(32) })
    return id
  }

  /** Lightning → Arkade. */
  const receive = async (ago: number, sats: number, end: 'settled' | 'funded' | 'stuck' | 'refunded' | 'armed') => {
    at(ago)
    const id = uuid()
    const preimage = bytes(32)
    const paymentHash = sha256(preimage)
    await receiveStore.insertQuote({
      id,
      paymentHash: hex.encode(paymentHash),
      amountSats: sats,
      payoutSats: sats - Math.max(150, Math.round(sats * 0.005)),
      invoice: forgeInvoice({ network: 'bcrt', amountSats: sats, timestamp: now(), expirySeconds: 600, paymentHash }),
      invoiceExpiresAt: now() + 600,
      payoutAddress: arkAddress(),
      payoutPkScript: '5120' + hexOf(32),
      payoutPubkey: hexOf(32),
      claimPacket: null,
      refundLocktime: now() + 2 * HOUR,
      solverPubkey: hexOf(32),
      solverRefundPkScript: '5120' + hexOf(32),
      ...covenant(),
    })
    await receiveStore.transition(id, 'quoted', 'armed', { htlc_expires_at: now() + HOUR })
    if (end === 'armed') return id
    at(ago - 30)
    await receiveStore.transition(id, 'armed', 'funded', {
      arkade_lockup_txid: hexOf(32),
      arkade_lockup_vout: 0,
      arkade_lockup_value: sats,
      fund_started_at: now(),
    })
    if (end === 'funded') return id
    if (end === 'refunded') {
      at(ago - 4 * HOUR)
      await receiveStore.transition(id, 'funded', 'refunding', { failure_reason: 'payer never revealed the preimage' })
      await receiveStore.transition(id, 'refunding', 'refunded', { refund_ark_txid: hexOf(32) })
      return id
    }
    at(ago - 70)
    await receiveStore.transition(id, 'funded', 'claimed', { preimage: hex.encode(preimage) })
    if (end === 'stuck') {
      at(ago - 1_800)
      await receiveStore.transition(id, 'claimed', 'stuck', {
        failure_reason: 'hold invoice settle refused: htlc expired',
      })
      return id
    }
    at(ago - 75)
    await receiveStore.transition(id, 'claimed', 'settled')
    return id
  }

  /** Arkade → onchain. */
  const onchainSend = async (ago: number, sats: number, end: 'claimed' | 'awaiting_claim' | 'refunded') => {
    at(ago)
    const id = uuid()
    await onchainStore.insertQuote({
      id,
      paymentHash: hexOf(32),
      amountSats: sats,
      payoutSats: sats - Math.max(600, Math.round(sats * 0.006)),
      refundLocktime: now() + 6 * HOUR,
      providerPubkey: hexOf(32),
      refundPkScript: '5120' + hexOf(32),
      clientRefundPubkey: hexOf(32),
      receiverPkScript: '5120' + hexOf(32),
      payoutPubkey: hexOf(32),
      htlcPubkey: hexOf(32),
      htlcLocktime: now() + 3 * HOUR,
      minConfirmations: 1,
      onchainAddress: btcAddress(),
      onchainPkScript: '5120' + hexOf(32),
      ...covenant(),
    })
    at(ago - 60)
    await onchainStore.transition(id, 'quoted', 'funded')
    await onchainStore.transition(id, 'funded', 'funding_onchain', { funding_txid: hexOf(32), funding_vout: 1 })
    at(ago - 700)
    await onchainStore.transition(id, 'funding_onchain', 'awaiting_claim', {
      onchain_lockup_txid: hexOf(32),
      onchain_lockup_vout: 0,
      onchain_lockup_value: sats,
    })
    if (end === 'awaiting_claim') return
    if (end === 'refunded') {
      at(ago - 3 * HOUR)
      await onchainStore.transition(id, 'awaiting_claim', 'refunding_onchain')
      at(ago - 3 * HOUR - 900)
      await onchainStore.transition(id, 'refunding_onchain', 'refunded', { onchain_refund_txid: hexOf(32) })
      return
    }
    at(ago - 1_400)
    await onchainStore.transition(id, 'awaiting_claim', 'claiming', { preimage: hexOf(32) })
    await onchainStore.transition(id, 'claiming', 'claimed', { claim_ark_txid: hexOf(32) })
  }

  /** Onchain → Arkade. */
  const onchainReceive = async (ago: number, sats: number, end: 'settled' | 'awaiting_confirmations') => {
    at(ago)
    const id = uuid()
    const payout = sats - Math.max(600, Math.round(sats * 0.006))
    await onchainReceiveStore.insertQuote({
      id,
      paymentHash: hexOf(32),
      amountSats: sats,
      payoutSats: payout,
      htlcLocktime: now() + 6 * HOUR,
      refundLocktime: now() + 3 * HOUR,
      minConfirmations: 1,
      providerPubkey: hexOf(32),
      clientPayoutPubkey: hexOf(32),
      refundPkScript: '5120' + hexOf(32),
      clientPayoutPkScript: '5120' + hexOf(32),
      htlcPubkey: hexOf(32),
      clientOnchainRefundPubkey: hexOf(32),
      onchainAddress: btcAddress(),
      onchainPkScript: '5120' + hexOf(32),
      claimPacket: null,
      ...covenant(),
    })
    at(ago - 120)
    await onchainReceiveStore.transition(id, 'quoted', 'awaiting_confirmations', {
      funding_txid: hexOf(32),
      funding_vout: 0,
    })
    if (end === 'awaiting_confirmations') return
    at(ago - 720)
    await onchainReceiveStore.transition(id, 'awaiting_confirmations', 'funding_arkade', {
      funded_value_sats: sats,
      funded_payout_sats: payout,
      arkade_fund_txid: hexOf(32),
    })
    await onchainReceiveStore.transition(id, 'funding_arkade', 'awaiting_claim')
    at(ago - 800)
    await onchainReceiveStore.transition(id, 'awaiting_claim', 'claimed', {
      preimage: hexOf(32),
      arkade_claim_txid: hexOf(32),
    })
    at(ago - 1_500)
    await onchainReceiveStore.transition(id, 'claimed', 'settled', { onchain_claim_txid: hexOf(32) })
  }

  // A week of delivered swaps, oldest first, so the P&L chart has a shape.
  for (let ago = 7 * DAY; ago > 2 * HOUR; ago -= between(2 * HOUR, 9 * HOUR)) {
    const pick = rand()
    if (pick < 0.4) await send(ago, between(5_000, 250_000), 'claimed')
    else if (pick < 0.75) await receive(ago, between(10_000, 300_000), 'settled')
    else if (pick < 0.9) await onchainSend(ago, between(50_000, 800_000), 'claimed')
    else await onchainReceive(ago, between(50_000, 800_000), 'settled')
  }
  // The rows an operator acts on: failures, money in flight, and fresh quotes.
  await send(3 * DAY, 120_000, 'refused')
  await receive(2 * DAY, 64_000, 'refunded')
  await onchainSend(DAY + 5 * HOUR, 410_000, 'refunded')
  const stuck = await send(5 * HOUR, 182_000, 'stuck')
  await receive(3 * HOUR, 95_000, 'stuck')
  const paid = await send(400, 61_500, 'paid')
  await receive(300, 210_000, 'funded')
  await onchainSend(1_200, 525_000, 'awaiting_claim')
  await onchainReceive(900, 300_000, 'awaiting_confirmations')
  await receive(120, 25_000, 'armed')
  await send(45, 18_000, 'quoted')
  // Above APPROVAL_THRESHOLD_SATS, so it waits funded for an operator.
  const held = await send(600, 640_000, 'funded')

  at(6 * DAY)
  await adminStore.putMarket({
    base: null,
    quote: USDA,
    baseDecimals: 8,
    quoteDecimals: 2,
    feedUrl: 'https://price.demo.invalid/simple/price?ids=bitcoin&vs_currencies=usd',
    pricePath: '/bitcoin/usd',
    toleranceBps: 100,
    feeBps: 40,
    sellBase: { min: 1_000n, max: 500_000n },
    buyBase: { min: 10_000n, max: 5_000_000n },
    enabled: true,
    symbol: 'USDA',
    servesOffer: false,
    servesRfq: true,
    rfqSellBase: true,
    rfqBuyBase: true,
    carrierMode: 'inherit',
  })
  const assetMarkets = assetMarketPolicy(await adminStore.listMarkets()).pricing
  const assetRfqMarkets = assetRfqMarketsFrom(assetMarkets, {
    dustSats: 330n,
    pricedByDefault: config.assetCarrierPricing,
  })
  /** BTC → USDA at a quoted price, filled at a slightly different one: the P&L screen's FX drift. */
  const assetFill = async (ago: number, sats: number, quoted: number, filled: number) => {
    at(ago)
    const id = uuid()
    const cents = BigInt(Math.floor((sats / 1e8) * quoted * 100 * 0.996))
    await assetRfqStore.insertQuote({
      id,
      rfqId: uuid(),
      pair: assetRfqDescriptor(assetRfqMarkets[0]!, 'sell_base').pair,
      fromAssetId: null,
      fromAmount: BigInt(sats),
      toAssetId: USDA,
      toAmount: cents,
      makerPkScript: '5120' + hexOf(32),
      makerPublicKey: hexOf(32),
      offerPkScript: '5120' + hexOf(32),
      offerAddress: arkAddress(),
      solverPubkey: hexOf(32),
      validUntil: now() + 60,
      quotePrice: { impliedMantissa: BigInt(Math.round(quoted * 100)), scale: 2, givesBase: true },
    })
    at(ago - 20)
    await assetRfqStore.transition(id, 'quoted', 'funded', { deposit_txid: hexOf(32), deposit_vout: 0 })
    await assetRfqStore.transition(id, 'funded', 'filling')
    at(ago - 25)
    await assetRfqStore.transition(id, 'filling', 'filled', { fill_txid: hexOf(32) })
    await assetRfqStore.recordFillMark(id, { mantissa: BigInt(Math.round(filled * 100)), scale: 2 })
  }
  await assetFill(5 * DAY, 400_000, 62_910.5, 62_955.25)
  await assetFill(3 * DAY + 4 * HOUR, 1_250_000, 63_480.0, 63_402.75)
  await assetFill(20 * HOUR, 150_000, 63_377.4, 63_390.1)

  at(4 * HOUR)
  await adminStore.recordAction({
    action: 'read-payment',
    target: stuck,
    params: JSON.stringify({ id: stuck, corridor: 'arkade:BTC->lightning:BTC' }),
    outcome: 'error',
    detail: 'backend timed out after 30s',
  })
  at(HOUR)
  await adminStore.setOverrideWithAudit('MAX_EXPOSED_SATS', '2000000', {
    action: 'settings',
    target: 'MAX_EXPOSED_SATS',
    params: JSON.stringify({ MAX_EXPOSED_SATS: '2000000' }),
    outcome: 'ok',
    detail: null,
  })
  at(600)
  await adminStore.recordApprovalRequest({
    swapId: held,
    corridor: 'arkade:BTC->lightning:BTC',
    assetId: null,
    amount: BigInt((await store.get(held)).amountSats),
  })
  pinned = null

  const tickErrors = new TickErrorTracker(() => now() * 1_000)
  const rfqRefusals = createRfqRefusalTail()
  rfqRefusals.record({
    at: now() - 50 * 60,
    transport: 'relay',
    requestType: 'rfq_request',
    rfqId: uuid(),
    reason: 'amount_out_of_range',
    detail: 'from_amount 4500000 above the corridor maximum of 1000000',
  })
  rfqRefusals.record({
    at: now() - 8 * 60,
    transport: 'http',
    requestType: 'rfq_request',
    rfqId: uuid(),
    reason: 'unsupported_pair',
    detail: 'arkade:BTC->ethereum:USDC is not served by this solver',
  })
  const bids = createBidTail()
  for (let ago = 3 * HOUR; ago > 0; ago -= between(10 * 60, 40 * 60)) {
    bids.record({
      at: now() - ago,
      pair: rand() < 0.5 ? 'arkade:BTC->lightning:BTC' : 'lightning:BTC->arkade:BTC',
      amountSats: rand() < 0.2 ? null : between(10_000, 400_000),
      feeBps: between(30, 60),
      validUntil: now() - ago + 60,
    })
  }

  // Re-recorded the way the sweep would, or the entry goes stale and leaves the `failing` panel.
  const failing = new Error('lightning backend: getPayment timed out after 30s')
  tickErrors.record(paid, failing)
  const timers = [setInterval(() => tickErrors.record(paid, failing), 60_000)]
  let live: { id: string; sats: number; state: 'armed' | 'funded' | 'claimed' } | null = null
  const advance = async () => {
    if (live === null) {
      const sats = between(10_000, 250_000)
      live = { id: await receive(0, sats, 'armed'), sats, state: 'armed' }
      pinned = null
    } else if (live.state === 'armed') {
      await receiveStore.transition(live.id, 'armed', 'funded', {
        arkade_lockup_txid: hexOf(32),
        arkade_lockup_vout: 0,
        arkade_lockup_value: live.sats,
        fund_started_at: now(),
      })
      live.state = 'funded'
    } else if (live.state === 'funded') {
      await receiveStore.transition(live.id, 'funded', 'claimed', { preimage: hexOf(32) })
      live.state = 'claimed'
    } else {
      await receiveStore.transition(live.id, 'claimed', 'settled')
      live = null
    }
  }
  if (options.live) timers.push(setInterval(() => advance().catch((error) => log('demo:', messageOf(error))), 15_000))
  for (const timer of timers) timer.unref()

  const offerRefusals = createOfferRefusalTail()
  const identity = MnemonicIdentity.fromMnemonic(DEMO_ENV.ARK_MNEMONIC, { isMainnet: false })

  const walletAddress = arkAddress()
  const boardingAddress = btcAddress()
  const wallet = {
    getBalance: async () => ({
      boarding: { confirmed: 50_000, unconfirmed: 12_000, total: 62_000 },
      settled: 3_480_000,
      preconfirmed: 145_000,
      available: 3_390_000,
      recoverable: 0,
      total: 3_687_000,
      assets: [{ assetId: USDA, amount: 1_250_000n }],
      availableAssets: [{ assetId: USDA, amount: 1_250_000n }],
    }),
    getAddress: async () => walletAddress,
    getBoardingAddress: async () => boardingAddress,
    getSpendableVtxos: async () =>
      Array.from({ length: 6 }, (_, vout) => ({ txid: 'c0'.repeat(32), vout, value: 565_000 })),
    arkProvider: { getInfo: async () => ({ dust: 330n }) },
    assetManager: {
      getAssetDetails: async (assetId: string) => ({
        assetId,
        supply: 10_000_000_000n,
        metadata: { ticker: 'USDA', name: 'Demo dollar', decimals: 2 },
      }),
    },
  }

  const services = {
    config,
    policy: config,
    bootPolicy: config,
    bootOverrides: {},
    assetMarkets,
    store,
    receiveStore,
    onchainStore,
    onchainReceiveStore,
    evmSendStore: null,
    evmReceiveStore: null,
    evmSendService: null,
    evmReceiveService: null,
    offerStore: null,
    assetOffers: null,
    liveOfferMarkets: [],
    offerRefusals,
    rfqRefusals,
    assetRfqStore,
    assetRfqMarkets,
    replaceMarkets: async () => {},
    replacePolicy: async () => {},
    adminStore,
    arkade: {
      wallet,
      identity,
      reservations: createReservationLedger(),
      dustSats: 330n,
      vtxoMinSats: 330n,
      hrp: 'tark',
      arkServerUrl: config.arkade.arkServerUrl,
      close: () => {},
    },
    tickErrors,
    ln: {
      getBalance: async () => ({ availableSats: 2_150_000, incomingSats: 1_400_000 }),
    },
    onchain: {
      getBalance: async () => ({ confirmedSats: 4_800_000, unconfirmedSats: 0 }),
      estimateFeeRate: async () => 4,
    },
    // Empty: an action that drives a swap answers "not enabled" rather than stepping a stand-in.
    corridors: createCorridorSet([]),
    readers: readerSetFromDeps({
      store,
      onchainStore,
      receiveStore,
      onchainReceiveStore,
      assetRfqStore,
      assetRfqMarkets,
    }),
    emulatorPubkey: '02' + 'e'.repeat(64),
    providerPubkey: hex.encode(await identity.xOnlyPublicKey()),
    close: async () => {},
  } as unknown as Services

  const fetchPrice: FetchPrice = async () => ({ mantissa: 6_349_849n, scale: 2 })
  const changes: ChangeFeed = createChangeFeed(services)
  changes.start()
  const adPublisher = new AdPublisher({
    mode: config.nostrAdPublish,
    buildAd: () => deploymentCard(services, DEMO_ENV.SOLVER_NAME),
    publish: async () => {},
    now,
    heartbeatSeconds: AD_HEARTBEAT_SECONDS,
  })
  await adPublisher.publishNow()

  return {
    deps: {
      services,
      startedAt: start - 3 * DAY,
      mode: 'relay',
      relay: { url: DEMO_ENV.RELAY_URL, isConnected: () => true },
      bids,
      adPublisher,
      changes,
      fetchPrice,
    },
    close: async () => {
      for (const timer of timers) clearInterval(timer)
      changes.stop()
      for (const closable of [store, receiveStore, onchainStore, onchainReceiveStore, assetRfqStore, adminStore]) {
        await closable.close()
      }
    },
  }
}
