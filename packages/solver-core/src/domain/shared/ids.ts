import { nonEmpty, type Brand } from './brand.js'

export type SwapId = Brand<string, 'SwapId'>
export type RfqId = Brand<string, 'RfqId'>

export const swapId = (value: string): SwapId => nonEmpty('swap id', value)
export const rfqId = (value: string): RfqId => nonEmpty('rfq id', value)
