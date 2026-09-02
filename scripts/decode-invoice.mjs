/**
 * What CLTV does this BOLT11 actually demand, hop by hop?
 *
 * The question comes up mid-incident, when a send has been refused with
 *
 *   invoice rejected: cltv_too_large (final delta 60 + best route hint 40000 = ...)
 *
 * and the number in the message is a total. A total cannot say whether the
 * invoice carries one absurd hint or several sane ones with a bad peer among
 * them — and that difference decides everything: route hints are ALTERNATIVES,
 * so one bad hint among several is an invoice every real payer settles, while a
 * single bad hint is an invoice no one can route cheaply. The first is a
 * backend limitation on this deployment (see `hintCltvBlocks` in
 * `src/core/send.ts`), the second is the payee's problem.
 *
 * Pure decode, no SDK and no wallet: it reads the string and nothing else, so
 * it is safe to run anywhere and needs no `.env`, no build, and no network.
 *
 *   node scripts/decode-invoice.mjs lnbc21u1p...
 *
 * The two totals it prints are the two the solver bounds against — `best` at
 * decode (the floor, "unservable anywhere") and `worst` in the acceptance gate
 * ("unservable HERE, because this rail cannot cap the route it picks").
 *
 * Each hop's scid is printed decoded as well as raw, to locate the hint the
 * CLTV is attached to. Read the caveat it prints with them: those numbers are
 * NOT evidence about whether the channel exists — see
 * `LN_SEND_HINT_SCID_DENYLIST` and docs/runbook.md.
 */

import { decode } from 'light-bolt11-decoder'

/**
 * LND allocates `option_scid_alias` values from this block-height range
 * (`aliasmgr.IsAlias`, lnd). A hint scid inside it is most likely an alias for a
 * live PRIVATE channel — which is the opposite of what its impossible-looking
 * height suggests, and the trap this annotation exists to spring.
 */
const LND_ALIAS_RANGE = [16_000_000n, 16_250_000n]

/**
 * A short_channel_id is BLOCK(3) || TX(3) || OUT(2) for a real, confirmed
 * channel — printed so an operator can tell one hint from another without doing
 * hex by hand.
 *
 * Emphatically NOT a routability check. A hint may carry an
 * `option_scid_alias` instead, which BOLT #2 requires to be unrelated to the
 * real `short_channel_id` and permits in BOLT 11 `r` fields, so these fields
 * may decode to nothing meaningful at all. See the caveat printed below the
 * hints, and docs/runbook.md before putting any scid on a denylist.
 */
const scidParts = (scid) => {
  if (typeof scid !== 'string' || !/^[0-9a-f]{16}$/i.test(scid)) return ''
  const n = BigInt(`0x${scid}`)
  const block = n >> 40n
  const alias = block >= LND_ALIAS_RANGE[0] && block < LND_ALIAS_RANGE[1] ? ' [LND scid-alias range]' : ''
  return ` (block ${block}, tx ${(n >> 16n) & 0xffffffn}, out ${n & 0xffffn})${alias}`
}

const raw = process.argv[2]
if (!raw) {
  console.error('usage: node scripts/decode-invoice.mjs <bolt11>')
  process.exit(2)
}

const decoded = decode(raw.toLowerCase())
const value = (name) => decoded.sections.find((s) => s.name === name)?.value

// BOLT11's default when there is no `c` tag — an absent tag is a real 18, not
// "unknown", exactly as `decodeInvoice` reads it.
const finalDelta = value('min_final_cltv_expiry') ?? 18
console.log('final delta:', finalDelta)

const hints = decoded.sections.filter((s) => s.name === 'route_hint')
const totals = hints.map((hint, i) => {
  const hops = hint.value ?? []
  const total = hops.reduce((sum, hop) => sum + (hop.cltv_expiry_delta ?? 0), 0)
  console.log(`hint ${i}: ${hops.length} hop(s), cltv total ${total}`)
  for (const [j, hop] of hops.entries()) {
    console.log(
      `  hop ${j}: cltv=${hop.cltv_expiry_delta} base=${hop.fee_base_msat}` +
        ` ppm=${hop.fee_proportional_millionths} scid=${hop.short_channel_id}${scidParts(hop.short_channel_id)}`,
    )
  }
  return total
})

if (hints.length > 0) {
  // Printed every time, beside the numbers it is about. The decoded block/tx/out
  // above reads like a claim about whether a channel exists, and it is not one:
  // a private channel's hint carries an alias unrelated to any real scid, and
  // private channels are absent from gossip, so neither a high block field nor a
  // missing `getchaninfo` edge says anything about routability. Adding a scid to
  // LN_SEND_HINT_SCID_DENYLIST on that basis risks the double-collect window —
  // see docs/runbook.md for what does count as evidence.
  console.log(
    '\nnote: a hint scid may be an option_scid_alias (BOLT #2), which is unrelated to' +
      '\n      any real short_channel_id — so its block field is NOT a confirmation height,' +
      '\n      and a value above the chain tip is no evidence the channel does not exist.' +
      '\n      Private channels are absent from gossip too, so "edge not found" proves nothing.' +
      '\n      Denylist a scid only on confirmation from the vendor/operator/recipient.',
  )
}

const best = totals.length === 0 ? 0 : Math.min(...totals)
const worst = totals.reduce((w, t) => Math.max(w, t), 0)
console.log(`best hint: ${best} (final + best = ${finalDelta + best})`)
console.log(`worst hint: ${worst} (final + worst = ${finalDelta + worst})`)
