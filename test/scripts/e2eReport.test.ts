import { describe, it, expect } from 'vitest'
import { durations, filesRun, formatDurations, problems, skipped } from '../../scripts/e2e-report.mjs'

/** A real `--reporter=json` payload, trimmed. Vitest exited 0 on it. */
const report = {
  numTotalTests: 3,
  numPassedTests: 1,
  numPendingTests: 2,
  success: true,
  testResults: [
    {
      name: '/repo/test/e2e/evmQuote.e2e.test.ts',
      status: 'passed',
      startTime: 1000,
      endTime: 4000,
      assertionResults: [
        { status: 'skipped', title: 'derives a covenant address', fullName: 'evm > derives a covenant address' },
        { status: 'skipped', title: 'prices a swap', fullName: 'evm > prices a swap' },
        { status: 'passed', title: 'refuses an unknown token', fullName: 'evm > refuses an unknown token' },
      ],
    },
  ],
}

const green = {
  testResults: [
    {
      name: 'C:\\repo\\test\\e2e\\sendLightning.e2e.test.ts',
      status: 'passed',
      startTime: 0,
      endTime: 90_000,
      assertionResults: [{ status: 'passed', title: 'pays a real invoice' }],
    },
    {
      name: '/repo/test/e2e/sendLightningEdges.e2e.test.ts',
      status: 'passed',
      startTime: 0,
      endTime: 12_000,
      assertionResults: [{ status: 'passed', title: 'refuses an expired invoice' }],
    },
  ],
}

describe('scripts/e2e-report.mjs', () => {
  it('fails a report whose tests were skipped, naming them', () => {
    expect(skipped(report).map((test) => test.title)).toEqual(['derives a covenant address', 'prices a swap'])
    const found = problems(report, ['evmQuote.e2e.test.ts'])
    expect(found.join('\n')).toContain('2 test(s) SKIPPED')
    expect(found.join('\n')).toContain('derives a covenant address')
  })

  it('fails a filter that matched only some of its files', () => {
    // The trap this exists for: vitest exits 1 on a filter matching ZERO files
    // and 0 on one matching SOME, so the exit code cannot see this.
    const found = problems(green, [
      'sendLightning.e2e.test.ts',
      'sendLightningEdges.e2e.test.ts',
      'selfPayment.e2e.test.ts',
    ])
    expect(found.join('\n')).toContain('selfPayment.e2e.test.ts')
    expect(found.join('\n')).toContain('did not run')
  })

  it('fails a file that ran but no group claimed', () => {
    expect(problems(green, ['sendLightning.e2e.test.ts']).join('\n')).toContain(
      'unexpected file(s) ran: sendLightningEdges.e2e.test.ts',
    )
  })

  it('fails an empty report rather than reading it as a pass', () => {
    expect(problems({ testResults: [] }, ['sendLightning.e2e.test.ts']).join('\n')).toContain('no tests at all')
  })

  it('passes only when every expected file ran and nothing skipped', () => {
    expect(problems(green, ['sendLightning.e2e.test.ts', 'sendLightningEdges.e2e.test.ts'])).toEqual([])
  })

  it('reads paths from either platform and reports the slowest file first', () => {
    expect(filesRun(green)).toEqual(['sendLightning.e2e.test.ts', 'sendLightningEdges.e2e.test.ts'])
    expect(durations(green).map((row) => row.file)).toEqual([
      'sendLightning.e2e.test.ts',
      'sendLightningEdges.e2e.test.ts',
    ])
    const table = formatDurations(durations(green))
    expect(table).toContain('90.0s')
    expect(table).toContain('TOTAL')
    expect(table).toContain('102.0s')
  })
})
