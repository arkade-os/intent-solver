import { describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import { respondToLightningRfqRequest } from '@arkade-os/solver-corridors/corridors/rfq.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'

const INVOICE =
  'lnbcrt21u1p5tqtaypp56yzglgfgwsm5pd49996jqvtmpf8fqdk7cq2znnjw5c2j5t8ua38qdql2djkuepqw3hjqs2jfvsxzerywfjhxuccqz95xqztfsp586s5vpsdxt05rm7hr6ycwq5ffmnx2gngv820seugky6j6z2wxqwq9qxpqysgqepuxr82pvlp8lgj7nqu8yp2f5q32323jxddx9qgtjhfhsyzvftgkwx8qv4772fzz46pwyw5ex3u7lf7na8a8403ur3gyeu22gv29rpspefzz2y'
const REFUND = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark')
const CLIENT_KEY = '11'.repeat(32)

describe('respondToLightningRfqRequest re-serve', () => {
  it('does not re-serve a row quoted before the co-signer column for a refused key', async () => {
    const legacy = {
      state: 'quoted',
      clientRefundPubkey: CLIENT_KEY,
      refundPkScript: hex.encode(REFUND.pkScript),
      emulatorPubkey: null,
    }
    const outcome = await respondToLightningRfqRequest(
      {
        quote: async () => ({ accepted: false, reason: 'duplicate_swap' }),
        cosignerKey: async () => null,
        lockupTimeout: 600,
      } as never,
      { findByRfqId: async () => undefined, findLiveByPaymentHash: async () => legacy } as never,
      {
        v: 1,
        type: 'rfq_request',
        rfq_id: 'ab'.repeat(32),
        pair: RFQ_PAIR_SEND,
        amount_side: 'to',
        profile: {
          invoice: INVOICE,
          refund_address: REFUND.encode(),
          client_refund_pubkey: CLIENT_KEY,
          emulator_pubkey: 'ff'.repeat(32),
        },
      },
    )
    expect(outcome.kind).toBe('refused')
  })
})
