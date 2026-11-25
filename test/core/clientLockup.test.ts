import { describe, expect, it } from 'vitest'
import {
  isLockupRefusal,
  judgeClientLockup,
  LOCKUP_REFUSAL,
  type ClientLockupRules,
} from '@arkade-os/solver-core/core/clientLockup.js'

const rules = (over: Partial<ClientLockupRules> = {}): ClientLockupRules => ({
  amountSats: 1_000,
  maxOutputs: 2,
  tooLate: false,
  lateReason: (claimable) => `late with ${claimable}`,
  refusal: null,
  ...over,
})
/** A lockup with these claimable outputs, plus `onAssets` sats that sit on asset vtxos. */
const lockup = (claimable: number[], onAssets = 0) => ({
  held: claimable.reduce((sum, value) => sum + value, 0) + onAssets,
  spendable: claimable.map((value) => ({ value })),
})

describe('judgeClientLockup', () => {
  it('adopts the exact amount in time, and waits for less', () => {
    expect(judgeClientLockup(lockup([1_000]), rules())).toEqual({ do: 'adopt_lockup' })
    expect(judgeClientLockup(lockup([600, 400]), rules())).toEqual({ do: 'adopt_lockup' })
    expect(judgeClientLockup(lockup([999]), rules())).toEqual({ do: 'wait' })
    expect(judgeClientLockup(lockup([]), rules())).toEqual({ do: 'wait' })
  })

  it('records all the lockup holds with every refusal, asset vtxos included', () => {
    const refusals = [
      { lockup: lockup([1_001], 50), rules: rules(), reason: 'overfunded lockup: 1001 > 1000 sats', held: 1_051 },
      {
        lockup: lockup([500, 400, 100], 50),
        rules: rules(),
        reason: 'lockup funded in 3 outputs, over 2',
        held: 1_050,
      },
      {
        lockup: lockup([900], 100),
        rules: rules(),
        reason: 'lockup funded on an asset vtxo a claim cannot spend: 1000 held, 900 spendable',
        held: 1_000,
      },
      {
        lockup: lockup([1_000], 50),
        rules: rules({ refusal: 'expires too soon' }),
        reason: 'expires too soon',
        held: 1_050,
      },
      { lockup: lockup([1_000], 50), rules: rules({ tooLate: true }), reason: 'late with 1000', held: 1_050 },
      { lockup: lockup([10]), rules: rules({ tooLate: true }), reason: 'late with 10', held: 10 },
    ]
    for (const { lockup: funded, rules: given, reason, held } of refusals) {
      expect(judgeClientLockup(funded, given)).toEqual({ do: 'fail', reason, lockupValue: held })
    }
  })

  it('records nothing when the lockup is empty', () => {
    expect(judgeClientLockup(lockup([]), rules({ tooLate: true }))).toEqual({ do: 'fail', reason: 'late with 0' })
  })

  it('refuses before it adopts: over the amount, too many outputs, then the caller’s own reason', () => {
    const spread = judgeClientLockup(lockup([500, 400, 100]), rules({ refusal: 'expires too soon' }))
    expect(spread).toMatchObject({ reason: 'lockup funded in 3 outputs, over 2' })
    expect(judgeClientLockup(lockup([1_001]), rules({ tooLate: true }))).toMatchObject({
      reason: 'overfunded lockup: 1001 > 1000 sats',
    })
  })
})

describe('the refusal texts other code reads', () => {
  it('keeps the words stored on rows already in the database', () => {
    expect(LOCKUP_REFUSAL).toEqual({
      overfunded: 'overfunded lockup',
      timeout: 'lockup timeout',
      invoiceExpired: 'invoice expired before funding completed',
      arrivedLate: 'lockup arrived after the funding deadline',
    })
  })

  it('recognises a refusal by how its text begins', () => {
    const late = [LOCKUP_REFUSAL.timeout, LOCKUP_REFUSAL.arrivedLate]
    expect(isLockupRefusal('lockup timeout with partial 10 sats', late)).toBe(true)
    expect(isLockupRefusal('lockup arrived after the funding deadline', late)).toBe(true)
    expect(isLockupRefusal('overfunded lockup: 2 > 1 sats', late)).toBe(false)
    expect(isLockupRefusal('refused: lockup timeout', late)).toBe(false)
    expect(isLockupRefusal(null, late)).toBe(false)
  })
})
