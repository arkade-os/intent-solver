/**
 * Refunding a SWEPT send-leg lockup, through a batch.
 *
 * `refundSwapScript` is OFFCHAIN and arkd refuses a swept input offchain, so
 * the same `nonInteractiveRefund` leaf is spent as a BATCH INTENT. Three traps
 * shape the layout, each confirmed where it is enforced:
 *
 *  - vin k is refunded by OUTPUT k: the proof puts a BIP-322 `toSpend` copy at
 *    input 0 and the coins from input 1 (ts-sdk `craftToSignTx`), the emulator
 *    runs each covenant at the PROOF's input index (`emulator/.../intent.go`),
 *    and the covenant inspects `output[PUSHCURRENTINPUTINDEX]`.
 *  - The extension OP_RETURN goes at output 0: arkd takes it at any index with
 *    value 0 and skips it as a receiver (`arkd .../application/service.go`).
 *  - A swept input needs no forfeit (`domain.Vtxo.RequiresForfeit`), so the only
 *    forfeit signed is the fee coin's. That rules out
 *    `arkade.createArkadeBatchHandler`, which submits forfeits unconditionally
 *    (arkd rejects an empty pair) through the emulator, which drops any it did
 *    not sign itself.
 *
 * A FEE COIN IS NEEDED because the covenant forces every refund output to be at
 * least its own input, so a lockup contributes nothing to the fee arkd prices.
 * Mainnet prices these at zero, where no coin is taken.
 */
import {
  ArkAddress,
  assertFinalCommitmentMatchesValidated,
  assertValidBatchExpiry,
  Batch,
  buildForfeitTx,
  CSVMultisigTapscript,
  EmulatorPacket,
  Estimator,
  Extension,
  getNetwork,
  Intent,
  resolveBatchExpiryPolicy,
  RestEmulatorProvider,
  toXOnly,
  Transaction,
  TxTree,
  validateBatchRecipients,
  validateConnectorsTxGraph,
  validateVtxoTxGraph,
  VtxoScript,
  withPrevTxs,
  type ArkProvider,
  type ExtendedVirtualCoin,
  type Identity,
  type NetworkName,
  type Recipient,
  type SignerSession,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { Address, OutScript, SigHash } from '@scure/btc-signer'
import { tapLeafHash } from '@scure/btc-signer/payment.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import type { CovenantSwapScript } from './covenant.js'
import { offchainInputFeeParams } from './vtxoLifecycle.js'
import { EMPTY_RAW_WITNESS, type ArkadeContext, type FundedOutput } from './wallet.js'

export const SWEPT_REFUND_BATCH_TIMEOUT_MS = 4 * 60_000

const FEE_COIN_FILTER = { withRecoverable: false, genericallySpendableOnly: true } as const

interface FeePlan {
  coin?: ExtendedVirtualCoin
  change: bigint
}

const priceIntent = (
  estimator: Estimator,
  swept: readonly FundedOutput[],
  refundPkScript: Uint8Array,
  feeCoin?: { value: number; createdAt: Date },
): bigint => {
  const script = hex.encode(refundPkScript)
  const inputFee = (params: Parameters<Estimator['evalOffchainInput']>[0]): bigint =>
    BigInt(estimator.evalOffchainInput(params).satoshis)
  const outputFee = (amount: number): bigint =>
    BigInt(estimator.evalOffchainOutput({ amount: BigInt(amount), script }).satoshis)

  let fee = 0n
  for (const output of swept) {
    fee += inputFee(offchainInputFeeParams({ value: output.value, createdAt: new Date(), isSwept: true }))
    fee += outputFee(output.value)
  }
  if (feeCoin) {
    fee += inputFee(offchainInputFeeParams({ value: feeCoin.value, createdAt: feeCoin.createdAt }))
    fee += outputFee(feeCoin.value)
  }
  return fee
}

const planFee = async (
  ctx: ArkadeContext,
  estimator: Estimator,
  swept: readonly FundedOutput[],
  refundPkScript: Uint8Array,
): Promise<FeePlan> => {
  if (priceIntent(estimator, swept, refundPkScript) === 0n) return { change: 0n }

  const reserved = ctx.reservations.reserved()
  const candidates = (await ctx.wallet.getSpendableVtxos(FEE_COIN_FILTER))
    .filter((coin) => !reserved.has(`${coin.txid}:${coin.vout}`) && (coin.assets ?? []).length === 0)
    .sort((a, b) => a.value - b.value)

  for (const coin of candidates) {
    const change = BigInt(coin.value) - priceIntent(estimator, swept, refundPkScript, coin)
    if (change >= ctx.dustSats) return { coin, change }
  }
  throw new Error(
    `no sats-only float coin can pay the intent fee for a swept refund of ${swept.length} output(s): ` +
      `one is needed worth the fee plus ${ctx.dustSats} sats of change`,
  )
}

const intentCoinsFor = (
  script: CovenantSwapScript,
  swept: readonly FundedOutput[],
  feeCoin?: ExtendedVirtualCoin,
): ExtendedVirtualCoin[] => {
  const leaf: TapLeafScript = script.refund()
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
      }) as unknown as ExtendedVirtualCoin,
  )
  return feeCoin ? [...lockups, feeCoin] : lockups
}

