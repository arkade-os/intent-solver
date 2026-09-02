/**
 * The offer path end to end: publish one, discover it off arkd's filtered
 * stream, decide it, and settle it against the emulator.
 *
 * This suite is the ONLY thing that exercises `fulfillOffer` for real. Its
 * construction is spec-shaped and unit-guarded, but "builds correctly" and
 * "settles" are different claims and only this makes the second.
 *
 * THIS WALLET IS BOTH SIDES. The solver is never a maker in production — an
 * offer is a standing commitment with no expiry, so publishing one writes a
 * free option. Here it is the only way to get a real offer to fill, and paying
 * ourselves still exercises the covenant, the emulator and arkd exactly as a
 * third-party maker would.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createOffer, decodeOffer, OFFER_PACKET_TYPE, type Offer } from '@arkade-os/swap'
import { asset, Extension } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import {
  openArkade,
  assertArkadeSpendable,
  SWAP_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  type E2eArkade,
} from './support/stack.js'
import { streamOfferTxs, OFFER_PACKET_FILTER } from '@arkade-os/solver-arkade/arkade/offerStream.js'
import { offerIsConsistent } from '@arkade-os/solver-arkade/arkade/offerConsistency.js'
import { offerDepositFrom } from '@arkade-os/solver-arkade/arkade/offerDeposit.js'
import { fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'

const ARKD_URL = process.env.ARK_SERVER_URL ?? 'http://localhost:7070'
/** Enough to fund a deposit and the maker payment, with room for fees. */
const NEEDED_SATS = 20_000

let arkade: E2eArkade

/** The first asset this wallet actually holds, or null when it holds none. */
const heldAsset = async (): Promise<{ assetId: string; amount: bigint } | null> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) > 0n)
  return usable ? { assetId: usable.assetId, amount: BigInt(usable.amount) } : null
}

beforeAll(async () => {
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
}, SETUP_TIMEOUT_MS)

afterAll(() => arkade?.close())

describe('e2e arkade offers — publish, discover, settle', () => {
  it(
    'discovers a published offer on the filtered stream and settles it',
    async () => {
      const held = await heldAsset()
      if (!held) throw new Error('this wallet holds no asset; mint one before running the offer e2e')

      // The maker deposits sats and wants an ASSET, so the fill exercises the
      // asset packet and the group-index-0 rule the covenant depends on.
      const wantAmount = 1n
      const depositSats = 1_000

      const controller = new AbortController()
      const seen: { txid: string; tx: string }[] = []
      const watching = (async () => {
        for await (const event of streamOfferTxs({
          arkdUrl: ARKD_URL,
          expressions: [OFFER_PACKET_FILTER],
          signal: controller.signal,
        })) {
          seen.push(event)
          break
        }
      })()

      // Give the subscription a moment to be established before publishing;
      // arkd matches on arrival, so an offer funded first is simply missed.
      await new Promise((resolve) => setTimeout(resolve, 3_000))

      const offer = await createOffer(arkade.ctx.wallet, ARKD_URL, {
        wantAmount,
        wantAsset: asset.AssetId.fromString(held.assetId),
      })
      const fundingTxid = await arkade.ctx.wallet.send({
        address: offer.address,
        amount: depositSats,
        extensions: [offer.extension],
      })

      await Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 60_000))])
      controller.abort()

      // DISCOVERY. The filter is arkd's, so this also proves it matched on the
      // offer packet rather than on everything.
      const event = seen.find((candidate) => candidate.txid === fundingTxid)
      expect(event, `the stream never delivered ${fundingTxid}`).toBeDefined()

      // The offer as a FILLER sees it: decoded from the funding tx's extension,
      // never from what `createOffer` returned to us.
      const funding = Transaction.fromPSBT(base64.decode(event!.tx))
      const packet = Extension.fromTx(funding).getPacketByType(OFFER_PACKET_TYPE)
      expect(packet, 'the funding tx carries no offer packet').not.toBeNull()
      const discovered: Offer = decodeOffer(packet!.serialize())

      // § 5.1 against the offer we recovered from the chain.
      expect(offerIsConsistent(discovered, arkade.ctx.wallet.arkServerPublicKey)).toBe(true)

      // The deposit is OBSERVED at the script, never read from the packet.
      const outputs = Array.from({ length: funding.outputsLength }, (_unused, vout) => {
        const out = funding.getOutput(vout)
        return {
          script: Buffer.from(out?.script ?? new Uint8Array()).toString('hex'),
          value: Number(out?.amount ?? 0n),
          vout,
        }
      })
      const swapScriptHex = Buffer.from(discovered.swapPkScript).toString('hex')
      const depositOut = outputs.find((out) => out.script.toLowerCase() === swapScriptHex.toLowerCase())
      expect(depositOut, 'no output at the swap script').toBeDefined()
      const deposit = offerDepositFrom(swapScriptHex, [{ script: depositOut!.script, value: depositOut!.value }])
      expect(deposit.sats).toBe(BigInt(depositSats))

      // SETTLEMENT. The emulator evaluates the covenant against what we built;
      // a refusal here is the security model working, not a flake.
      const fillTxid = await fulfillOffer(arkade.ctx, arkade.emulator.url, discovered, {
        txid: fundingTxid,
        vout: depositOut!.vout,
        value: depositOut!.value,
      })
      expect(fillTxid).toMatch(/^[0-9a-f]{64}$/)
      expect(fillTxid).not.toBe(fundingTxid)
    },
    SWAP_TIMEOUT_MS,
  )
})
