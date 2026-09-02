/**
 * Every quote this service issues builds the EXTENDED covenant.
 *
 * `CovenantSwapScript` has two shapes. With a client refund pubkey it is
 * `VHTLC.ScriptV2`, which the SDK can re-derive — so the lockup registers as a
 * contract, appears in the wallet's own reads, and reaches `LockupWatcher` over
 * the contract stream. Without one it is the base three-leaf program: a
 * compiled `ArkadeProgramScript` no handler can re-derive, therefore never a
 * contract, therefore invisible to all of the above.
 *
 * The RFQ schema requires `client_refund_pubkey`, so real traffic could never
 * produce the base shape. The two CLI self-tests could, and did — which meant
 * `cli send`, the command the runbook uses to verify a deployment, exercised a
 * covenant shape no client ever receives.
 *
 * These pin that shut. The base branch stays in `covenant.ts` because legacy
 * rows still have to be REBUILT to be refunded; what must not come back is
 * anything MINTING one.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('no code path mints a base three-leaf lockup', () => {
  it('passes a client refund pubkey at every Lightning-send quote in the CLI', () => {
    const cli = source('../../packages/solver-app/src/cli.ts')
    // `.quote(` calls on the Lightning send service, with the 400 characters
    // that follow — enough to cover the options object on the same call.
    const calls = [...cli.matchAll(/services\.(?:onchainS|s)ervice[!?]?\.quote\([\s\S]{0,400}/g)].map((m) => m[0])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.slice(0, 300), 'a quote without a client refund pubkey builds the base covenant').toContain(
        'clientRefundPubkey',
      )
    }
  })

  it('keeps the RFQ schema demanding one, so no client can opt out', () => {
    // The other half: if this became optional, real traffic could mint a base
    // lockup again and the CLI guard above would not notice.
    const payloads = source('../../packages/solver-corridors/src/wire/payloads.ts')
    const field = payloads.slice(payloads.indexOf('client_refund_pubkey'))
    expect(field.slice(0, 200)).not.toContain('.optional()')
    expect(field.slice(0, 200)).toContain('.length(64)')
  })

  it('no longer carries the base script at all', () => {
    // The branch and its artifact are gone, not merely unreachable.
    const covenant = source('../../packages/solver-arkade/src/arkade/covenant.ts')
    expect(covenant).not.toContain('COVENANT_SWAP_ARTIFACT')
    expect(covenant).not.toContain('ArkadeProgramScript(COVENANT_SWAP_PROGRAM')
  })

  it('REFUSES a legacy row rather than rebuilding it as something else', () => {
    // The safety property that replaces the deleted branch. A row quoted before
    // the extended shape carries no client key; with the base script gone there
    // is nothing correct to build, and quietly building a DIFFERENT script
    // would sign a refund against an address the lockup was never funded at.
    // So it stops, and names the row.
    // `covenantScriptFromRow` moved to `src/arkade/covenantRow.ts` — it rebuilds
    // an ARKADE covenant, and leaving it in the send corridor was what forced
    // `src/arkade/` to import the corridor layer. The refusal it guards is
    // unchanged and moved with it.
    const ops = source('../../packages/solver-arkade/src/arkade/covenantRow.ts')
    expect(ops).toContain('predates the client-unilateral refund leaf')
    const refuse = ops.indexOf('row.clientRefundPubkey === null')
    const build = ops.indexOf('new CovenantSwapScript(')
    expect(refuse).toBeGreaterThan(-1)
    expect(refuse).toBeLessThan(build)
  })
})
