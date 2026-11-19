import { nonEmpty, type Brand } from './brand.js'

export type SwapId = Brand<string, 'SwapId'>
export type RfqId = Brand<string, 'RfqId'>

export const SwapId = { of: (value: string): SwapId => nonEmpty('swap id', value) }
export const RfqId = { of: (value: string): RfqId => nonEmpty('rfq id', value) }
