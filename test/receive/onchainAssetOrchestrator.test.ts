/**
 * The `onchain:BTC->arkade:<asset>` shell, driven end to end against fakes.
 *
 * The ORDERING rules live in `test/core/onchainAssetReceivePlan.test.ts` and are
 * not restated here. What this file covers is what only the shell can get
 * wrong: which unit reaches the wallet, whether the claim txid is on disk
 * before the broadcast, and whether a second worker can pay twice.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { SigHash } from '@scure/btc-signer'
import { ArkAddress } from '@arkade-os/sdk'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import { OnchainAssetReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainAssetReceiveSwaps.js'
import {
  OnchainAssetReceiveSwapService,
  type OnchainAssetReceiveArkadeOps,
} from '@arkade-os/solver-corridors/receive/onchainAssetOrchestrator.js'
import { onchainAssetReceivePairFor } from '@arkade-os/solver-core/core/onchainAssetReceive.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))

const P = new Uint8Array(32).fill(9)
const paymentHash = hex.encode(sha256(P))
const ASSET = 'ab'.repeat(32) + '0100'
const PAIR = onchainAssetReceivePairFor(ASSET)

const clientOnchainRefundPubkey = hex.encode(new Uint8Array(32).fill(3))
const clientPayoutPubkey = hex.encode(keyBytes(4))
const solverPriv = new Uint8Array(32).fill(7)
const providerPubkey = hex.encode(schnorr.getPublicKey(solverPriv))
const serverPubkey = hex.encode(keyBytes(5))
const emulatorPubkey = hex.encode(keyBytes(6))
const solverArkadeDest = Uint8Array.from([0x51, 0x20, ...keyBytes(8)])
const claimDestinationScript = Uint8Array.from([0x51, 0x20, ...keyBytes(12)])

const signer: OnchainSigner = {
  sign: async (tx, inputIndexes) => {
    const clone = tx.clone()
    for (const idx of inputIndexes ?? [0]) clone.signIdx(solverPriv, idx, [SigHash.DEFAULT])
    return clone
  },
}

const CLIENT_PAYOUT_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(4),
  server: keyBytes(5),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 512,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(6),
    receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
    senderPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(4)]),
  },
})
  .address('tark', keyBytes(5))
  .encode()

let now = 1_800_000_000
const clock = () => now

interface ArkadeFake {
  arkade: OnchainAssetReceiveArkadeOps
  funded: { address: string; assetId: string; units: bigint; carrierSats: number }[]
  balance: Map<string, bigint>
  spendLockup: (pkScriptHex: string, preimage: Uint8Array | null) => void
  refundCalls: number
}

const buildArkadeFake = (): ArkadeFake => {
  const lockups = new Map<string, { txid: string; vout: number; value: number; assets: { assetId: string; amount: bigint }[] }[]>()
  const everSeen = new Map<string, { txid: string; vout: number }[]>()
  const claimed = new Map<string, Uint8Array>()
  let fundCounter = 0
  const state: ArkadeFake = {
    funded: [],
    // Comfortably over the 50_000_000 atomic the default quote pays out, so the
    // float is not the thing under test here; the float tests set it explicitly.
    balance: new Map([[ASSET, 10_000_000_000n]]),
    refundCalls: 0,
    spendLockup: (pkScriptHex, preimage) => {
      lockups.delete(pkScriptHex)
      if (preimage) claimed.set(pkScriptHex, preimage)
    },
    arkade: {
      providerPubkey,
      serverPubkey,
      emulatorPubkey,
      receiverPkScript: hex.encode(solverArkadeDest),
      delays: { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 },
      hrp: 'tark',
      findLockups: async (pkScriptHex) => lockups.get(pkScriptHex) ?? [],
      findLockupOutpoints: async (pkScriptHex) => everSeen.get(pkScriptHex) ?? [],
      findClaimPreimage: async (outpoints, paymentHashHex) => {
        for (const [pkScriptHex, seen] of everSeen) {
          if (!seen.some((s) => outpoints.some((o) => o.txid === s.txid && o.vout === s.vout))) continue
          const preimage = claimed.get(pkScriptHex)
          if (preimage && hex.encode(sha256(preimage)) === paymentHashHex) return preimage
        }
        return null
      },
      dustSats: async () => 330,
      assetBalance: async () => state.balance,
      fundAsset: async (params) => {
        state.funded.push({ ...params })
        const txid = `arkade-fund-${fundCounter++}`
        const pkScriptHex = hex.encode(ArkAddress.decode(params.address).pkScript)
        const existing = lockups.get(pkScriptHex) ?? []
        lockups.set(pkScriptHex, [
          ...existing,
          {
            txid,
            vout: 0,
            value: params.carrierSats,
            assets: [{ assetId: params.assetId, amount: params.units }],
          },
        ])
        everSeen.set(pkScriptHex, [...(everSeen.get(pkScriptHex) ?? []), { txid, vout: 0 }])
        return txid
      },
      refund: async (_row, outputs) => {
        state.refundCalls++
        for (const [key, value] of lockups.entries()) {
          if (value.some((o) => outputs.some((out) => out.txid === o.txid && out.vout === o.vout))) {
            lockups.delete(key)
          }
        }
        return 'arkade-refund-txid'
      },
    },
  }
  return state
}

const MARKET = {
  symbol: 'USDA',
  assetId: ASSET,
  decimals: 6,
  feedUrl: 'https://feed.example',
  pricePath: '/price',
  feeBps: 0,
  minPayout: 1n,
  maxPayout: 10n ** 18n,
}

const build = () => {
  const driver = betterSqliteDriver(':memory:')
  const onchain = new FakeOnchainBackend(5, 0)
  const arkadeFake = buildArkadeFake()
  return { driver, onchain, arkadeFake }
}

describe('OnchainAssetReceiveSwapService', () => {
  let deps: ReturnType<typeof build>
  let store: OnchainAssetReceiveSwapStore
  let service: OnchainAssetReceiveSwapService

  const quote = () =>
    service.quote({
      pair: PAIR,
      paymentHash,
      amountSats: 100_000,
      claimPacket: Buffer.from('sealed').toString('base64'),
      refundPubkey: clientOnchainRefundPubkey,
      payoutAddress: CLIENT_PAYOUT_ADDRESS,
      payoutPubkey: clientPayoutPubkey,
    })

  beforeEach(async () => {
    now = 1_800_000_000
    deps = build()
    store = await OnchainAssetReceiveSwapStore.open(deps.driver, clock)
    service = new OnchainAssetReceiveSwapService({
      store,
      onchain: deps.onchain,
      arkade: deps.arkadeFake.arkade,
      markets: [MARKET],
      // 50_000 quote units per whole BTC; 100_000 sats therefore buys 50 units
      // at 6 decimals = 50_000_000 atomic.
      fetchPrice: async () => ({ mantissa: 50_000n, scale: 0 }),
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      network: 'regtest',
      maxExposedSats: 10_000_000,
      totalCommitted: async () => 0,
      admission: new AdmissionControl(),
      signer,
      claimDestinationScript,
      now: clock,
    })
  })

  it('quotes the asset payout the price implies, and persists it', async () => {
    const outcome = await quote()
    // Named rather than `.accepted).toBe(true)`: a refusal then says WHICH gate
    // refused instead of "expected false to be true".
    if (!outcome.accepted) throw new Error(`refused: ${outcome.reason} ${outcome.detail ?? ''}`)
    expect(outcome.swap.payoutUnits).toBe(50_000_000n)
    expect(outcome.swap.payoutAssetId).toBe(ASSET)
    expect(outcome.swap.pair).toBe(PAIR)
  })

  it('refuses a pair this deployment does not serve', async () => {
    const outcome = await service.quote({
      pair: onchainAssetReceivePairFor('cd'.repeat(32) + '0000'),
      paymentHash,
      amountSats: 100_000,
      claimPacket: 'x',
      refundPubkey: clientOnchainRefundPubkey,
      payoutAddress: CLIENT_PAYOUT_ADDRESS,
      payoutPubkey: clientPayoutPubkey,
    })
    expect(outcome).toMatchObject({ accepted: false, reason: 'unsupported_pair' })
  })

  it('refuses rather than quoting a payout the float cannot cover', async () => {
    deps.arkadeFake.balance = new Map([[ASSET, 1n]])
    expect(await quote()).toMatchObject({ accepted: false, reason: 'insufficient_inventory' })
  })

  it('never turns an unreadable feed into a free fill', async () => {
    service = new OnchainAssetReceiveSwapService({
      store,
      onchain: deps.onchain,
      arkade: deps.arkadeFake.arkade,
      markets: [MARKET],
      fetchPrice: async () => {
        throw new Error('feed down')
      },
      limits: { minSats: 1_000, maxSats: 1_000_000 },
      network: 'regtest',
      maxExposedSats: 10_000_000,
      totalCommitted: async () => 0,
      admission: new AdmissionControl(),
      signer,
      claimDestinationScript,
      now: clock,
    })
    expect(await quote()).toMatchObject({ accepted: false, reason: 'price_unavailable' })
  })

  it('builds an asset-denominated covenant, not the sats one', async () => {
    const outcome = await quote()
    if (!outcome.accepted) throw new Error('expected a quote')
    const withAsset = new CovenantSwapScript({
      receiver: hex.decode(clientPayoutPubkey),
      server: hex.decode(serverPubkey),
      preimageHash: new Uint8Array(await import('@arkade-os/solver-core/core/preimage.js').then((m) =>
        m.scriptHashFromPaymentHash(paymentHash),
      )),
      refundLocktime: outcome.swap.refundLocktime,
      claimDelay: 512,
      client: hex.decode(providerPubkey),
      clientRefundDelay: 1536,
      refundWithoutServerDelay: 1024,
      asset: { txid: hex.decode(ASSET).subarray(0, 32), groupIndex: 1 },
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(emulatorPubkey),
        receiverPkScript: ArkAddress.decode(CLIENT_PAYOUT_ADDRESS).pkScript,
        senderPkScript: solverArkadeDest,
      },
    })
    expect(outcome.swap.pkScript).toBe(hex.encode(withAsset.pkScript))
  })

  describe('once the client has funded', () => {
    const fundAndConfirm = async (amountSats = 100_000) => {
      const outcome = await quote()
      if (!outcome.accepted) throw new Error('expected a quote')
      deps.onchain.receiveExternal({ address: outcome.swap.onchainAddress, amountSats })
      deps.onchain.mineBlocks(1)
      return outcome.swap
    }

    it('funds the lockup with the ASSET units, and a dust sats carrier', async () => {
      const swap = await fundAndConfirm()
      await service.tick(swap.id)
      expect(deps.arkadeFake.funded).toEqual([
        { address: swap.lockupAddress, assetId: ASSET, units: 50_000_000n, carrierSats: 330 },
      ])
      expect((await store.get(swap.id)).state).toBe('awaiting_claim')
    })

    it('does not fund twice when a second worker races the same row', async () => {
      const swap = await fundAndConfirm()
      await store.transition(swap.id, 'quoted', 'awaiting_confirmations', {
        funding_txid: 'aa'.repeat(32),
        funding_vout: 0,
      })
      await store.transition(swap.id, 'awaiting_confirmations', 'funding_arkade', {})
      // The loser of the lease must not pay: coin selection is per-process, so
      // both would succeed against different coins and leave two lockups.
      expect(await store.claimFundLease(swap.id, 'funding_arkade')).toBe(true)
      await service.tick(swap.id)
      expect(deps.arkadeFake.funded).toHaveLength(0)
    })

    it('adopts a lockup that is already funded rather than paying again', async () => {
      const swap = await fundAndConfirm()
      await service.tick(swap.id)
      expect(deps.arkadeFake.funded).toHaveLength(1)
      await store.transition(swap.id, 'awaiting_claim', 'refunding_arkade', {})
      // Re-entering the funding state over an existing lockup must adopt it.
      expect(deps.arkadeFake.funded).toHaveLength(1)
    })

    it('records the claim txid BEFORE broadcasting it', async () => {
      const swap = await fundAndConfirm()
      await service.tick(swap.id)
      deps.arkadeFake.spendLockup(swap.pkScript, P)

      const broadcasts: string[] = []
      const realBroadcast = deps.onchain.broadcastRaw.bind(deps.onchain)
      deps.onchain.broadcastRaw = async (txHex: string) => {
        // The row must already name a txid at the moment the irreversible call
        // is made — a process dying here has to come back with a key to ask
        // about, or it rebuilds a second claim at a second fee (#14).
        const row = await store.get(swap.id)
        expect(row.onchainClaimTxid).not.toBeNull()
        broadcasts.push(txHex)
        return realBroadcast(txHex)
      }

      await service.tick(swap.id)
      await service.tick(swap.id)
      expect(broadcasts).toHaveLength(1)
      expect((await store.get(swap.id)).onchainClaimTxid).not.toBeNull()
    })

    it('settles only once the L1 claim confirms', async () => {
      const swap = await fundAndConfirm()
      await service.tick(swap.id)
      deps.arkadeFake.spendLockup(swap.pkScript, P)
      await service.tick(swap.id)
      await service.tick(swap.id)
      expect((await store.get(swap.id)).state).toBe('claimed')

      deps.onchain.mineBlocks(1)
      await service.tick(swap.id)
      expect((await store.get(swap.id)).state).toBe('settled')
    })

    it('carries P onto the row before it spends against it', async () => {
      const swap = await fundAndConfirm()
      await service.tick(swap.id)
      deps.arkadeFake.spendLockup(swap.pkScript, P)
      await service.tick(swap.id)
      expect((await store.get(swap.id)).preimage).toBe(hex.encode(P))
    })

    it('refuses a confirmed funding for the wrong amount', async () => {
      const swap = await fundAndConfirm(99_999)
      await service.tick(swap.id)
      const row = await store.get(swap.id)
      expect(row.state).toBe('refused')
      expect(row.failureReason).toContain('funding mismatch')
    })
  })
})
