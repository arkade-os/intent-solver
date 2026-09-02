import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NON_TERMINAL, SwapStore, type QuoteRecord } from '@arkade-os/solver-corridors/db/swaps.js'

let store: SwapStore
let clock = 1_800_000_000

const quote = (over: Partial<QuoteRecord> = {}): QuoteRecord => ({
  id: 'swap-1',
  invoice: 'lnbc5u1p...',
  paymentHash: 'a'.repeat(64),
  amountSats: 500,
  invoiceExpiresAt: clock + 3600,
  refundLocktime: clock + 7200,
  senderPubkey: '01'.repeat(32),
  receiverPubkey: '02'.repeat(32),
  serverPubkey: '03'.repeat(32),
  claimDelay: 605184,
  refundDelay: 605696,
  refundWithoutReceiverDelay: 606208,
  pkScript: '5120' + 'ab'.repeat(32),
  lockupAddress: 'ark1qexample',
  nonInteractiveParameters: true,
  ...over,
})

beforeEach(async () => {
  // In-memory keeps each test isolated without touching real wallet state.
  store = await SwapStore.open(':memory:', () => clock)
})
afterEach(() => store.close())

describe('insertQuote', () => {
  it('persists everything needed to rebuild the script', async () => {
    const row = await store.insertQuote(quote())
    // These are the fields whose loss makes a funded lockup unspendable AND
    // unrefundable, so they are asserted explicitly rather than by round-trip.
    expect(row.refundLocktime).toBe(clock + 7200)
    expect(row.claimDelay).toBe(605184)
    expect(row.refundDelay).toBe(605696)
    expect(row.refundWithoutReceiverDelay).toBe(606208)
    expect(row.senderPubkey).toBe('01'.repeat(32))
    expect(row.pkScript).toBe('5120' + 'ab'.repeat(32))
    expect(row.state).toBe('quoted')
  })

  it('round-trips nonInteractiveParameters through the real store, both ways', async () => {
    // The encode/decode path ('1'/null on the wire, boolean|null in the row)
    // is asserted by inspection in covenant.ts and arkadeOps.test.ts, but
    // never actually exercised through insertQuote()+get() until now — an
    // inconsistency here is a silent address divergence for this corridor
    // alone, so it earns its own test rather than staying inspection-only.
    const on = await store.insertQuote(quote({ nonInteractiveParameters: true }))
    expect(on.nonInteractiveParameters).toBe(true)

    // Omitted, not merely false: this table's field is the one with a real
    // legacy family, so "never set" is the row shape every pre-existing swap
    // actually has, and null must mean exactly that, not a fabricated `false`.
    // The field is required on QuoteRecord now, same as the other three
    // stores, so `undefined` has to be forced explicitly here — the base
    // fixture itself always sets `true`, matching what the one real call
    // site does.
    const unset = await store.insertQuote(
      quote({ id: 'swap-legacy', paymentHash: 'b'.repeat(64), nonInteractiveParameters: undefined }),
    )
    expect(unset.nonInteractiveParameters).toBeNull()
  })

  it('refuses a second swap for the same payment hash', async () => {
    // Two swaps sharing a payment hash means two lockups and one payment: the
    // client that loses the race has its lockup claimed and cannot refund.
    await store.insertQuote(quote())
    await expect(store.insertQuote(quote({ id: 'swap-2' }))).rejects.toThrow(/UNIQUE/i)
  })

  it('allows re-quoting a hash whose only prior swap was refused', async () => {
    // A refused swap never moved money and never learned a preimage, so its
    // still-valid invoice must not be burned forever.
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'lockup timeout')
    const again = await store.insertQuote(quote({ id: 'swap-2' }))
    expect(again.id).toBe('swap-2')
    // The live lookup sees the new one; the hash is blocked again while it lives.
    expect((await store.findLiveByPaymentHash(again.paymentHash))?.id).toBe('swap-2')
    await expect(store.insertQuote(quote({ id: 'swap-3' }))).rejects.toThrow(/UNIQUE/i)
  })

  it('keeps a claimed hash blocked — the provider may know its preimage', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    await store.transition('swap-1', 'paying', 'paid')
    await store.transition('swap-1', 'paid', 'claiming', { preimage: 'aa'.repeat(32) })
    await store.transition('swap-1', 'claiming', 'claimed', { claim_ark_txid: 'c' })
    await expect(store.insertQuote(quote({ id: 'swap-2' }))).rejects.toThrow(/UNIQUE/i)
    expect((await store.findLiveByPaymentHash(quote().paymentHash))?.state).toBe('claimed')
  })

  it('allows a different payment hash', async () => {
    await store.insertQuote(quote())
    expect((await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64) }))).id).toBe('swap-2')
  })
})

