import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCHEMA_CATALOG } from '@arkade-os/solver-app/ops/schemaCatalog.js'
import { compiledFilesUnder } from '../support/importScan.js'

const ROOT = join(import.meta.dirname, '..', '..')
const SQL_STATEMENT =
  /[`'"]\s*(SELECT\s.+\sFROM\s|INSERT INTO\s|UPDATE\s+\$?\{?[\w.]+\}?\s+SET\s|DELETE FROM\s|CREATE (UNIQUE )?(TABLE|INDEX)\s|ALTER TABLE\s|PRAGMA\s|DROP TABLE\s)/
const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

describe('the schema catalog', () => {
  const sources = compiledFilesUnder(join(ROOT, 'packages')).filter(
    (file) => file.includes('/src/') && !file.includes('node_modules'),
  )

  it('lists every table the solver creates, at the file that creates it', () => {
    const created: Record<string, string> = {}
    for (const file of sources) {
      for (const [, table] of readFileSync(file, 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)) {
        created[table!] = relative(ROOT, file)
      }
    }
    expect(created).toEqual(SCHEMA_CATALOG)
  })

  it('keeps every statement in a *.sql.ts module', () => {
    const inline = sources
      .filter((file) => !file.endsWith('.sql.ts') && !file.endsWith('core/page.ts'))
      .filter((file) => SQL_STATEMENT.test(code(file)))
      .map((file) => relative(ROOT, file))
    expect(inline).toEqual([])
  })
})
