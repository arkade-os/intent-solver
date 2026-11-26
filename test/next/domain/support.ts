import { Amount } from '@arkade-os/solver-next/domain/shared/amount.js'
import { Asset } from '@arkade-os/solver-next/domain/shared/asset.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { RfqId, SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { Hashlock, Preimage } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import { Reference } from '@arkade-os/solver-next/domain/swap/leg.js'
import { Quote } from '@arkade-os/solver-next/domain/swap/quote.js'
import { Swap, type NewSwap } from '@arkade-os/solver-next/domain/swap/swap.js'

export const BTC = Asset.of('BTC')
export const btc = (units: bigint): Amount => Amount.of(BTC, units)
export const t = (seconds: number): UnixSeconds => UnixSeconds.of(seconds)
export const ref = (value: string): Reference => Reference.of(value)

export const SECRET = Preimage.of('11'.repeat(32))

export const terms: NewSwap = {
  id: SwapId.of('swap-1'),
  rfqId: RfqId.of('rfq-1'),
  quote: Quote.of(t(2_000), { fee: btc(10n), spreadBps: 0 }),
  hashlock: Hashlock.ofPreimage(SECRET),
  from: { rail: 'arkade', amount: btc(10_000n), contract: 'vhtlc', version: null },
  to: { rail: 'onchain', amount: btc(9_990n), contract: 'onchain-htlc', version: null },
  at: t(1_000),
}

export const quoted = (override: Partial<NewSwap> = {}): Swap => Swap.quote({ ...terms, ...override })
