/**
 * An asset-denominated `VHTLC.ScriptV2` lockup spent through a covenant leaf the
 * emulator enforces — the half that was only ever unit-tested, where "builds
 * correctly" is not "co-signs". `nonInteractiveRefund` is the leaf because it
 * carries no timelock and binds the same asset clause as the other two. THIS
 * WALLET IS BOTH SIDES, as `assetOffer.e2e.test.ts` is: that leaf needs the receiver.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { ArkAddress, asset } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { claimSwapScript, findLockups, refundSwapScript } from '@arkade-os/solver-arkade/arkade/wallet.js'
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
const SATS_LOCKUP_SATS = 5_000
const ASSET_AMOUNT = 5n

const PREIMAGE_HASH = hex.decode('00112233445566778899aabbccddeeff00112233')

let arkade: E2eArkade

beforeAll(async () => {
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
}, SETUP_TIMEOUT_MS)

afterAll(() => arkade?.close())

const heldAsset = async (): Promise<{ assetId: string; amount: bigint }> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) >= ASSET_AMOUNT)
  if (!usable) throw new Error('this wallet holds no asset; mint one before running the asset lockup e2e')
  return { assetId: usable.assetId, amount: BigInt(usable.amount) }
}

const lockupScript = async (preimageHash: Uint8Array, assetId?: string): Promise<CovenantSwapScript> => {
  const ctx = arkade.ctx
  const ours = await ctx.identity.xOnlyPublicKey()
  const ourPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript
  return new CovenantSwapScript({
    receiver: ours,
    server: ctx.wallet.arkServerPublicKey,
    preimageHash,
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
    ...(assetId ? { asset: asset.AssetId.fromString(assetId) } : {}),
  })
}

/** Pays `sats` plus {@link ASSET_AMOUNT} of `assetId` to the script, and waits until the indexer shows the asset. */
const fundWithAsset = async (script: CovenantSwapScript, sats: number, assetId: string) => {
  const ctx = arkade.ctx
  const address = script.address(ctx.hrp, ctx.wallet.arkServerPublicKey).encode()
  const fundingTxid = await ctx.wallet.send({
    recipients: [{ address, amount: sats, assets: [{ assetId, amount: ASSET_AMOUNT }] }],
  })
  expect(fundingTxid).toMatch(/^[0-9a-f]{64}$/)

  const funded = await poll(
    async () => {
      const outputs = await findLockups(ctx, hex.encode(script.pkScript))
      return outputs.some((output) => (output.assets ?? []).length > 0) ? outputs : null
    },
    { attempts: 40, intervalMs: 3_000, whenExhausted: 'the asset lockup never appeared at its script' },
  )
  expect(funded.map((output) => output.assets)).toEqual([[{ assetId, amount: ASSET_AMOUNT }]])
  return funded
}

const expectDrained = async (script: CovenantSwapScript): Promise<void> => {
  const drained = await poll(
    async () => {
      const outputs = await findLockups(arkade.ctx, hex.encode(script.pkScript))
      return outputs.length === 0 ? outputs : null
    },
    { attempts: 40, intervalMs: 3_000, whenExhausted: 'the spent lockup never left its script' },
  )
  expect(drained).toEqual([])
}

describe('e2e asset lockup — a ScriptV2 covenant leaf spent against the emulator', () => {
  it(
    'funds an asset-denominated lockup and refunds it through the emulator-enforced leaf',
    async () => {
      const held = await heldAsset()
      const ctx = arkade.ctx
      const ourPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript

      // Funded WITH THE ASSET: a carrier-only lockup would never reach the clause.
      const script = await lockupScript(PREIMAGE_HASH, held.assetId)
      const funded = await fundWithAsset(script, CARRIER_SATS, held.assetId)

      // THE ASSERTION THIS FILE EXISTS FOR. A reversed txid, a missing packet or an
      // under-declared amount all land here as a refusal, not a wrong number.
      const refundTxid = await refundSwapScript(ctx, arkade.emulator.url, script, funded, ourPkScript)
      expect(refundTxid).toMatch(/^[0-9a-f]{64}$/)
      await expectDrained(script)
    },
    SWAP_TIMEOUT_MS,
  )
})

describe('e2e asset lockup — the claim leaf of a SATS lockup that was also sent an asset', () => {
  it(
    'claims the lockup, carrying the stray asset to the claim destination',
    async () => {
      const held = await heldAsset()
      const preimage = randomBytes(32)
      const script = await lockupScript(ripemd160(sha256(preimage)))
      const funded = await fundWithAsset(script, SATS_LOCKUP_SATS, held.assetId)

      const claimTxid = await claimSwapScript(
        arkade.ctx,
        script,
        funded,
        preimage,
        await arkade.ctx.wallet.getAddress(),
      )
      expect(claimTxid).toMatch(/^[0-9a-f]{64}$/)
      await expectDrained(script)
    },
    SWAP_TIMEOUT_MS,
  )
})
