import { Amount } from '@arkade-os/solver-next/domain/shared/amount.js'
import { Asset } from '@arkade-os/solver-next/domain/shared/asset.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { Reference } from '@arkade-os/solver-next/domain/swap/leg.js'

export const BTC = Asset.of('BTC')
export const btc = (units: bigint): Amount => Amount.of(BTC, units)
export const t = (seconds: number): UnixSeconds => UnixSeconds.of(seconds)
export const ref = (value: string): Reference => Reference.of(value)
