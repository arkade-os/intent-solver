import { vi } from 'vitest'
import { ArkAddress, SingleKey, type IWallet } from '@arkade-os/sdk'
import { createSwapClient } from '@arkade-os/swap'
import {
  lightningReceiveContract,
  lightningSendContract,
  onchainHtlcScript,
  unilateralClaimDelay,
  type RfqQuote,
} from '@arkade-os/swap/protocol'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { lightningReceiveRfqQuotePayload } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { rfqQuotePayload } from '@arkade-os/solver-corridors/wire/payloads.js'
import { onchainRfqQuotePayload } from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import type { OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const operator = key(2)
const solver = key(3)
const emulator = key(4)
const pkScript = new ArkAddress(operator, key(5), 'tark').pkScript
const discoveryKey = hex.encode(key(6))
const claimDelay = unilateralClaimDelay(512)
const paymentHash = 'b'.repeat(64)
export const TIMING_INVOICE =
  'lnbcrt21u1p5tqtaypp56yzglgfgwsm5pd49996jqvtmpf8fqdk7cq2znnjw5c2j5t8ua38qdql2djkuepqw3hjqs2jfvsxzerywfjhxuccqz95xqztfsp586s5vpsdxt05rm7hr6ycwq5ffmnx2gngv820seugky6j6z2wxqwq9qxpqysgqepuxr82pvlp8lgj7nqu8yp2f5q32323jxddx9qgtjhfhsyzvftgkwx8qv4772fzz46pwyw5ex3u7lf7na8a8403ur3gyeu22gv29rpspefzz2y'
const destination = onchainHtlcScript(
  { paymentHash, claimKey: key(7), refundKey: key(8), refundLocktime: 1_900_000_000 },
  'regtest',
).address

export const legacyLightningCard = {
  pair: 'BTC/lightning:BTC',
  base_corridor: 'arkade' as const,
  quote_corridor: 'lightning' as const,
  base_asset: { id: 'btc', ticker: 'BTC', name: 'Bitcoin', decimals: 8 },
  quote_asset: { id: 'btc', ticker: 'BTC', name: 'Bitcoin', decimals: 8 },
  solver: 'interop',
  source: 'https://registry.example/regtest.json',
  sourceType: 'registry' as const,
  discovery_pubkey: discoveryKey,
  transports: { nostr: { relays: ['wss://relay.example'] } },
  fee_bps: 0,
  min_base_amount: '1',
  max_base_amount: '1000000',
  min_quote_amount: '1',
  max_quote_amount: '1000000',
}

export const admissionWallet = {
  identity: SingleKey.fromPrivateKey(new Uint8Array(32).fill(9)),
  getAddress: async () => new ArkAddress(operator, key(9), 'tark').encode(),
  getArkadeInfo: async () => ({
    network: 'regtest',
    signerPubkey: hex.encode(operator),
    unilateralExitDelay: 512n,
    deprecatedSigners: [],
  }),
} as unknown as IWallet

type Observation = {
  quote: RfqQuote
  now: number
  invoiceExpiresAt?: number
  invoice?: string
  payDeadline?: number
  onchain?: { htlcLocktime: number; minConfirmations: number; direction: 'send' }
}

export const createAdmissionProbe = () => {
  let observed: Observation
  let receivePaymentHash = paymentHash
  const client = createSwapClient({
    wallet: admissionWallet,
    discovery: {
      snapshot: [legacyLightningCard, { ...legacyLightningCard, pair: 'BTC/onchain:BTC', quote_corridor: 'onchain' }],
    },
    emulatorPubkey: `02${hex.encode(emulator)}`,
    policy: { drive: 'readonly', maxRefundWindowSeconds: Number.MAX_SAFE_INTEGER },
    // Timing tests control these facts; the package still performs its invoice and window checks.
    corridors: {
      lightning: {
        decode: (raw) => ({
          raw,
          paymentHash: observed.payDeadline === undefined ? paymentHash : receivePaymentHash,
          amountSats: Number(
            observed.payDeadline === undefined ? observed.quote.to_amount : observed.quote.from_amount,
          ),
          expiresAt: observed.payDeadline ?? observed.invoiceExpiresAt!,
        }),
      },
    },
    transportFor: async () => ({
      attestedResponder: discoveryKey,
      status: async () => null,
      close: async () => {},
      requestQuote: async (request) => {
        const profile = request.profile as Record<string, string>
        const refundLocktime = observed.quote.refund_locktime!
        const rfqId = String(request.rfq_id)
        if (observed.payDeadline !== undefined) {
          receivePaymentHash = profile.payment_hash!
          const script = lightningReceiveContract({
            solverPubkey: solver,
            refundLocktime,
            operatorPubkey: operator,
            paymentHash: receivePaymentHash,
            claimDelay,
            emulatorPubkey: emulator,
            solverRefundPkScript: pkScript,
            payoutPubkey: hex.decode(profile.payout_pubkey!),
            payoutPkScript: ArkAddress.decode(profile.payout_address!).pkScript,
          })
          return lightningReceiveRfqQuotePayload(
            {
              amountSats: Number(observed.quote.from_amount),
              payoutSats: Number(observed.quote.to_amount),
              solverPubkey: hex.encode(solver),
              refundLocktime,
              paymentHash: receivePaymentHash,
              invoice: String(observed.quote.profile?.invoice),
              lockupAddress: script.address('tark', operator).encode(),
              solverRefundPkScript: hex.encode(pkScript),
            } as ReceiveSwapRow,
            observed.quote.valid_until,
            rfqId,
          ) as unknown as RfqQuote
        }
        const hash = observed.onchain ? profile.payment_hash! : paymentHash
        const refundWithoutReceiverDelay = Math.ceil((refundLocktime - observed.now) / 512) * 512
        const script = lightningSendContract({
          solverPubkey: solver,
          refundLocktime,
          operatorPubkey: operator,
          paymentHash: hash,
          claimDelay,
          emulatorPubkey: emulator,
          ...(observed.onchain ? {} : { refundWithoutReceiverDelay }),
          senderPubkey: hex.decode(profile.client_refund_pubkey!),
          receiverPkScript: pkScript,
          refundPkScript: ArkAddress.decode(profile.refund_address!).pkScript,
        })
        if (observed.onchain) {
          const htlc = onchainHtlcScript(
            {
              paymentHash: hash,
              claimKey: hex.decode(profile.payout_pubkey!),
              refundKey: solver,
              refundLocktime: observed.onchain.htlcLocktime,
            },
            'regtest',
          )
          return onchainRfqQuotePayload(
            {
              amountSats: Number(observed.quote.from_amount),
              payoutSats: Number(observed.quote.to_amount),
              providerPubkey: hex.encode(solver),
              refundLocktime,
              paymentHash: hash,
              htlcPubkey: hex.encode(solver),
              htlcLocktime: observed.onchain.htlcLocktime,
              minConfirmations: observed.onchain.minConfirmations,
              lockupAddress: script.address('tark', operator).encode(),
              onchainAddress: htlc.address,
              receiverPkScript: hex.encode(pkScript),
            } as OnchainSendSwapRow,
            observed.quote.valid_until,
            rfqId,
          ) as unknown as RfqQuote
        }
        return rfqQuotePayload(
          {
            amountSats: Number(observed.quote.from_amount),
            invoice: profile.invoice!,
            receiverPubkey: hex.encode(solver),
            refundLocktime,
            paymentHash,
            lockupAddress: script.address('tark', operator).encode(),
            receiverPkScript: hex.encode(pkScript),
            refundWithoutReceiverDelay,
          } as SendSwapRow,
          observed.quote.valid_until,
          rfqId,
        ) as unknown as RfqQuote
      },
    }),
  })
  return async (input: Observation) => {
    observed = input
    vi.setSystemTime(input.now * 1000)
    return client.quote(
      input.payDeadline !== undefined
        ? { via: 'lightning', amount: BigInt(input.quote.from_amount), amountOn: 'give' }
        : input.onchain
          ? { to: destination, amount: BigInt(input.quote.from_amount), amountOn: 'give' }
          : { to: input.invoice! },
    )
  }
}

export const observedReceiveClaimFloor = async (now: number, refundHorizon: number): Promise<number> => {
  const probe = createAdmissionProbe()
  const accepts = async (claimWindow: number): Promise<boolean> => {
    const payDeadline = now + refundHorizon - claimWindow
    const quote = lightningReceiveRfqQuotePayload(
      {
        amountSats: 100_000,
        payoutSats: 99_500,
        solverPubkey: hex.encode(solver),
        refundLocktime: now + refundHorizon,
        paymentHash,
        invoice: TIMING_INVOICE,
        lockupAddress: 'derived by the transport',
        solverRefundPkScript: hex.encode(pkScript),
      } as ReceiveSwapRow,
      payDeadline,
      'claim-floor',
    ) as unknown as RfqQuote
    try {
      await probe({ quote, now, payDeadline })
      return true
    } catch (error) {
      const refusal = error as { check?: string; cause?: { reason?: string } }
      if (refusal.check !== 'refund_window' || refusal.cause?.reason !== 'claim_window_too_short') throw error
      return false
    }
  }
  let low = 0
  let high = refundHorizon - 1
  if (await accepts(low)) throw new Error('the client accepted a receive quote with no claim window')
  if (!(await accepts(high))) throw new Error('the client refused the positive admission control')
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (await accepts(middle)) high = middle
    else low = middle
  }
  return high
}
