import { describe, it, expect } from 'vitest'
import {
  explainFailure,
  REFUSAL_EXPLANATIONS,
  STATE_NOTES,
  type RefusalReason,
} from '@arkade-os/solver-core/core/refusalReasons.js'
import type { QuoteRefusal as SendQuoteRefusal } from '@arkade-os/solver-corridors/send/orchestrator.js'
import type { QuoteRefusal as ReceiveQuoteRefusal } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { QuoteRefusal as OnchainSendQuoteRefusal } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import type { QuoteRefusal as OnchainReceiveQuoteRefusal } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'

/**
 * The drift guard for `OrchestratorRefusal`.
 *
 * `REFUSAL_EXPLANATIONS` is `Record<RefusalReason, …>`, so the compiler already
 * forces an entry for every member of `RefusalReason`. What it cannot see is
 * whether `RefusalReason` still describes what the orchestrators RETURN:
 * `OrchestratorRefusal` is written out by hand in `refusalReasons.ts` (the four
 * corridors all export `QuoteRefusal` under that one name, and importing them
 * there would couple a presentation module to four orchestrators). Add a member
 * to any corridor's `QuoteRefusal` and nothing in `src/` complains —
 * `explainFailure` just starts answering `null` for a live refusal code.
 *
 * So the aliasing happens HERE instead, where the coupling is free. These four
 * lines fail `pnpm typecheck` the moment a corridor can return something the
 * table does not explain. They are deliberately type-only: types are erased
 * before vitest runs, so no runtime assertion could do this job.
 */
type Explained<T extends RefusalReason> = T
type _SendExplained = Explained<SendQuoteRefusal>
type _ReceiveExplained = Explained<ReceiveQuoteRefusal>
type _OnchainSendExplained = Explained<OnchainSendQuoteRefusal>
type _OnchainReceiveExplained = Explained<OnchainReceiveQuoteRefusal>

describe('REFUSAL_EXPLANATIONS', () => {
  it('says something distinct for every reason', () => {
    // The table is typed `Record<RefusalReason, …>` over the union of every
    // corridor's closed enum, so a new reason cannot be added without an entry —
    // the compiler enforces coverage. What it cannot enforce is that the prose is
    // real, which is what this checks.
    const entries = Object.entries(REFUSAL_EXPLANATIONS)
    expect(entries.length).toBeGreaterThan(20)
    for (const [reason, explanation] of entries) {
      expect(explanation.meaning.length, `${reason} meaning`).toBeGreaterThan(20)
      expect(explanation.whatToDo.length, `${reason} whatToDo`).toBeGreaterThan(10)
    }
    const meanings = entries.map(([, e]) => e.meaning)
    expect(new Set(meanings).size, 'every reason explained in its own words').toBe(meanings.length)
  })
})

describe('explainFailure', () => {
  it('resolves a bare reason code', () => {
    expect(explainFailure('invoice_expired')?.meaning).toBe(REFUSAL_EXPLANATIONS.invoice_expired.meaning)
  })

  it('finds the reason inside the prose the orchestrator actually stores', () => {
    // Rows do not carry bare codes. `whenFunded` writes `refused to pay: <reason>`,
    // so a resolver that only matched exact strings would explain nothing on the
    // rows an operator most needs explained.
    expect(explainFailure('refused to pay: cltv_budget_too_short')?.meaning).toBe(
      REFUSAL_EXPLANATIONS.cltv_budget_too_short.meaning,
    )
  })

  it('explains the free-text failures that are not enums at all', () => {
    // `whenQuoted` writes these as sentences, not codes. They are ordinary
    // outcomes an operator sees constantly, so leaving them unexplained would
    // leave the most common rows the least legible.
    expect(explainFailure('lockup timeout')).not.toBeNull()
    expect(explainFailure('overfunded lockup: 5000 > 2100 sats')).not.toBeNull()
    expect(explainFailure('invoice expired before funding completed')).not.toBeNull()
    expect(explainFailure('lockup arrived after the funding deadline')).not.toBeNull()
  })

  it('prefers the reason code when a message carries both', () => {
    // `refused to pay: invoice_expired` contains the word "expired" AND the code.
    // The code is the precise answer, so it has to win.
    expect(explainFailure('refused to pay: invoice_expired')?.meaning).toBe(
      REFUSAL_EXPLANATIONS.invoice_expired.meaning,
    )
  })

  it('returns null rather than guessing at something it does not know', () => {
    expect(explainFailure('some operator wrote this by hand')).toBeNull()
    expect(explainFailure('')).toBeNull()
    expect(explainFailure(null)).toBeNull()
  })

  it('does not match a code that merely appears as a substring of a word', () => {
    expect(explainFailure('xxrate_limitedxx')).toBeNull()
  })
})

describe('STATE_NOTES', () => {
  it('warns that a stuck row may already have paid out', () => {
    // The whole reason `stuck` exists: the solver was EXPOSED. Refunding it
    // blindly is a possible double payout, and that fact currently lives only in
    // a code comment where no operator will find it.
    const note = STATE_NOTES.stuck
    expect(note).toBeDefined()
    expect(note?.meaning).toMatch(/paid|exposed/i)
    expect(note?.whatToDo).toMatch(/recheck|tick/i)
  })

  it('covers the terminal states an operator has to act on', () => {
    for (const state of ['stuck', 'refused'] as const) {
      expect(STATE_NOTES[state], state).toBeDefined()
    }
  })
})
