import { describe, it, expect } from 'vitest'
import { RfqRequest } from '@arkade-os/solver-corridors/wire/payloads.js'
import { OnchainRfqRequest } from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
import { LightningReceiveRfqRequest } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { AssetRfqRequest } from '@arkade-os/solver-corridors/wire/assetRfqPayloads.js'
import { EvmReceiveRfqRequest, EvmSendRfqRequest } from '@arkade-os/solver-corridors-evm/wire/evmPayloads.js'

const KEY = 'ab'.repeat(32)
const EVM = `0x${'1'.repeat(40)}`
const envelope = { v: 1, type: 'rfq_request', rfq_id: 'a'.repeat(64), amount_side: 'from' }

const PROFILES = [
  [
    'lightning send',
    RfqRequest,
    {
      ...envelope,
      pair: 'arkade:BTC->lightning:BTC',
      amount_side: 'to',
      profile: { invoice: 'lnbcrt1', refund_address: 'tark1q', client_refund_pubkey: KEY },
    },
  ],
  [
    'onchain send',
    OnchainRfqRequest,
    {
      ...envelope,
      pair: 'arkade:BTC->onchain:BTC',
      amount: 50_000,
      profile: { payment_hash: KEY, payout_pubkey: KEY, refund_address: 'tark1q', client_refund_pubkey: KEY },
    },
  ],
  [
    'lightning receive',
    LightningReceiveRfqRequest,
    {
      ...envelope,
      pair: 'lightning:BTC->arkade:BTC',
      amount: 50_000,
      profile: { payment_hash: KEY, payout_address: 'tark1q', payout_pubkey: KEY },
    },
  ],
  [
    'asset',
    AssetRfqRequest,
    {
      ...envelope,
      pair: `arkade:BTC->arkade:${'aa'.repeat(32)}0100`,
      amount: '100000000',
      profile: { maker_pk_script: `5120${KEY}`, maker_public_key: KEY },
    },
  ],
  [
    'evm send',
    EvmSendRfqRequest,
    {
      ...envelope,
      pair: `arkade:BTC->ethereum:${EVM}`,
      amount: 50_000,
      profile: { payment_hash: KEY, evm_claim_address: EVM, refund_address: 'tark1q', client_refund_pubkey: KEY },
    },
  ],
  [
    'evm receive',
    EvmReceiveRfqRequest,
    {
      ...envelope,
      pair: `ethereum:${EVM}->arkade:BTC`,
      profile: {
        payment_hash: KEY,
        evm_amount: '1000',
        evm_timeout_block: 100,
        evm_refund_address: EVM,
        payout_address: 'tark1q',
        payout_pubkey: KEY,
      },
    },
  ],
] as const

describe('profile.emulator_pubkey', () => {
  it.each(PROFILES)('%s takes it absent or x-only, and refuses any other spelling', (_, schema, request) => {
    const keyed = (key: unknown) => ({ ...request, profile: { ...request.profile, emulator_pubkey: key } })
    expect(schema.safeParse(request).success).toBe(true)
    expect(schema.safeParse(keyed(KEY)).success).toBe(true)
    for (const bad of [`02${KEY}`, KEY.toUpperCase(), 'zz'.repeat(32), '', 42]) {
      expect(schema.safeParse(keyed(bad)).success, String(bad)).toBe(false)
    }
  })
})
