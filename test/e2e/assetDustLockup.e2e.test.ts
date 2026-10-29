/**
 * A BTC send lockup that someone tops up with an asset vtxo, against a real arkd.
 * THIS WALLET IS BOTH SIDES, as in `assetLockup.e2e.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { hex } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils.js'
import { ArkAddress } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import {
  claimSwapScript,
  findLockups,
  refundSwapScript,
  satsOutputs,
  type FundedOutput,
} from '@arkade-os/solver-arkade/arkade/wallet.js'
import { paymentHashFromPreimage, scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import {
  openArkade,
  assertArkadeSpendable,
  SWAP_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  type E2eArkade,
} from './support/stack.js'

const NEEDED_SATS = 20_000
const LOCKUP_SATS = 2_000
const DUST_SATS = 330

let arkade: E2eArkade

beforeAll(async () => {
  arkade = await openArkade()
  await assertArkadeSpendable(arkade, NEEDED_SATS)
}, SETUP_TIMEOUT_MS)

afterAll(() => arkade?.close())

const heldAssetId = async (): Promise<string> => {
  const balance = await arkade.ctx.wallet.getBalance()
  const held = (balance.availableAssets ?? []) as { assetId: string; amount: bigint }[]
  const usable = held.find((entry) => BigInt(entry.amount) >= 1n)
  if (!usable) throw new Error('this wallet holds no asset; mint one before running the asset dust e2e')
  return usable.assetId
}

/** A BTC lockup funded with plain sats, then topped up with an asset vtxo. */
const dustedLockup = async (preimage: Uint8Array, refundLocktime: number) => {
  const ctx = arkade.ctx
  const ours = await ctx.identity.xOnlyPublicKey()
  const ourPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript
  const script = new CovenantSwapScript({
    receiver: ours,
    server: ctx.wallet.arkServerPublicKey,
    preimageHash: scriptHashFromPaymentHash(paymentHashFromPreimage(preimage)),
    refundLocktime,
    claimDelay: ctx.unilateralDelays.unilateralClaimDelay,
    client: ours,
    clientRefundDelay: ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
    refundWithoutServerDelay: ctx.unilateralDelays.unilateralRefundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(arkade.emulator.pubkey),
      receiverPkScript: ourPkScript,
      senderPkScript: ourPkScript,
    },
  })
  const address = script.address(ctx.hrp, ctx.wallet.arkServerPublicKey).encode()
  const assetId = await heldAssetId()
  await ctx.wallet.send({ recipients: [{ address, amount: LOCKUP_SATS }] })
  await ctx.wallet.send({ recipients: [{ address, amount: DUST_SATS, assets: [{ assetId, amount: 1n }] }] })

  const pkScriptHex = hex.encode(script.pkScript)
  const outputs = await poll(
    async () => {
      const found = await findLockups(ctx, pkScriptHex)
      return found.length === 2 ? found : null
    },
    { attempts: 40, intervalMs: 3_000, whenExhausted: 'the lockup never showed both outputs' },
  )
  return { script, pkScriptHex, outputs, ourPkScript, assetId }
}

const drained = (pkScriptHex: string, left: number) =>
  poll(
    async () => {
      const found = await findLockups(arkade.ctx, pkScriptHex)
      return found.length === left ? found : null
    },
    { attempts: 40, intervalMs: 3_000, whenExhausted: `the lockup never came down to ${left} output(s)` },
  )

const withAsset = (outputs: readonly FundedOutput[]) => outputs.filter((o) => (o.assets ?? []).length > 0)

describe('e2e asset dust on a BTC send lockup', () => {
  it(
    'arkd refuses a claim over the asset vtxo and accepts one over the sats outputs',
    async () => {
      const preimage = randomBytes(32)
      const { script, pkScriptHex, outputs } = await dustedLockup(preimage, Math.floor(Date.now() / 1000) + 7_200)
      const destination = await arkade.ctx.wallet.getAddress()
      expect(withAsset(outputs)).toHaveLength(1)

      await expect(claimSwapScript(arkade.ctx, script, outputs, preimage, destination)).rejects.toThrow(
        /ASSET_VALIDATION_FAILED/,
      )

      const txid = await claimSwapScript(arkade.ctx, script, satsOutputs(outputs), preimage, destination)
      expect(txid).toMatch(/^[0-9a-f]{64}$/)
      expect(withAsset(await drained(pkScriptHex, 1))).toHaveLength(1)
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'the refund takes the whole lockup, asset vtxo included',
    async () => {
      const { script, pkScriptHex, outputs, ourPkScript } = await dustedLockup(
        randomBytes(32),
        Math.floor(Date.now() / 1000) - 7_200,
      )

      const txid = await refundSwapScript(arkade.ctx, arkade.emulator.url, script, outputs, ourPkScript)
      expect(txid).toMatch(/^[0-9a-f]{64}$/)
      await drained(pkScriptHex, 0)
    },
    SWAP_TIMEOUT_MS,
  )
})