describe('transition', () => {
  it('moves forward and records the outcome', async () => {
    await store.insertQuote(quote())
    expect(await store.transition('swap-1', 'quoted', 'funded', { lockup_txid: 'tx', lockup_value: 500 })).toBe(true)
    const row = await store.get('swap-1')
    expect(row.state).toBe('funded')
    expect(row.lockupTxid).toBe('tx')
    expect(row.lockupValue).toBe(500)
  })

  it('lets exactly one caller win a race', async () => {
    // The guard that stops two workers both paying the same invoice.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    expect(await store.transition('swap-1', 'funded', 'paying')).toBe(true)
    expect(await store.transition('swap-1', 'funded', 'paying')).toBe(false)
    expect((await store.get('swap-1')).state).toBe('paying')
  })

  it('refuses a transition from a state the swap is not in', async () => {
    await store.insertQuote(quote())
    expect(await store.transition('swap-1', 'paid', 'claiming')).toBe(false)
    expect((await store.get('swap-1')).state).toBe('quoted')
  })

  it('throws LOUDLY on an edge that is not in the lifecycle', async () => {
    await store.insertQuote(quote())
    // Backwards, and a skip: both would let a retry tool re-pay or unwind a swap.
    await expect(store.transition('swap-1', 'claiming', 'paying')).rejects.toThrow(/illegal transition/)
    await expect(store.transition('swap-1', 'quoted', 'claimed')).rejects.toThrow(/illegal transition/)
    expect((await store.get('swap-1')).state).toBe('quoted')
  })

  it('permits funded -> claiming, the coupled path that never pays', async () => {
    // A coupled self-payment cannot be paid over Lightning — the invoice is
    // ours — so it skips `paying`/`paid` entirely and claims on the preimage
    // the client revealed by claiming our receive-leg payout.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    expect(await store.transition('swap-1', 'funded', 'claiming', { preimage: 'aa'.repeat(32) })).toBe(true)
    expect((await store.get('swap-1')).state).toBe('claiming')
  })

  it('still refuses funded -> claimed, which would skip the claim itself', async () => {
    // The new edge widens the table by exactly one step. Skipping to `claimed`
    // would record a claim that never happened.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await expect(store.transition('swap-1', 'funded', 'claimed')).rejects.toThrow(/illegal transition/)
  })

  it('permits paying/paid -> refused — the self-payment exception edges — but nowhere else out of exposure', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    await store.transition('swap-1', 'paying', 'refused', { failure_reason: 'self-payment, never paid' })
    expect((await store.get('swap-1')).state).toBe('refused')

    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'bb'.repeat(32) }))
    await store.transition('swap-2', 'quoted', 'funded')
    await store.transition('swap-2', 'funded', 'paying')
    await store.transition('swap-2', 'paying', 'paid')
    await store.transition('swap-2', 'paid', 'refused', { failure_reason: 'self-payment, never paid' })
    expect((await store.get('swap-2')).state).toBe('refused')

    // `claiming` keeps its old edge set: once the preimage is on disk the swap
    // has been paid for real, and no exception applies.
    await store.insertQuote(quote({ id: 'swap-3', paymentHash: 'cc'.repeat(32) }))
    await store.transition('swap-3', 'quoted', 'funded')
    await store.transition('swap-3', 'funded', 'paying')
    await store.transition('swap-3', 'paying', 'paid')
    await store.transition('swap-3', 'paid', 'claiming', { preimage: 'dd'.repeat(32) })
    await expect(store.transition('swap-3', 'claiming', 'refused')).rejects.toThrow(/illegal transition/)
  })

  it('refuses to set a column outside the transition allowlist', async () => {
    await store.insertQuote(quote())
    await expect(store.transition('swap-1', 'quoted', 'funded', { state: 'claimed' })).rejects.toThrow(/may not set/)
    await expect(store.transition('swap-1', 'quoted', 'funded', { payment_hash: 'x' })).rejects.toThrow(/may not set/)
  })
})

