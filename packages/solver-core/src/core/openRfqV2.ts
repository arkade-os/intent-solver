import { z } from 'zod'
import { RFQ_ID } from './rfqProtocol.js'

export const OPEN_RFQ_ATOMIC = z
  .string()
  .max(128)
  .regex(/^[1-9][0-9]*$/)
const LEG = '(?:arkade|bolt11|bitcoin|eip155):[a-z0-9-]+/(?:slip44:[0-9]+|asset:[0-9a-f]{68}|erc20:0x[0-9a-f]{40})'
export const OPEN_RFQ_PAIR = z
  .string()
  .max(512)
  .regex(new RegExp(`^${LEG}~${LEG}$`))

export const RfqOpenV2 = z
  .object({
    v: z.literal(2),
    type: z.literal('rfq_open'),
    open_id: RFQ_ID,
    pair: OPEN_RFQ_PAIR,
    amount_side: z.enum(['from', 'to']),
    amount: OPEN_RFQ_ATOMIC,
    bids_until: z.number().int().positive().safe(),
  })
  .strict()

export type OpenRfqV2 = z.infer<typeof RfqOpenV2>
export interface OpenRfqV2Price {
  from_amount: string
  to_amount: string
  valid_until: number
}

export const validOpenRfqPrice = (open: OpenRfqV2, price: OpenRfqV2Price, nowSeconds: number): boolean =>
  OPEN_RFQ_ATOMIC.safeParse(price.from_amount).success &&
  OPEN_RFQ_ATOMIC.safeParse(price.to_amount).success &&
  Number.isSafeInteger(price.valid_until) &&
  price.valid_until > Math.max(nowSeconds, open.bids_until) &&
  (open.amount_side === 'from' ? price.from_amount : price.to_amount) === open.amount
