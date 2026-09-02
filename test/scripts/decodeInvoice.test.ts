import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/decode-invoice.mjs', import.meta.url))

const dump = async (invoice: string): Promise<string> => (await run(process.execPath, [SCRIPT, invoice])).stdout

/**
 * The hop dump an operator reaches for mid-incident, held to the solver's own
 * reading of the same invoice.
 *
 * It exists because the refusal message carries a TOTAL, and a total cannot say
 * whether one hint is absurd or several are fine with a bad peer among them —
 * which is the difference between "this deployment cannot serve it" and "nobody
 * can". A dump that disagreed with `decodeInvoice` would answer that question
 * wrongly at exactly the moment it is being asked, so the agreement is pinned
 * rather than assumed. Same reason the version in `plans/going-to-mainnet.md`
 * was verified by hand before it was offered.
 */
describe('scripts/decode-invoice.mjs', () => {
  const forged = (routeHints: readonly (readonly number[])[], minFinalCltvBlocks = 18): string =>
    forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: 2100,
      timestamp: 1_734_606_755,
      expirySeconds: 3600,
      minFinalCltvBlocks,
      routeHints,
    }).invoice

  it.each([
    ['no hints', [] as readonly (readonly number[])[], 18],
    ['one multi-hop hint', [[40, 30, 20]], 18],
    ['a bad alternative among several', [[40], [40_000]], 60],
    ['every hint bad', [[300], [290]], 60],
  ])('agrees with decodeInvoice on %s', async (_label, routeHints, finalDelta) => {
    const invoice = forged(routeHints, finalDelta)
    const out = await dump(invoice)

    // `decodeInvoice` refuses the all-bad case, so the totals are recomputed
    // here rather than read off it — which is the case the dump is FOR: the
    // invoice the solver would not decode is the one being investigated.
    const totals = routeHints.map((hops) => hops.reduce((sum, hop) => sum + hop, 0))
    const best = totals.length === 0 ? 0 : Math.min(...totals)
    const worst = totals.reduce((w, t) => Math.max(w, t), 0)

    expect(out).toContain(`final delta: ${finalDelta}`)
    expect(out).toContain(`best hint: ${best} (final + best = ${finalDelta + best})`)
    expect(out).toContain(`worst hint: ${worst} (final + worst = ${finalDelta + worst})`)
    for (const [i, hops] of routeHints.entries()) {
      expect(out).toContain(`hint ${i}: ${hops.length} hop(s), cltv total ${totals[i]}`)
    }
  })

  it('reads the same hops off a real invoice as the solver does', async () => {
    const invoice = forged([[40, 30], [150]])
    const decoded = decodeInvoice(invoice)
    const out = await dump(invoice)
    expect(out).toContain(`best hint: ${decoded.bestRouteHintCltvBlocks}`)
    expect(out).toContain(`worst hint: ${decoded.worstRouteHintCltvBlocks}`)
    expect(out).toContain(`final delta: ${decoded.minFinalCltvBlocks}`)
  })

  /**
   * The scid annotation, and the caveat that has to travel with it.
   *
   * `f42400f424000001` decodes to block 16000000 and reads like an impossible
   * future height — which is exactly the inference that must NOT be drawn. LND
   * allocates `option_scid_alias` values from heights 16000000-16250000, and
   * BOLT #2 requires an unannounced channel's alias to be unrelated to its real
   * `short_channel_id` while permitting it in `r` fields. So this value is
   * better evidence of a live PRIVATE channel than of a fiction, and
   * denylisting it on the strength of the number would price a routable channel
   * out of a refund deadline — the double-collect window, not a lost swap.
   *
   * Pinned here because the dump is what an operator reads before touching
   * `LN_SEND_HINT_SCID_DENYLIST`, so the warning has to be un-deletable by
   * accident.
   */
  const aliasShaped = () =>
    forgeInvoiceWithPreimage({
      network: 'bc',
      amountSats: 2100,
      timestamp: 1_734_606_755,
      expirySeconds: 3600,
      minFinalCltvBlocks: 60,
      routeHints: [[{ cltv: 40_000, scid: 'f42400f424000001' }]],
    }).invoice

  it('decodes each hop scid, so a hint can be located without hex arithmetic', async () => {
    expect(await dump(aliasShaped())).toContain('scid=f42400f424000001 (block 16000000, tx 16000000, out 1)')
  })

  it('flags a scid in LND’s alias range rather than letting it read as impossible', async () => {
    expect(await dump(aliasShaped())).toContain('[LND scid-alias range]')
  })

  it('says the block field is not evidence about whether the channel exists', async () => {
    const out = await dump(aliasShaped())
    expect(out).toContain('option_scid_alias')
    expect(out).toContain('NOT a confirmation height')
    expect(out).toContain('"edge not found" proves nothing')
  })

  it('says how to call it rather than throwing a decoder error', async () => {
    await expect(run(process.execPath, [SCRIPT])).rejects.toMatchObject({ code: 2 })
  })
})