describe('patch', () => {
  it('refuses to touch a column outside its allowlist — never state', async () => {
    await store.insertQuote(quote())
    await expect(store.patch('swap-1', { state: 'claimed' })).rejects.toThrow(/may not set/)
    await expect(store.patch('swap-1', { preimage: 'aa' })).rejects.toThrow(/may not set/)
    // A permitted column still works.
    await store.patch('swap-1', { lockup_value: 500 })
    expect((await store.get('swap-1')).lockupValue).toBe(500)
  })
})

describe('findRecoverable', () => {
  it('returns swaps that still need driving, and omits terminal ones', async () => {
    await store.insertQuote(quote())
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64) }))
    await store.insertQuote(quote({ id: 'swap-3', paymentHash: 'c'.repeat(64) }))
    await store.transition('swap-2', 'quoted', 'funded')
    await store.transition('swap-2', 'funded', 'paying')
    await store.transition('swap-3', 'quoted', 'refused')

    expect((await store.findRecoverable()).map((r) => r.id).sort()).toEqual(['swap-1', 'swap-2'])
  })

  it('surfaces a swap that was mid-payment when the process died', async () => {
    // The case that matters: money may be in flight and only the row knows.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying', { pay_attempted_at: clock })

    const recovered = await store.findRecoverable()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.state).toBe('paying')
    expect(recovered[0]?.payAttemptedAt).toBe(clock)
    // and the script is fully reconstructible from the row alone
    expect(recovered[0]?.refundLocktime).toBe(clock + 7200)
    expect(recovered[0]?.claimDelay).toBe(605184)
  })
})

