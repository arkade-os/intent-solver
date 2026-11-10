import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')

describe('the reconciliation page', () => {
  it('has one navigation entry and one data endpoint', () => {
    expect(source).toContain("['reconciliation', 'reconciliation']")
    expect(source).toContain('reconciliation: () => `/api/reconciliation?window=${state.reconciliation.window}`')
    expect(source).toContain('reconciliation: reconciliationView')
  })

  it('explains spread, reported fees, and missing costs without calling them net profit', () => {
    expect(source).toContain("'spread kept, sats'")
    expect(source).toContain("'execution fees paid'")
    expect(source).toContain("'after reported fees'")
    expect(source).toContain('A missing reported fee means unknown, not zero')
    expect(source).toContain("'Deposits / incoming balance'")
    expect(source).toContain('oldest of the latest')
    expect(source).toContain('reported fees')
    expect(source).toContain('so this is a minimum')
    expect(source).not.toContain("figure('net'")
  })
})
