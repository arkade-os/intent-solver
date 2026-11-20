import { Amount } from '@arkade-os/solver-core/domain/shared/amount.js'
import { Asset } from '@arkade-os/solver-core/domain/shared/asset.js'
import type { Rail } from '@arkade-os/solver-core/domain/shared/endpoint.js'
import { CorruptHistory } from '@arkade-os/solver-core/domain/shared/error.js'
import { RfqId, SwapId } from '@arkade-os/solver-core/domain/shared/ids.js'
import { UnixSeconds } from '@arkade-os/solver-core/domain/shared/time.js'
import { Hashlock, Preimage } from '@arkade-os/solver-core/domain/swap/hashlock.js'
import {
  ContractVersion,
  Reference,
  type ContractKind,
  type LegReferences,
  type LegState,
  type LegTerms,
  type Side,
} from '@arkade-os/solver-core/domain/swap/leg.js'
import { Quote, type AmountMode } from '@arkade-os/solver-core/domain/swap/quote.js'
import { SWAP_TOPIC, type SwapEvent } from '@arkade-os/solver-core/domain/swap/swap_event.js'
import type { SwapOutcome } from '@arkade-os/solver-core/domain/swap/swap_state.js'

type Json = Record<string, unknown>

const amountOut = (amount: Amount): Json => ({ asset: amount.asset, units: amount.units.toString() })
const amountIn = (json: Json): Amount => Amount.of(Asset.of(String(json.asset)), BigInt(String(json.units)))

const termsOut = (terms: LegTerms): Json => ({ ...terms, amount: amountOut(terms.amount) })
const termsIn = (json: Json): LegTerms => ({
  rail: json.rail as Rail,
  amount: amountIn(json.amount as Json),
  contract: json.contract as ContractKind,
  version: json.version == null ? null : ContractVersion.of(String(json.version)),
})

// A field missing from an older body reads as null (`== null` below), never as the text "undefined".
const referencesIn = (json: Json | undefined): LegReferences =>
  Object.fromEntries(Object.entries(json ?? {}).map(([kind, value]) => [kind, Reference.of(String(value))]))

/** What goes in `swap_event.body`: everything but the columns the row already has (swap id, type, time). */
export const encodeSwapEvent = (event: SwapEvent): string => {
  switch (event.type) {
    case 'SwapQuoted':
      return JSON.stringify({
        rfqId: event.rfqId,
        amountMode: event.amountMode,
        validUntil: event.quote.validUntil,
        fee: amountOut(event.quote.pricing.fee),
        spreadBps: event.quote.pricing.spreadBps,
        hashlock: event.hashlock,
        from: termsOut(event.from),
        to: termsOut(event.to),
      })
    case 'LegAdvanced':
      return JSON.stringify({
        side: event.side,
        state: event.state,
        references: event.references,
        preimage: event.preimage,
        expiresAt: event.expiresAt,
      })
    case 'LegReferenced':
      return JSON.stringify({ side: event.side, references: event.references })
    case 'OfferFilled':
      return JSON.stringify({ fill: event.fill })
    case 'SwapFailed':
      return JSON.stringify({ outcome: event.outcome, reason: event.reason })
    case 'SwapResumed':
      return '{}'
  }
}

export const decodeSwapEvent = (id: string, type: string, at: number, body: string): SwapEvent => {
  const json = JSON.parse(body) as Json
  const base = { topic: SWAP_TOPIC, id: SwapId.of(id), at: UnixSeconds.of(at) } as const
  switch (type) {
    case 'SwapQuoted':
      return {
        ...base,
        type,
        rfqId: json.rfqId == null ? null : RfqId.of(String(json.rfqId)),
        amountMode: json.amountMode as AmountMode,
        quote: Quote.of(json.validUntil == null ? null : UnixSeconds.of(Number(json.validUntil)), {
          fee: amountIn(json.fee as Json),
          spreadBps: Number(json.spreadBps),
        }),
        hashlock: json.hashlock == null ? null : Hashlock.of(String(json.hashlock)),
        from: termsIn(json.from as Json),
        to: termsIn(json.to as Json),
      }
    case 'LegAdvanced':
      return {
        ...base,
        type,
        side: json.side as Side,
        state: json.state as LegState,
        references: referencesIn(json.references as Json | undefined),
        preimage: json.preimage == null ? null : Preimage.of(String(json.preimage)),
        expiresAt: json.expiresAt == null ? null : UnixSeconds.of(Number(json.expiresAt)),
      }
    case 'LegReferenced':
      return { ...base, type, side: json.side as Side, references: referencesIn(json.references as Json | undefined) }
    case 'OfferFilled':
      return { ...base, type, fill: json.fill == null ? null : Reference.of(String(json.fill)) }
    case 'SwapFailed':
      return { ...base, type, outcome: json.outcome as SwapOutcome, reason: String(json.reason) }
    case 'SwapResumed':
      return { ...base, type }
    default:
      throw new CorruptHistory(`swap ${id}: unknown event type ${type}`)
  }
}