const forfeitInput = (coin: ExtendedVirtualCoin) => ({
  txid: coin.txid,
  index: coin.vout,
  witnessUtxo: { amount: BigInt(coin.value), script: VtxoScript.decode(coin.tapTree).pkScript },
  sighashType: SigHash.DEFAULT,
  tapLeafScript: [coin.forfeitTapLeafScript],
})

const connectorInput = (connectorTree: TxTree | undefined, forWhat: string) => {
  const leaf = connectorTree?.leaves()[0]
  const output = leaf?.getOutput(0)
  if (!leaf || !output?.amount || !output.script) throw new Error(`no connector received for ${forWhat}`)
  return { txid: leaf.id, index: 0, witnessUtxo: { amount: output.amount, script: output.script } }
}

export const sweptRefundBatchHandler = (deps: {
  intentId: string
  arkProvider: ArkProvider
  identity: Identity
  session: SignerSession
  network: ReturnType<typeof getNetwork>
  recipients: readonly Recipient[]
  feeCoin?: ExtendedVirtualCoin
}): Batch.Handler => {
  const { arkProvider, identity, session, network, feeCoin } = deps
  let batchId: string
  let sweepTapTreeRoot: Uint8Array
  let validatedCommitmentTxid: string | undefined

  return {
    onBatchStarted: async (event) => {
      const ours = hex.encode(sha256(new TextEncoder().encode(deps.intentId)))
      if (!event.intentIdHashes.includes(ours)) return { skip: true }
      const info = await arkProvider.getInfo()
      const timelock = assertValidBatchExpiry(
        event.batchExpiry,
        resolveBatchExpiryPolicy(network, { advertisedVtxoTreeExpiry: info.vtxoTreeExpiry }),
      )
      await arkProvider.confirmRegistration(deps.intentId)
      batchId = event.id
      sweepTapTreeRoot = tapLeafHash(
        CSVMultisigTapscript.encode({
          timelock,
          pubkeys: [toXOnly(hex.decode(info.forfeitPubkey), 'forfeit key')],
        }).script,
      )
      return { skip: false }
    },

    onTreeSigningStarted: async (event, vtxoTree) => {
      const ours = hex.encode(toXOnly(await session.getPublicKey(), 'signer key'))
      const cosigners = event.cosignersPublicKeys.map((key) => hex.encode(toXOnly(hex.decode(key), 'cosigner key')))
      if (!cosigners.includes(ours)) return { skip: true }
      const commitmentTx = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx))
      validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot)
      validateBatchRecipients(commitmentTx, vtxoTree.leaves(), [...deps.recipients], network)
      const shared = commitmentTx.getOutput(0)
      if (!shared?.amount) throw new Error('commitment tx has no shared output')
      validatedCommitmentTxid = commitmentTx.id
      await session.init(vtxoTree, sweepTapTreeRoot, shared.amount)
      await arkProvider.submitTreeNonces(batchId, hex.encode(await session.getPublicKey()), await session.getNonces())
      return { skip: false }
    },

    onTreeNonces: async (event) => {
      const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces)
      if (!hasAllNonces) return { fullySigned: false }
      const signatures = await session.sign()
      await arkProvider.submitTreeSignatures(batchId, hex.encode(await session.getPublicKey()), signatures)
      return { fullySigned: true }
    },

    onBatchFinalization: async (event, _vtxoTree, connectorTree) => {
      if (connectorTree) validateConnectorsTxGraph(event.commitmentTx, connectorTree)
      const commitmentTx = Transaction.fromPSBT(base64.decode(event.commitmentTx))
      assertFinalCommitmentMatchesValidated(commitmentTx, validatedCommitmentTxid, 'swept refund finalization')
      // arkd rejects `submitSignedForfeitTxs` with both arguments empty.
      if (!feeCoin) return
      const info = await arkProvider.getInfo()
      const forfeit = await identity.sign(
        buildForfeitTx(
          [forfeitInput(feeCoin), connectorInput(connectorTree, `fee coin ${feeCoin.txid}:${feeCoin.vout}`)],
          OutScript.encode(Address(network).decode(info.forfeitAddress)),
        ),
        [0],
      )
      await arkProvider.submitSignedForfeitTxs([base64.encode(forfeit.toPSBT())])
    },
  }
}