describe('findByStates', () => {
  it('narrows to exactly the states asked for, oldest first', async () => {
    await store.insertQuote(quote())
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64) }))
    await store.insertQuote(quote({ id: 'swap-3', paymentHash: 'c'.repeat(64) }))
    await store.transition('swap-2', 'quoted', 'funded')
    await store.transition('swap-2', 'funded', 'paying')
    await store.transition('swap-3', 'quoted', 'funded')

    // The hot loop's query: it must not see the `quoted` swap that dominates
    // the table, which is the entire reason it can run at a short interval.
    expect((await store.findByStates(['paying', 'paid'])).map((r) => r.id)).toEqual(['swap-2'])
    expect((await store.findByStates(['funded'])).map((r) => r.id)).toEqual(['swap-3'])
  })

  it('asks the database nothing when no state is wanted', async () => {
    await store.insertQuote(quote())

    // An empty IN (...) is not valid SQL; returning early is what keeps the
    // caller from having to special-case it.
    expect(await store.findByStates([])).toEqual([])
  })

  /**
   * The console reads `stuck`, which is TERMINAL and so only ever grows. Left
   * unbounded that read costs a full row — invoice, scripts and all — per
   * parked swap, on every overview load and every SSE event, forever.
   *
   * Both options default off, because the caller that matters is the sweep and
   * the sweep must see every row in creation order.
   */
  it('bounds and reorders only when the caller asks', async () => {
    const base = clock
    try {
      // Distinct creation times, or `ORDER BY created_at` is a tie and proves
      // nothing about which ordering is in force.
      for (const [n, hash] of [
        ['1', 'a'],
        ['2', 'b'],
        ['3', 'c'],
      ] as const) {
        await store.insertQuote(quote({ id: `swap-${n}`, paymentHash: hash.repeat(64) }))
        clock += 10
      }
      // Touched oldest-first, so `updated_at DESC` and `created_at` disagree —
      // which is the whole point: the two orderings must be distinguishable.
      await store.transition('swap-3', 'quoted', 'funded')
      clock += 10
      await store.transition('swap-1', 'quoted', 'funded')

      // Default: every match, oldest first — the sweep's contract, unchanged.
      expect((await store.findByStates(['quoted', 'funded'])).map((r) => r.id)).toEqual(['swap-1', 'swap-2', 'swap-3'])

      const capped = await store.findByStates(['quoted', 'funded'], { limit: 2, newestFirst: true })
      expect(capped).toHaveLength(2)
      // `swap-1` was touched last, so newest-first surfaces it even though it is
      // the OLDEST by creation — the row an operator most likely wants, which
      // `created_at` ordering under a cap would have buried.
      expect(capped[0]?.id).toBe('swap-1')
    } finally {
      clock = base
    }
  })

  /**
   * A capped list must never become the number. The console shows a page and
   * says the true total, so the two are read separately.
   */
  it('counts every match however few the caller reads', async () => {
    for (const [n, hash] of [
      ['1', 'a'],
      ['2', 'b'],
      ['3', 'c'],
    ] as const) {
      await store.insertQuote(quote({ id: `swap-${n}`, paymentHash: hash.repeat(64) }))
    }

    expect(await store.countByStates(['quoted'])).toBe(3)
    expect(await store.findByStates(['quoted'], { limit: 1 })).toHaveLength(1)
    expect(await store.countByStates(['paying'])).toBe(0)
    expect(await store.countByStates([])).toBe(0)
  })
})

describe('fail', () => {
  it('marks an unexposed swap refused', async () => {
    await store.insertQuote(quote())
    await store.fail('swap-1', 'quoted', 'invoice expired')
    const row = await store.get('swap-1')
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('invoice expired')
  })

  // Path from 'quoted' to each exposed state, so each case starts from reality.
  const PATH_TO: Record<string, readonly ['quoted' | 'funded' | 'paying' | 'paid', string][]> = {
    paying: [
      ['quoted', 'funded'],
      ['funded', 'paying'],
    ],
    paid: [
      ['quoted', 'funded'],
      ['funded', 'paying'],
      ['paying', 'paid'],
    ],
    claiming: [
      ['quoted', 'funded'],
      ['funded', 'paying'],
      ['paying', 'paid'],
      ['paid', 'claiming'],
    ],
  }

  it.each(['paying', 'paid', 'claiming'] as const)('marks an exposed swap (%s) stuck, not refused', async (state) => {
    // A swap that may have paid out must never be flattened into a generic
    // failure -- it needs a human, and "refused" would hide that.
    await store.insertQuote(quote())
    for (const [from, to] of PATH_TO[state] ?? []) {
      await store.transition('swap-1', from, to as never)
    }
    expect((await store.get('swap-1')).state).toBe(state)

    await store.fail('swap-1', state, 'lost the preimage')
    expect((await store.get('swap-1')).state).toBe('stuck')
  })

  it('marks a funded-but-unpaid swap refused, since nothing was at risk', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.fail('swap-1', 'funded', 'invoice lapsed before payment')
    expect((await store.get('swap-1')).state).toBe('refused')
  })
})

