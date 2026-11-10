import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')

describe('the native asset P&L view', () => {
  it('shows flat fees and spread separately without converting them to BTC', () => {
    expect(source).toContain("'native P&L by asset'")
    expect(source).toContain("'input flat fee'")
    expect(source).toContain("'output spread'")
    expect(source).toContain('with no BTC conversion')
    expect(source).toContain('nativePnlBreakdown(record.nativePnl)')
    expect(source).toContain('nativePnlPanel(data.summary.nativePnl)')
  })
})
