import {
  ArkAddress,
  ArkErrorName,
  Batch,
  ConditionWitness,
  Estimator,
  getArkPsbtFields,
  getNetwork,
  Intent,
  isArkError,
  SettlementEventType,
  Transaction,
  withPrevTxs,
  type ExtendedVirtualCoin,
  type NetworkName,
  type Recipient,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import type { CovenantSwapScript } from './covenant.js'
import { sweptRefundBatchHandler, SWEPT_REFUND_BATCH_TIMEOUT_MS } from './sweptRefund.js'
import { offchainInputFeeParams } from './vtxoLifecycle.js'
import { MAX_LOCKUP_SPEND_INPUTS, type ArkadeContext, type FundedOutput } from './wallet.js'

const FEE_COIN_FILTER = { withRecoverable: true, genericallySpendableOnly: true } as const
const DELETE_MESSAGE: Intent.DeleteMessage = { type: 'delete', expire_at: 0 }

const priceIntent = (
  estimator: Estimator,
  swept: readonly FundedOutput[],
  payoutPkScript: Uint8Array,
  changePkScript: Uint8Array,
  feeCoin?: { value: number; createdAt: Date; isSwept?: boolean },
): bigint => {
  const inputFee = (params: Parameters<Estimator['evalOffchainInput']>[0]): bigint =>
    BigInt(estimator.evalOffchainInput(params).satoshis)
  const outputFee = (amount: bigint, script: Uint8Array): bigint =>
    BigInt(estimator.evalOffchainOutput({ amount, script: hex.encode(script) }).satoshis)
  const base = swept.reduce((sum, output) => {
    if (/\bbirth\b/.test(estimator.config.offchainInput ?? '') && !output.createdAt) {
      throw new Error(`swept input ${output.txid}:${output.vout} has no creation time for fee pricing`)
    }
    return (
      sum +
      inputFee({
        amount: BigInt(output.value),
        type: 'recoverable',
        weight: 0,
        birth: output.createdAt,
        ...(output.expiresAt ? { expiry: new Date(output.expiresAt * 1000) } : {}),
      }) +
      outputFee(BigInt(output.value), payoutPkScript)
    )
  }, 0n)
  if (!feeCoin) return base
  const fixed = base + inputFee(offchainInputFeeParams(feeCoin))
  const gross = BigInt(feeCoin.value)
  let fee = fixed + outputFee(gross, changePkScript)
  const seen = new Set<bigint>()
  let highest = fee
  for (let i = 0; i < 64 && fee >= 0n && fee < gross; i++) {
    const next = fixed + outputFee(gross - fee, changePkScript)
    if (next === fee) return fee
    if (next > highest) highest = next
    if (seen.has(next)) {
      if (highest < gross && fixed + outputFee(gross - highest, changePkScript) <= highest) return highest
      break
    }
    seen.add(fee)
    fee = next
  }
  if (fee >= gross) return fee
  throw new Error('swept claim intent fee did not converge')
}

const planFee = async (
  ctx: ArkadeContext,
  estimator: Estimator,
  swept: readonly FundedOutput[],
  payoutPkScript: Uint8Array,
  changePkScript: Uint8Array,
): Promise<{ coin?: ExtendedVirtualCoin; change: bigint; release: () => void }> => {
  if (priceIntent(estimator, swept, payoutPkScript, changePkScript) === 0n) return { change: 0n, release: () => {} }
  const candidates = await ctx.wallet.getSpendableVtxos(FEE_COIN_FILTER)
  const reserved = ctx.reservations.reserved()
  for (const coin of candidates
    .filter(
      (candidate) => !reserved.has(`${candidate.txid}:${candidate.vout}`) && (candidate.assets ?? []).length === 0,
    )
    .sort((a, b) => a.value - b.value)) {
    const change = BigInt(coin.value) - priceIntent(estimator, swept, payoutPkScript, changePkScript, coin)
    if (change >= ctx.dustSats) return { coin, change, release: ctx.reservations.reserve([coin]) }
  }
  throw new Error(`no sats-only float coin can pay the intent fee for a swept claim of ${swept.length} output(s)`)
}

const claimCoins = (
  script: CovenantSwapScript,
  swept: readonly FundedOutput[],
  preimage: Uint8Array,
  feeCoin?: ExtendedVirtualCoin,
): ExtendedVirtualCoin[] => {
  const leaf: TapLeafScript = script.claim()
  const tapTree = script.encode()
  const lockups = swept.map(
    (output) =>
      ({
        txid: output.txid,
        vout: output.vout,
        value: output.value,
        tapTree,
        forfeitTapLeafScript: leaf,
        intentTapLeafScript: leaf,
        extraWitness: [preimage],
      }) as unknown as ExtendedVirtualCoin,
  )
  return feeCoin ? [...lockups, feeCoin] : lockups
}

export interface SweptClaimPrepared {
  proofTxid: string
  deleteProof: string
}

export interface SweptClaimRegistration extends SweptClaimPrepared {
  intentId: string
}

export interface SweptClaimCommitment extends SweptClaimRegistration {
  commitmentTxid: string
  payoutOutpoints: { txid: string; vout: number; value: number }[]
}

const payoutOutpointsIn = (
  leaves: ReturnType<Parameters<NonNullable<Batch.Handler['onTreeSigningStarted']>>[1]['leaves']>,
  payouts: readonly { script: Uint8Array; amount: bigint }[],
): SweptClaimCommitment['payoutOutpoints'] => {
  const used = new Set<string>()
  return payouts.map((payout) => {
    for (const leaf of leaves) {
      for (let vout = 0; vout < leaf.outputsLength; vout++) {
        const output = leaf.getOutput(vout)
        const key = `${leaf.id}:${vout}`
        if (
          used.has(key) ||
          output.amount !== payout.amount ||
          !output.script ||
          hex.encode(output.script) !== hex.encode(payout.script)
        ) {
          continue
        }
        used.add(key)
        return { txid: leaf.id, vout, value: Number(payout.amount) }
      }
    }
    throw new Error(`swept claim payout of ${payout.amount} sats is missing from the batch tree`)
  })
}

export const deleteSweptClaimIntent = async (ctx: ArkadeContext, deleteProof: string): Promise<void> => {
  try {
    await ctx.wallet.arkProvider.deleteIntent({ proof: deleteProof, message: DELETE_MESSAGE })
  } catch (error) {
    if (isArkError(error, ArkErrorName.INVALID_INTENT_PROOF) && error.message.includes('no matching intents found'))
      throw new Error('swept claim cancellation is unverified: intent may already be selected', { cause: error })
    throw error
  }
}

/**
 * Requires Arkd to reject competing batch intents selecting a mature CSV leaf
 * (ArkLabsHQ/arkd#203). Signed forfeits protect an accepted batch, not registration before it.
 */
export const claimSweptSwapScript = async (
  ctx: ArkadeContext,
  script: CovenantSwapScript,
  swept: readonly FundedOutput[],
  preimage: Uint8Array,
  expectedSats: number,
  onRegistered?: (registration: SweptClaimRegistration) => Promise<void>,
  onCommitmentValidated?: (commitment: SweptClaimCommitment) => Promise<void>,
  onPrepared?: (prepared: SweptClaimPrepared) => Promise<void>,
): Promise<string> => {
  if (swept.length === 0 || swept.length > MAX_LOCKUP_SPEND_INPUTS) {
    throw new Error(`swept claim needs 1-${MAX_LOCKUP_SPEND_INPUTS} outputs, got ${swept.length}`)
  }
  const total = swept.reduce((sum, output) => sum + output.value, 0)
  if (total !== expectedSats) throw new Error(`swept claim holds ${total}, expected ${expectedSats} sats`)
  if (swept.some((output) => (output.assets ?? []).length > 0)) {
    throw new Error('refusing to batch-claim a swept output carrying Arkade assets')
  }
  if (
    preimage.length !== 32 ||
    hex.encode(ripemd160(sha256(preimage))) !== hex.encode(script.vhtlcOptions.preimageHash)
  ) {
    throw new Error('swept claim preimage does not match the lockup script')
  }
  const payoutPkScript = script.vhtlcOptions.nonInteractiveParameters?.receiverPkScript
  if (!payoutPkScript) throw new Error('swept claim has no committed receiver payout script')

  const info = await ctx.wallet.arkProvider.getInfo()
  const estimator = new Estimator(info.fees.intentFee)
  const walletPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript
  const { coin: feeCoin, change, release } = await planFee(ctx, estimator, swept, payoutPkScript, walletPkScript)
  try {
    const coins = await withPrevTxs(claimCoins(script, swept, preimage, feeCoin), ctx.wallet.indexerProvider)
    const changePkScript = change > 0n ? walletPkScript : undefined
    const payouts = [
      ...swept.map((output) => ({ script: payoutPkScript, amount: BigInt(output.value) })),
      ...(changePkScript ? [{ script: changePkScript, amount: change }] : []),
    ]
    const session = ctx.identity.signerSession()
    const cosigner = hex.encode(await session.getPublicKey())
    const message: Intent.RegisterMessage = {
      type: 'register',
      onchain_output_indexes: [],
      valid_at: 0,
      expire_at: 0,
      cosigners_public_keys: [cosigner],
    }
    const proof = Intent.create(message, coins, payouts)
    const signedProof = await ctx.identity.sign(proof)
    const deleteProof = base64.encode((await ctx.identity.sign(Intent.create(DELETE_MESSAGE, coins, []))).toPSBT())
    const submitted = Transaction.fromPSBT(signedProof.toPSBT())
    for (let vin = 1; vin <= swept.length; vin++) {
      const witnesses = getArkPsbtFields(submitted, vin, ConditionWitness).flat()
      if (!witnesses.some((item) => hex.encode(item) === hex.encode(preimage))) {
        throw new Error(`swept claim proof input ${vin} lost its preimage witness`)
      }
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), SWEPT_REFUND_BATCH_TIMEOUT_MS)
    const stream = ctx.wallet.arkProvider.getEventStream(abort.signal, [
      cosigner,
      ...[...swept, ...(feeCoin ? [feeCoin] : [])].map((output) => `${output.txid}:${output.vout}`),
    ])
    try {
      let event = await stream.next()
      if (event.done) throw new Error('swept claim event stream closed before subscription was acknowledged')
      const buffered = [event.value]
      while (event.value.type !== SettlementEventType.StreamStarted) {
        event = await stream.next()
        if (event.done) throw new Error('swept claim event stream closed before subscription was acknowledged')
        buffered.push(event.value)
      }
      await onPrepared?.({ proofTxid: proof.id, deleteProof })
      let intentId: string
      try {
        intentId = await ctx.wallet.arkProvider.registerIntent({
          proof: base64.encode(signedProof.toPSBT()),
          message,
        })
        await onRegistered?.({ intentId, proofTxid: proof.id, deleteProof })
      } catch (error) {
        try {
          await deleteSweptClaimIntent(ctx, deleteProof)
        } catch {
          // The prepared journal retains the delete proof for recovery.
        }
        throw error
      }
      const recipientFor = (payout: (typeof payouts)[number]): Recipient => ({
        address: new ArkAddress(ctx.wallet.arkServerPublicKey, payout.script.subarray(2), ctx.hrp).encode(),
        amount: Number(payout.amount),
      })
      const handler = sweptRefundBatchHandler({
        intentId,
        arkProvider: ctx.wallet.arkProvider,
        identity: ctx.identity,
        session,
        network: getNetwork(info.network as NetworkName),
        recipients: payouts.map(recipientFor),
        ...(feeCoin ? { feeCoin } : {}),
        onValidatedCommitment: async ({ commitmentTxid, vtxoTree }) => {
          await onCommitmentValidated?.({
            intentId,
            proofTxid: proof.id,
            deleteProof,
            commitmentTxid,
            payoutOutpoints: payoutOutpointsIn(vtxoTree.leaves(), payouts.slice(0, swept.length)),
          })
        },
      })
      return await Batch.join(
        (async function* () {
          yield* buffered
          yield* stream
        })(),
        handler,
        { abortController: abort },
      )
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  } finally {
    release()
  }
}