describe('committedSats', () => {
  it('sums every non-terminal swap — a quoted swap is capacity we may have to honour', async () => {
    await store.insertQuote(quote())
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64), amountSats: 700 }))
    await store.insertQuote(quote({ id: 'swap-3', paymentHash: 'c'.repeat(64), amountSats: 900 }))
    // All three are `quoted`: a client can fund any of them and be paid, so they
    // count. This is the fix for the cap being bypassable by concurrent quotes.
    expect(await store.committedSats()).toBe(500 + 700 + 900)

    // Advancing through the exposed states does not change the committed total.
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    expect(await store.committedSats()).toBe(500 + 700 + 900)

    // Only a TERMINAL state releases committed capacity.
    await store.transition('swap-2', 'quoted', 'funded')
    await store.transition('swap-2', 'funded', 'paying')
    await store.transition('swap-2', 'paying', 'paid')
    await store.fail('swap-2', 'paid', 'lost') // -> stuck (terminal)
    expect(await store.committedSats()).toBe(500 + 900)
  })
})

describe('history', () => {
  it('records every transition for an operator to read back', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    expect((await store.history('swap-1')).map((e) => e.to)).toEqual(['quoted', 'funded', 'paying'])
  })

  it('stamps each transition with when it happened, in order', async () => {
    // What `timeline` subtracts to get per-stage durations. The stamps are
    // SECONDS, so a stage faster than the clock's resolution reads as 0 — the
    // reason that command prints seconds and says so rather than implying more.
    await store.insertQuote(quote())
    clock += 9 // the client took 9s to fund, and the tick loop to notice
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying') // same second: 0s
    clock += 4
    await store.transition('swap-1', 'paying', 'paid')

    const events = await store.history('swap-1')
    expect(events.map((e) => e.at)).toEqual([clock - 13, clock - 4, clock - 4, clock])
    const deltas = events.slice(1).map((e, i) => e.at - events[i]!.at)
    expect(deltas).toEqual([9, 0, 4])
  })
})

describe('findMostRecent', () => {
  it('returns the newest swap whatever state it is in — including terminal ones', async () => {
    // `timeline` with no id shows this row: the swap an operator just watched
    // finish is terminal, so `findRecoverable` would never surface it.
    await store.insertQuote(quote())
    clock += 60
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64) }))
    await store.transition('swap-2', 'quoted', 'refused')
    expect((await store.findMostRecent())?.id).toBe('swap-2')
  })

  it('breaks a same-second tie by insertion order, since created_at cannot', async () => {
    // Two quotes minted inside one second are indistinguishable by time alone.
    await store.insertQuote(quote())
    await store.insertQuote(quote({ id: 'swap-2', paymentHash: 'b'.repeat(64) }))
    expect((await store.findMostRecent())?.id).toBe('swap-2')
  })

  it('returns null on an empty database rather than throwing', async () => {
    expect(await store.findMostRecent()).toBeNull()
  })
})