const recipientFor = (ctx: ArkadeContext, pkScript: Uint8Array, amount: bigint): Recipient => ({
  address: new ArkAddress(ctx.wallet.arkServerPublicKey, pkScript.subarray(2), ctx.hrp).encode(),
  amount: Number(amount),
})

export const refundSweptSwapScript = async (
  ctx: ArkadeContext,
  emulatorUrl: string,
  script: CovenantSwapScript,
  swept: readonly FundedOutput[],
  refundPkScript: Uint8Array,
): Promise<string> => {
  if (swept.length === 0) throw new Error('nothing to refund: no swept outputs')
  // REFUSED, not carried: an asset packet declares a per-output split this
  // covenant pins one input at a time, and nothing here verifies they agree.
  const withAssets = swept.filter((output) => (output.assets ?? []).length > 0)
  if (withAssets.length > 0) {
    throw new Error(
      `refusing to batch-refund ${withAssets.length} swept output(s) carrying Arkade assets ` +
        `(${withAssets.map((o) => `${o.txid}:${o.vout}`).join(', ')}): the asset packet is unverified on this path`,
    )
  }

  const info = await ctx.wallet.arkProvider.getInfo()
  const estimator = new Estimator(info.fees.intentFee)
  const { coin: feeCoin, change } = await planFee(ctx, estimator, swept, refundPkScript)
  const release = feeCoin ? ctx.reservations.reserve([feeCoin]) : () => {}

  try {
    const coins = await withPrevTxs(intentCoinsFor(script, swept, feeCoin), ctx.wallet.indexerProvider)
    const changePkScript = change > 0n ? ArkAddress.decode(await ctx.wallet.getAddress()).pkScript : undefined
    const payouts = [
      ...swept.map((output) => ({ script: refundPkScript, amount: BigInt(output.value) })),
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
    const proof = Intent.create(message, coins, [
      Extension.create([
        EmulatorPacket.create(
          swept.map((_, index) => ({ vin: index + 1, script: script.refundArkadeScript, witness: EMPTY_RAW_WITNESS })),
        ),
      ]).txOut(),
      ...payouts,
    ])
    const signedProof = await ctx.identity.sign(proof)

    const introSignedProof = await new RestEmulatorProvider(emulatorUrl).submitIntent({
      proof: base64.encode(signedProof.toPSBT()),
      message,
    })
    // `refundSwapScript`'s rule: a witness cannot change a txid, so any other
    // value is a forged or misrouted proof.
    const returned = Transaction.fromPSBT(base64.decode(introSignedProof))
    if (returned.id !== proof.id) {
      throw new Error(`emulator returned intent proof ${returned.id}, expected ${proof.id}`)
    }

    const intentId = await ctx.wallet.arkProvider.registerIntent({ proof: introSignedProof, message })
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), SWEPT_REFUND_BATCH_TIMEOUT_MS)
    try {
      return await Batch.join(
        // The fee coin's outpoint too: arkd tags each connector chunk with the input its forfeit serves.
        ctx.wallet.arkProvider.getEventStream(abort.signal, [
          cosigner,
          ...[...swept, ...(feeCoin ? [feeCoin] : [])].map((coin) => `${coin.txid}:${coin.vout}`),
        ]),
        sweptRefundBatchHandler({
          intentId,
          arkProvider: ctx.wallet.arkProvider,
          identity: ctx.identity,
          session,
          network: getNetwork(info.network as NetworkName),
          recipients: payouts.map((payout) => recipientFor(ctx, payout.script, payout.amount)),
          ...(feeCoin ? { feeCoin } : {}),
        }),
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
