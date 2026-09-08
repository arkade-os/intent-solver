// The two things a vitest exit code cannot tell you about an e2e leg.
//
// A skipped test is `status: "skipped"`, `success: true`, exit 0 — and six
// files here skip themselves when a precondition is absent. A filter matching
// ZERO files exits 1, but one matching only SOME of its names exits 0.
// Durations are printed for a different reason: a suite that finishes in
// seconds inside a two-minute bring-up is not credible as coverage.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Every test in the report, flattened, with the file it came from. */
export const allTests = (report) =>
  (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({ file: basename(file.name ?? ''), ...test })),
  )

/** The basenames vitest actually ran, in report order. */
export const filesRun = (report) => (report.testResults ?? []).map((file) => basename(file.name ?? ''))

export const skipped = (report) => allTests(report).filter((test) => test.status === 'skipped')

export const durations = (report) =>
  (report.testResults ?? [])
    .map((file) => ({
      file: basename(file.name ?? ''),
      ms: Math.max(0, (file.endTime ?? 0) - (file.startTime ?? 0)),
      tests: (file.assertionResults ?? []).length,
      status: file.status ?? 'unknown',
    }))
    .sort((a, b) => b.ms - a.ms)

export const formatDurations = (rows) => {
  const width = Math.max(4, ...rows.map((row) => row.file.length))
  const total = rows.reduce((sum, row) => sum + row.ms, 0)
  const line = (row) =>
    `  ${row.file.padEnd(width)}  ${String((row.ms / 1000).toFixed(1)).padStart(7)}s  ${String(row.tests).padStart(4)} tests  ${row.status}`
  return [
    ...rows.map(line),
    `  ${'TOTAL'.padEnd(width)}  ${String((total / 1000).toFixed(1)).padStart(7)}s  ${String(rows.reduce((sum, row) => sum + row.tests, 0)).padStart(4)} tests`,
  ].join('\n')
}

/**
 * Everything wrong with this report, as lines an operator can act on. Empty
 * means the leg is honest: every expected file ran, and no test was skipped.
 */
export const problems = (report, expectedFiles) => {
  const found = new Set(filesRun(report))
  const expected = new Set(expectedFiles.map((name) => basename(name)))
  const out = []

  const missing = [...expected].filter((name) => !found.has(name))
  if (missing.length > 0) {
    out.push(
      `${missing.length} expected file(s) did not run: ${missing.join(', ')}.`,
      '  A vitest filter that matches only SOME of its names still exits 0. Check the',
      "  group's `files` in .github/e2e-groups.json against test/e2e/.",
    )
  }

  const extra = [...found].filter((name) => !expected.has(name))
  if (extra.length > 0) out.push(`${extra.length} unexpected file(s) ran: ${extra.join(', ')}.`)

  const pending = skipped(report)
  if (pending.length > 0) {
    out.push(
      `${pending.length} test(s) SKIPPED, which this gate treats as a failure:`,
      ...pending.map((test) => `  ${test.file} — ${test.fullName ?? test.title}`),
      '  A skipped e2e test means a precondition was absent, not that it passed.',
      '  Fix the stack this group needs; do not narrow the group to hide it.',
    )
  }

  if (allTests(report).length === 0) out.push('The report contains no tests at all.')
  return out
}

// Run directly (never on import from the unit test): audit one report and exit.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [path, ...expected] = process.argv.slice(2)
  if (!path || expected.length === 0) {
    console.error('usage: node scripts/e2e-report.mjs <vitest-json-report> <expected file>...')
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`could not read the vitest JSON report at ${path}: ${error.message}`)
    console.error('If the suite crashed before writing it, that failure is the one to read.')
    process.exit(2)
  }
  console.log('per-file duration:')
  console.log(formatDurations(durations(report)))
  const found = problems(report, expected)
  if (found.length === 0) {
    console.log(`\nall ${expected.length} expected file(s) ran; nothing skipped.`)
    process.exit(0)
  }
  console.error(`\n${found.join('\n')}`)
  process.exit(1)
}
