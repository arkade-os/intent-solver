import { nonEmpty, type Brand } from './brand.js'

export type SwapId = Brand<string, 'SwapId'>
export type RfqId = Brand<string, 'RfqId'>
export type RouteId = Brand<string, 'RouteId'>

export const SwapId = { of: (value: string): SwapId => nonEmpty('swap id', value) }
export const RfqId = { of: (value: string): RfqId => nonEmpty('rfq id', value) }
export const RouteId = { of: (value: string): RouteId => nonEmpty('route id', value) }