describe('the operator recovery edge', () => {
  it('keeps stuck out of the sweep, so nothing walks it forward on its own', async () => {
    // The edge exists for a deliberate operator action ONLY. `stuck` staying
    // out of NON_TERMINAL is what stops the sweep re-driving a row a human
    // parked, which is the property the edge must not cost.
    expect(NON_TERMINAL).not.toContain('stuck')
  })

  it('still refuses every way out of stuck that would re-send money', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    await store.fail('swap-1', 'paying', 'lost')
    expect((await store.get('swap-1')).state).toBe('stuck')

    // Re-paying above all: that is the invariant the edge set exists to hold,
    // and it is untouched. A row that reached `stuck` may already have sent
    // sats, so a path back into a payment state could send them twice.
    await expect(store.transition('swap-1', 'stuck', 'paying')).rejects.toThrow(/illegal transition/)
    await expect(store.transition('swap-1', 'stuck', 'paid')).rejects.toThrow(/illegal transition/)

    // ...and the one that is allowed, carrying the preimage that justifies it.
    expect(await store.transition('swap-1', 'stuck', 'claiming', { preimage: 'ab'.repeat(32) })).toBe(true)
    expect((await store.get('swap-1')).state).toBe('claiming')
  })

  /**
   * `stuck -> refused` used to be asserted illegal in the test above, grouped
   * with `paying` and `paid`. It is not the same kind of edge and it is now
   * allowed, deliberately.
   *
   * The rule the edge set actually holds is that nothing leaves `stuck` without
   * evidence — `claiming` carries the preimage that proves the payment settled,
   * and `refused` is taken by `refundNow` only after a refund transaction has
   * been pushed and its txid written to the row. Both exits are earned.
   *
   * What it fixes: a refunded row stayed `stuck` forever, so a swap whose
   * client was whole went on reading "needs a human" and the count in the
   * status bar never came down.
   *
   * What it does NOT weaken: re-paying is still unreachable (asserted above),
   * `refused` is still terminal, and `stuck` is still outside `NON_TERMINAL`,
   * so no sweep walks a row a human parked.
   */
  it('lets a refunded row close, because a refund is evidence too', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    await store.fail('swap-1', 'paying', 'lost')

    expect(await store.transition('swap-1', 'stuck', 'refused')).toBe(true)
    expect((await store.get('swap-1')).state).toBe('refused')
  })

  it('leaves refused terminal, so a closed row cannot be re-driven', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    await store.fail('swap-1', 'paying', 'lost')
    await store.transition('swap-1', 'stuck', 'refused')

    await expect(store.transition('swap-1', 'refused', 'paying')).rejects.toThrow(/illegal transition/)
    await expect(store.transition('swap-1', 'refused', 'claiming')).rejects.toThrow(/illegal transition/)
  })
})

/**
 * A refund is a MONEY MOVEMENT, and it was invisible in the swap's own history.
 *
 * An operator looking at a real stuck row saw `paying -> paid -> stuck` and a
 * refund transaction, and asked where the refund had come from. Fairly: the
 * timeline records state transitions only, `refund_outcome` is written through
 * `patch()`, and `patch()` recorded nothing. The one event in a swap's life that
 * returns a client's money left no trace in the list of what happened to it.
 */
describe('the refund in the swap history', () => {
  const refunded = async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
  }

  it('records a pushed refund, with its txid, as an event', async () => {
    await refunded()
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'dd70ef0b' })

    const notes = (await store.history('swap-1')).filter((e) => e.detail)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.detail).toContain('pushed')
    expect(notes[0]?.detail).toContain('dd70ef0b')
  })

  it('records a refund somebody ELSE pushed, which has no txid of ours', async () => {
    await refunded()
    await store.patch('swap-1', { refund_outcome: 'external' })

    expect((await store.history('swap-1')).filter((e) => e.detail)[0]?.detail).toContain('external')
  })

  it('places the note at the state the swap was in, not as a transition', async () => {
    await refunded()
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'abc' })

    const note = (await store.history('swap-1')).filter((e) => e.detail)[0]
    // from === to: nothing moved in the lifecycle, so it must not read as one.
    expect(note?.from).toBe('paying')
    expect(note?.to).toBe('paying')
  })

  it('does NOT record an event for an ordinary patch', async () => {
    await refunded()
    await store.patch('swap-1', { payment_id: 'pay-1' })

    expect((await store.history('swap-1')).filter((e) => e.detail)).toHaveLength(0)
  })

  it('leaves the ordinary transitions unannotated, so a note stands out', async () => {
    await refunded()
    expect((await store.history('swap-1')).every((e) => e.detail === null)).toBe(true)
  })
})

/**
 * A lockup script can be funded more than once, and refunded more than once.
 *
 * The timeline recorded one `-> funded` transition and nothing afterwards, so a
 * second funding — which the refund path WILL sweep, and which nothing watches
 * on a terminal row — left no trace at all. An operator reading the swap had no
 * way to know the script had been touched again.
 */
