/**
 * The swap pane leads with ONE action, so which one it picks is a money decision:
 * a refund it offers as the obvious next step is a refund one click from running.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const slice = source.slice(source.indexOf('const primaryAction'), source.indexOf('const ACTION_LABELS'))

type Supports = { 'refund-now': boolean; 'claim-now': boolean }
const pick = (supports: Supports | null, swap: Record<string, string>, armed: string[]): string =>
  new Function('readVerdict', `${slice}\nreturn primaryAction`)(() => (supports ? { supports } : null))(
    { swap: { id: 's', ...swap } },
    armed,
  )

const SEND = 'arkade:BTC->lightning:BTC'
const LN_ARMED = ['refund-now', 'claim-now', 'park-swap']

describe('the action the swap pane leads with', () => {
  it('leads with the money action only when the read supports it', () => {
    const swap = { corridor: SEND, state: 'stuck', phase: 'failed' }
    expect(pick({ 'refund-now': true, 'claim-now': false }, swap, LN_ARMED)).toBe('refund-now')
    expect(pick({ 'refund-now': false, 'claim-now': true }, swap, LN_ARMED)).toBe('claim-now')
    expect(pick({ 'refund-now': false, 'claim-now': false }, swap, LN_ARMED)).toBe('tick')
  })

  it('reads the payment first on an unread send that may have paid', () => {
    expect(pick(null, { corridor: SEND, state: 'paying', phase: 'exposed' }, LN_ARMED)).toBe('read-payment')
    expect(pick(null, { corridor: SEND, state: 'stuck', phase: 'failed' }, LN_ARMED)).toBe('read-payment')
  })

  it('never leads with an action the pane does not offer, such as on a delivered swap', () => {
    const delivered = { corridor: SEND, state: 'claimed', phase: 'done' }
    expect(pick({ 'refund-now': true, 'claim-now': false }, delivered, [])).toBe('tick')
  })

  it('rechecks anything else', () => {
    expect(pick(null, { corridor: 'arkade:BTC->onchain:BTC', state: 'funded', phase: 'exposed' }, ['park-swap'])).toBe(
      'tick',
    )
  })
})

describe('the confirmation guards', () => {
  it('ignores the second click of the double-click that opened it', () => {
    expect(source).toContain('if (e.detail > 1 || performance.now() - d.armedAt < 500) return')
  })

  it('files an answer under the swap it was pressed on, not the pane open when it lands', () => {
    expect(source).toContain('forSwap: state.running.forSwap')
  })
})
