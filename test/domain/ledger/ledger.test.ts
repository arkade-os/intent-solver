import { describe, expect, it } from 'vitest'
import { Account } from '@arkade-os/solver-core/domain/ledger/account.js'
import { bookSwap, type SwapBooking } from '@arkade-os/solver-core/domain/ledger/book.js'
import { credit, debit, JournalEntry } from '@arkade-os/solver-core/domain/ledger/journal_entry.js'
import { Reconciliation } from '@arkade-os/solver-core/domain/ledger/reconciliation.js'
import { Endpoint } from '@arkade-os/solver-core/domain/shared/endpoint.js'
import { swapId } from '@arkade-os/solver-core/domain/shared/ids.js'
import { ARKADE, BTC, btc, LIGHTNING, t, USDT, usdt } from '../support.js'

const balances = (entries: readonly JournalEntry[]): Record<string, bigint> => {
  const totals: Record<string, bigint> = {}
  for (const { account, units } of entries.flatMap((entry) => entry.postings)) {
    totals[account.key] = (totals[account.key] ?? 0n) + units
  }
  return Object.fromEntries(Object.entries(totals).filter(([, units]) => units !== 0n))
}

describe('journal entry', () => {
  const holding = Account.holding(ARKADE)
  const clearing = Account.swapClearing(BTC)

  it('balances per asset or does not exist', () => {
    expect(() => JournalEntry.of('k', t(1), [debit(holding, btc(10n)), credit(clearing, btc(9n))])).toThrow('off by 1')
    expect(() => JournalEntry.of('k', t(1), [debit(holding, btc(10n))])).toThrow('at least two')
    expect(() => debit(holding, usdt(1n))).toThrow('holds btc')
    expect(JournalEntry.of('k', t(1), [debit(holding, btc(10n)), credit(clearing, btc(10n))]).postings).toHaveLength(2)
  })
})

describe('booking a swap', () => {
  const quoted: SwapBooking = {
    swapId: swapId('swap-1'),
    route: 'arkade:btc->lightning:btc',
    from: { endpoint: ARKADE, amount: btc(10_000n), collected: false },
    to: { endpoint: LIGHTNING, amount: btc(9_973n), paidOut: false, returned: false },
    lost: false,
    cost: null,
  }
  const paid = { ...quoted, to: { ...quoted.to, paidOut: true } }
  const settled = { ...paid, from: { ...quoted.from, collected: true } }

  it('books nothing until value moves, and each fact once', () => {
    expect(bookSwap(null, quoted, t(1))).toEqual([])
    expect(bookSwap(quoted, paid, t(2)).map((e) => e.key)).toEqual(['swap:swap-1:paid-out'])
    expect(bookSwap(paid, paid, t(3))).toEqual([])
  })

  it('leaves the spread as income once the swap settles', () => {
    const entries = [...bookSwap(quoted, paid, t(2)), ...bookSwap(paid, settled, t(3))]
    expect(balances(entries)).toEqual({
      'assets:arkade:btc#btc': 10_000n,
      'assets:lightning:btc#btc': -9_973n,
      'income:swap:arkade:btc->lightning:btc#btc': -27n,
    })
  })

  it('books a known cost as an expense, and an unknown one not at all', () => {
    const costed = { ...settled, cost: btc(3n) }
    expect(bookSwap(paid, settled, t(3)).map((e) => e.key)).not.toContain('swap:swap-1:cost')
    expect(balances(bookSwap(settled, costed, t(4)))).toEqual({
      'expenses:swap:arkade:btc->lightning:btc#btc': 3n,
      'assets:lightning:btc#btc': -3n,
    })
    expect(bookSwap(costed, costed, t(5))).toEqual([])
  })

  it('reverses the payout when our leg is refunded', () => {
    const returned = { ...paid, to: { ...paid.to, returned: true } }
    expect(balances([...bookSwap(quoted, paid, t(2)), ...bookSwap(paid, returned, t(3))])).toEqual({})
  })

  it('writes a lost payout off instead of leaving it in clearing', () => {
    const lost = { ...paid, lost: true }
    const entries = [...bookSwap(quoted, paid, t(2)), ...bookSwap(paid, lost, t(3))]
    expect(balances(entries)).toEqual({
      'assets:lightning:btc#btc': -9_973n,
      'expenses:swap:arkade:btc->lightning:btc#btc': 9_973n,
    })
    expect(bookSwap(lost, lost, t(4))).toEqual([])
    expect(bookSwap(quoted, { ...quoted, lost: true }, t(4))).toEqual([])
  })

  it('keeps a flat fee in the asset given and a spread in the asset paid', () => {
    const cross: SwapBooking = {
      ...quoted,
      route: 'arkade:btc->arkade:usdt',
      from: { ...quoted.from, collected: true },
      to: { endpoint: Endpoint.of('arkade', USDT), amount: usdt(9_686_121n), paidOut: true, returned: false },
      income: [btc(330n), usdt(29_145n)],
    }
    expect(balances(bookSwap(null, cross, t(2)))).toEqual({
      'assets:arkade:btc#btc': 10_000n,
      'income:swap:arkade:btc->arkade:usdt#btc': -330n,
      'equity:trading:btc#btc': -9_670n,
      'assets:arkade:usdt#usdt': -9_686_121n,
      'income:swap:arkade:btc->arkade:usdt#usdt': -29_145n,
      'equity:trading:usdt#usdt': 9_715_266n,
    })
  })

  it('closes a swap that changes asset through trading, balanced in each asset', () => {
    const cross: SwapBooking = {
      ...quoted,
      route: 'arkade:btc->arkade:usdt',
      to: { endpoint: Endpoint.of('arkade', USDT), amount: usdt(9_686_121n), paidOut: true, returned: false },
      from: { ...quoted.from, collected: true },
    }
    expect(balances(bookSwap(null, cross, t(2)))).toEqual({
      'assets:arkade:btc#btc': 10_000n,
      'equity:trading:btc#btc': -10_000n,
      'assets:arkade:usdt#usdt': -9_686_121n,
      'equity:trading:usdt#usdt': 9_686_121n,
    })
  })
})

describe('reconciliation', () => {
  it('reports what the books do not explain, and nothing for a rail it cannot read', () => {
    expect(Reconciliation.of(ARKADE, 1_000n, btc(1_000n)).balanced).toBe(true)
    expect(Reconciliation.of(ARKADE, 1_000n, btc(900n)).difference).toBe(-100n)
    expect(Reconciliation.of(ARKADE, 1_000n, null).difference).toBeNull()
    expect(Reconciliation.of(ARKADE, 1_000n, null).balanced).toBe(false)
  })
})
