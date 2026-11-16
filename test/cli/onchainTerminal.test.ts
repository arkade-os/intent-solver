import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OnchainSendMachine } from '@arkade-os/solver-corridors/machines/onchainSend.js'

const cliSource = readFileSync(fileURLToPath(new URL('../../packages/solver-app/src/cli.ts', import.meta.url)), 'utf8')

describe('send-onchain stops polling at every terminal state', () => {
  it('counts refunded as terminal', () => {
    expect([...OnchainSendMachine.terminal].sort()).toEqual(['claimed', 'refunded', 'refused', 'stuck'])
  })

  // cli.ts runs main() on import, so the derivation is pinned on its text.
  it('takes ONCHAIN_TERMINAL from the machine rather than a hand list', () => {
    expect(cliSource).toMatch(/const ONCHAIN_TERMINAL\b[^=]*= new Set\(OnchainSendMachine\.terminal\)/)
  })
})
