import { describe, it, expect } from 'vitest'
import {
  unsettledSats,
  staleBoardingSuspected,
  settleTimeoutMessage,
  settleTimeoutMs,
  settleWithin,
  DEFAULT_SETTLE_TIMEOUT_MS,
  MAX_SETTLE_TIMEOUT_MS,
} from '../../scripts/settle-plan.mjs'

/**
 * The decision `regtest-settle.mjs` makes, held to the balance a hung run
 * actually printed (#37). Why it bounds rather than skips: `settle-plan.mjs`.
 */
describe('scripts/settle-plan.mjs', () => {
  const hung = {
    boarding: { confirmed: 5_000_000, unconfirmed: 0, total: 5_000_000 },
    settled: 4_950_000,
    preconfirmed: 0,
    available: 4_950_000,
    recoverable: 0,
    total: 9_950_000,
  }
  const green = { ...hung, boarding: { confirmed: 0, unconfirmed: 0, total: 0 }, total: 4_950_000 }
  const freshDeposit = { ...hung, settled: 0, available: 0, total: 5_000_000 }

  describe('what counts as unsettled', () => {
    it('still counts the boarding entry of the hung run, rather than skipping the settle on suspicion', () => {
      expect(unsettledSats(hung)).toBe(5_000_000)
    })

    it('asks for nothing when the wallet is already settled', () => {
      expect(unsettledSats(green)).toBe(0)
    })

    it('counts recoverable, the state the script exists for', () => {
      expect(unsettledSats({ ...green, recoverable: 258_112 })).toBe(258_112)
    })

    it('reads the bigints getBalance actually returns', () => {
      expect(unsettledSats({ boarding: { confirmed: 5_000_000n }, preconfirmed: 0n, recoverable: 0n })).toBe(5_000_000)
    })
  })

  describe('the double-count signature', () => {
    it('flags a boarding entry sitting beside offchain funds that could account for it', () => {
      expect(staleBoardingSuspected(hung)).toBe(true)
    })

    it('does not accuse a genuine deposit into an empty wallet', () => {
      expect(staleBoardingSuspected(freshDeposit)).toBe(false)
    })

    it('does not accuse a wallet with no boarding entry at all', () => {
      expect(staleBoardingSuspected(green)).toBe(false)
    })

    it('counts preconfirmed as offchain funds too, not just settled', () => {
      expect(staleBoardingSuspected({ ...freshDeposit, preconfirmed: 4_950_000 })).toBe(true)
    })
  })

  describe('what the deadline says when it fires', () => {
    it('names both sides of the double count and the commitment that has not confirmed', () => {
      const message = settleTimeoutMessage(hung, 120_000)
      expect(message).toContain('boarding.confirmed 5000000')
      expect(message).toContain('settled 4950000')
      expect(message).toContain('commitment')
      expect(message).toContain('120s')
    })

    it('does not invent a diagnosis for a settle that was not double counting', () => {
      const message = settleTimeoutMessage(freshDeposit, 120_000)
      expect(message).toContain('120s')
      expect(message).not.toContain('commitment')
    })

    // A genuine deposit into a wallet that already held float has these very fields.
    it('offers the double count as a possibility, not a fact', () => {
      const message = settleTimeoutMessage(hung, 120_000)
      expect(message).toContain('MAY be one deposit counted twice')
      expect(message).toContain('genuine second deposit')
      expect(message).not.toContain('Nothing was lost')
    })
  })

  describe('the deadline itself', () => {
    it('gives up on a settle that never returns, instead of waiting forever', async () => {
      await expect(settleWithin(() => new Promise(() => {}), 20, 'gave up')).rejects.toThrow('gave up')
    })

    it('returns the txid of a settle that completes', async () => {
      await expect(settleWithin(() => Promise.resolve('txid-abc'), 20_000, 'gave up')).resolves.toBe('txid-abc')
    })

    it('lets a real settle failure through under its own message', async () => {
      await expect(settleWithin(() => Promise.reject(new Error('No inputs found')), 20_000, 'gave up')).rejects.toThrow(
        'No inputs found',
      )
    })

    it.each([[undefined], [''], ['not-a-number'], ['0'], ['-1'], ['120000.5'], ['2147483648'], ['1e21']])(
      'falls back to the default deadline for %p',
      (raw) => {
        expect(settleTimeoutMs(raw)).toBe(DEFAULT_SETTLE_TIMEOUT_MS)
      },
    )

    it('takes an override from the environment for a slower stack', () => {
      expect(settleTimeoutMs('600000')).toBe(600_000)
    })

    it('keeps the largest delay setTimeout honours, and refuses the one past it', () => {
      expect(settleTimeoutMs(String(MAX_SETTLE_TIMEOUT_MS))).toBe(MAX_SETTLE_TIMEOUT_MS)
      expect(settleTimeoutMs(String(MAX_SETTLE_TIMEOUT_MS + 1))).toBe(DEFAULT_SETTLE_TIMEOUT_MS)
    })
  })
})