describe('repeated fundings and refunds in the history', () => {
  const funded = async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded', { lockup_value: 500, lockup_txid: 'aa', lockup_vout: 0 })
  }
  const notes = async () => (await store.history('swap-1')).filter((e) => e.detail).map((e) => e.detail)

  it('records EVERY refund, not just the first', async () => {
    await funded()
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'r1' })
    await store.patch('swap-1', { refund_outcome: 'pushed', refund_ark_txid: 'r2' })

    const detail = await notes()
    expect(detail).toHaveLength(2)
    expect(detail[0]).toContain('r1')
    expect(detail[1]).toContain('r2')
  })

  it('records each funding OUTPOINT individually, with its value', async () => {
    await funded()
    await store.noteFundings('swap-1', [
      { txid: 'aa'.repeat(32), vout: 0, value: 502 },
      { txid: 'bb'.repeat(32), vout: 1, value: 502 },
    ])

    const detail = await notes()
    expect(detail).toHaveLength(2)
    expect(detail[0]).toContain(`${'aa'.repeat(32)}:0`)
    expect(detail[0]).toContain('502')
    expect(detail[1]).toContain(`${'bb'.repeat(32)}:1`)
  })

  it('does not re-note an outpoint it has already recorded', async () => {
    await funded()
    const first = { txid: 'aa'.repeat(32), vout: 0, value: 502 }
    await store.noteFundings('swap-1', [first])
    await store.noteFundings('swap-1', [first, { txid: 'bb'.repeat(32), vout: 1, value: 300 }])

    // Re-observing the same script every tick must not write a line every tick.
    const detail = await notes()
    expect(detail).toHaveLength(2)
    expect(detail[1]).toContain('bb'.repeat(32))
  })

  it('tells two outputs of the SAME tx apart by vout', async () => {
    await funded()
    await store.noteFundings('swap-1', [
      { txid: 'cc'.repeat(32), vout: 0, value: 100 },
      { txid: 'cc'.repeat(32), vout: 1, value: 200 },
    ])

    expect(await notes()).toHaveLength(2)
  })

  it('notes the FIRST funding too, so every deposit has a transaction to open', async () => {
    // The `-> funded` transition marks the state change; it cannot name the
    // outpoint, and an operator chasing a deposit wants the transaction. Making
    // the first one special left exactly one funding with no link anywhere.
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded', { lockup_value: 500 })
    await store.noteFundings('swap-1', [{ txid: 'dd'.repeat(32), vout: 0, value: 500 }])

    const detail = await notes()
    expect(detail).toHaveLength(1)
    expect(detail[0]).toContain('dd'.repeat(32))
  })
})

/**
 * Which wallet actually made the payment.
 *
 * A payment id is only meaningful to the backend that minted it, and only while
 * that backend is pointed at the same wallet. Switching providers — or the same
 * provider onto a different seed — leaves every live row holding an id nothing
 * can resolve, and the console reports that as `undecided`, which reads like a
 * backend fault rather than a configuration change.
 *
 * Observed after a vendor migration: a row minted under one rail, read back on
 * another as "StorageError: Payment with id ... not found".
 */
describe('the wallet a payment was made from', () => {
  it('records the backend and its wallet fingerprint alongside the payment id', async () => {
    await store.insertQuote(quote())
    await store.transition('swap-1', 'quoted', 'funded')
    await store.transition('swap-1', 'funded', 'paying')
    await store.patch('swap-1', {
      payment_id: 'LightningSendRequest:01a0',
      payment_backend: 'lnd',
      payment_wallet: '039ab48f9fe8be91',
    })

    const row = await store.get('swap-1')
    expect(row.paymentBackend).toBe('lnd')
    expect(row.paymentWallet).toBe('039ab48f9fe8be91')
  })

  it('is null on a row that never reached a payment', async () => {
    await store.insertQuote(quote())

    const row = await store.get('swap-1')
    expect(row.paymentBackend).toBeNull()
    expect(row.paymentWallet).toBeNull()
  })
})
