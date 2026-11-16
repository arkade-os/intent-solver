import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENTS = ['send-client.mjs', 'send-client-relay.mjs', 'receive-client-relay.mjs', 'receive-quote-relay.mjs']
const source = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../examples/${name}`, import.meta.url)), 'utf8')

// The scripts and docs run these with `--env-file=.env.regtest.client`; the solver's loader refuses that file.
describe('the reference clients', () => {
  it.each(CLIENTS)('%s reads its wallet from the env file it is run with', (name) => {
    expect(source(name)).toContain('configFromKnobs(process.env)')
    expect(source(name)).not.toMatch(/\bloadConfig\(/)
  })
})
