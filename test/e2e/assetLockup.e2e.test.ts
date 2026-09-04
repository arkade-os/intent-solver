/**
 * An asset-denominated `VHTLC.ScriptV2` lockup spent through a covenant leaf the
 * emulator enforces — the half that was only ever unit-tested, where "builds
 * correctly" is not "co-signs". `nonInteractiveRefund` is the leaf because it
 * carries no timelock and binds the same asset clause as the other two. THIS
 * WALLET IS BOTH SIDES, as `assetOffer.e2e.test.ts` is: that leaf needs the receiver.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import { CovenantSwapScript, parseAssetId } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { findLockups, refundSwapScript } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import {
  openArkade,
  assertArkadeSpendable,
  SWAP_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  type E2eArkade,
} from './support/stack.js'

const NEEDED_SATS = 20_000
/** An asset lockup's BTC leg is a carrier, not the amount. */
const CARRIER_SATS = 1_000
const ASSET_AMOUNT = 5n

const PREIMAGE_HASH = hex.decode('00112233445566778899aabbccddeeff00112233')

let arkade: E2eArkade

beforeAll(async () => {
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
}, SETUP_TIMEOUT_MS)

afterAll(() => arkade?.close())

const heldAsset = async (): Promise<{ assetId: string; amount: bigint } | null> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) >= ASSET_AMOUNT)
  return usable ? { assetId: usable.assetId, amount: BigInt(usable.amount) } : null
}

describe('e2e asset lockup — a ScriptV2 covenant leaf spent against the emulator', () => {
  it(
    'funds an asset-denominated lockup and refunds it through the emulator-enforced leaf',
    async () => {
      const held = await heldAsset()
      if (!held) throw new Error('this wallet holds no asset; mint one before running the asset lockup e2e')

      const ctx = arkade.ctx
      const ours = await ctx.identity.xOnlyPublicKey()
      const ourPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript

      const script = new CovenantSwapScript({
        receiver: ours,
        server: ctx.wallet.arkServerPublicKey,
        preimageHash: PREIMAGE_HASH,
        refundLocktime: Math.floor(Date.now() / 1000) + 7_200,
        claimDelay: ctx.unilateralDelays.unilateralClaimDelay,
        client: ours,
        clientRefundDelay: ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: ctx.unilateralDelays.unilateralRefundDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(arkade.emulator.pubkey),
          receiverPkScript: ourPkScript,
          senderPkScript: ourPkScript,
        },
        asset: parseAssetId(held.assetId),
      })

      const address = script.address(ctx.hrp, ctx.wallet.arkServerPublicKey).encode()
      const fundingTxid = await ctx.wallet.send({
        recipients: [{ address, amount: CARRIER_SATS, assets: [{ assetId: held.assetId, amount: ASSET_AMOUNT }] }],
      })
      expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

      // Funded WITH THE ASSET: a carrier-only lockup would never reach the clause.
      const pkScriptHex = hex.encode(script.pkScript)
      const funded = await poll(
        async () => {
          const outputs = await findLockups(ctx, pkScriptHex)
          return outputs.some((output) => (output.assets ?? []).length > 0) ? outputs : null
        },
        { attempts: 40, intervalMs: 3_000, whenExhausted: 'the asset lockup never appeared at its script' },
      )
      expect(funded.map((output) => output.assets)).toEqual([[{ assetId: held.assetId, amount: ASSET_AMOUNT }]])

      // THE ASSERTION THIS FILE EXISTS FOR. A reversed txid, a missing packet or an
      // under-declared amount all land here as a refusal, not a wrong number.
      const refundTxid = await refundSwapScript(ctx, arkade.emulator.url, script, funded, ourPkScript)
      expect(refundTxid).toMatch(/^[0-9a-f]{64}$/)

      const drained = await poll(
        async () => {
          const outputs = await findLockups(ctx, pkScriptHex)
          return outputs.length === 0 ? outputs : null
        },
        { attempts: 40, intervalMs: 3_000, whenExhausted: 'the refunded lockup never left its script' },
      )
      expect(drained).toEqual([])
    },
    SWAP_TIMEOUT_MS,
  )
})
