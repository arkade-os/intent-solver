import { describe, expect, it } from 'vitest'
import { summariseSignerMigration } from '@arkade-os/solver-arkade/arkade/signerMigration.js'

const ref = (txid: string) => ({ txid, vout: 0, value: 1000, signerPubKey: 'ab'.repeat(32) })

const report = (over: Record<string, unknown> = {}) => ({ rotated: false, expired: [], signers: [], ...over }) as never

describe('summariseSignerMigration', () => {
  // The overwhelmingly common case: no server signer has been deprecated, so
  // the pass costs one call and reports nothing.
  it('is silent when there is nothing minted under a deprecated signer', () => {
    expect(summariseSignerMigration(report({ skipped: 'no-deprecated-vtxos' }))).toEqual({
      migrated: 0,
      failures: [],
    })
  })

  it('counts inputs moved across both legs', () => {
    const out = summariseSignerMigration(
      report({
        vtxos: { migrated: [ref('aa'), ref('bb')] },
        boarding: { migrated: [ref('cc')] },
      }),
    )
    expect(out.migrated).toBe(3)
    expect(out.failures).toEqual([])
  })

  it('reports a leg failure by name, since the other leg still ran', () => {
    const out = summariseSignerMigration(
      report({ vtxos: { migrated: [], error: 'intent rejected' }, boarding: { migrated: [ref('cc')] } }),
    )
    expect(out.migrated).toBe(1)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toContain('vtxos')
    expect(out.failures[0]).toContain('intent rejected')
  })

  /**
   * Oversized inputs can NEVER migrate cooperatively — a single output under
   * the operator's ceiling cannot hold them — so they need a unilateral exit
   * and a human. Reporting them is the only way anyone finds out.
   */
  it('reports oversized inputs, which no later pass can rescue', () => {
    const out = summariseSignerMigration(report({ vtxos: { migrated: [], oversized: [ref('aa')] } }))
    expect(out.failures).toHaveLength(1)
    // The actionable half, not the word: an operator needs to know these will
    // never migrate on their own and what to do instead.
    expect(out.failures[0]).toContain('unilateral exit')
  })

  /**
   * Cutoff-expired inputs are NOT a failure. The SDK leaves them deliberately:
   * each keeps its own batch expiry, the server sweeps it, and the recovery
   * path — which `runVtxoLifecycle` already runs — re-mints it under the active
   * signer. Reporting them would train an operator to ignore this line.
   */
  it('stays quiet about cutoff-expired inputs, which recovery re-mints', () => {
    const out = summariseSignerMigration(report({ expired: [ref('aa'), ref('bb')] }))
    expect(out.failures).toEqual([])
    expect(out.migrated).toBe(0)
  })

  // The pass refused to rotate because it could not classify our own signer.
  // That is a deployment fact an operator has to resolve; silence would hide it.
  it('reports a refusal to rotate an unrecognised wallet signer', () => {
    const out = summariseSignerMigration(report({ skipped: 'unknown-wallet-signer' }))
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toContain('unknown-wallet-signer')
  })

  it('counts a leg that migrated nothing but did not fail', () => {
    const out = summariseSignerMigration(report({ vtxos: { migrated: [], skipped: 'below-dust' } }))
    expect(out.migrated).toBe(0)
    expect(out.failures).toEqual([])
  })
})
