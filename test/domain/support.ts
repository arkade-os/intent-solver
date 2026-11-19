import { Amount } from '@arkade-os/solver-core/domain/shared/amount.js'
import { Asset } from '@arkade-os/solver-core/domain/shared/asset.js'
import { Endpoint } from '@arkade-os/solver-core/domain/shared/endpoint.js'
import { RfqId, SwapId } from '@arkade-os/solver-core/domain/shared/ids.js'
import { UnixSeconds } from '@arkade-os/solver-core/domain/shared/time.js'
import { Hashlock, Preimage } from '@arkade-os/solver-core/domain/swap/hashlock.js'
import { Quote } from '@arkade-os/solver-core/domain/swap/quote.js'
import { Swap, type NewSwap } from '@arkade-os/solver-core/domain/swap/swap.js'

export const t = UnixSeconds.of
export const BTC = Asset.of('btc')
export const USDT = Asset.of('usdt')
export const btc = (units: bigint): Amount => Amount.of(BTC, units)
export const usdt = (units: bigint): Amount => Amount.of(USDT, units)
export const ARKADE = Endpoint.of('arkade', BTC)
export const ONCHAIN = Endpoint.of('onchain', BTC)
export const LIGHTNING = Endpoint.of('lightning', BTC)

export const SECRET = Preimage.of('11'.repeat(32))
export const WRONG_SECRET = Preimage.of('22'.repeat(32))

export const terms: NewSwap = {
  id: SwapId.of('swap-1'),
  rfqId: RfqId.of('rfq-1'),
  amountMode: 'exactIn',
  quote: Quote.of(t(2_000), { fee: btc(10n), spreadBps: 0 }),
  hashlock: Hashlock.ofPreimage(SECRET),
  from: { rail: 'arkade', amount: btc(10_000n), contract: 'vhtlc' },
  to: { rail: 'onchain', amount: btc(9_990n), contract: 'onchain-htlc' },
  at: t(1_000),
}

export const quoted = (override: Partial<NewSwap> = {}): Swap => Swap.quote({ ...terms, ...override })

/** A swap walked to `awaiting_claim`: both legs locked. */
export const bothLocked = (): Swap => {
  const swap = quoted()
  swap.lock('from', t(1_001), 'txid-in')
  swap.locking('to', t(1_002))
  swap.lock('to', t(1_003), 'txid-out')
  return swap
}
