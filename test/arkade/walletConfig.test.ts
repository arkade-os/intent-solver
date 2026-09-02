import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const walletSource = readFileSync(new URL('../../packages/solver-arkade/src/arkade/wallet.ts', import.meta.url), 'utf8')
const floatSource = readFileSync(new URL('../../packages/solver-app/src/ops/float.ts', import.meta.url), 'utf8')

/**
 * Source assertions rather than runtime ones, deliberately: `settlementConfig`
 * is consumed inside `Wallet.create` and no public API reads it back, so the
 * only honest check is that we still pass it.
 *
 * ABSENCE IS NOT "OFF" — the SDK reads an unset `settlementConfig` as its
 * DEFAULT (`pollIntervalMs` 60s) and starts a boarding poll that syncs every
 * registered contract against the indexer every minute. That is the entire
 * reason the line exists, so a well-meaning cleanup deleting it would silently
 * restore the cost with nothing failing.
 */
describe('createArkadeContext', () => {
  it('builds the wallet with background settlement explicitly disabled', () => {
    expect(walletSource).toContain('settlementConfig: false')
  })

  /**
   * The half that must not be dropped with it. Disabling background settlement
   * also disables the SDK's automatic deprecated-signer migration, so this
   * service runs it on its own lifecycle pass instead. Losing this without
   * losing the line above would silently give up the cooperative migration
   * window — funds still recoverable through sweep-then-recovery, but later and
   * more expensively than they need to be.
   */
  it('still runs deprecated-signer migration itself, having taken it over', () => {
    expect(floatSource).toContain('migrateDeprecatedSignerVtxos()')
  })

  /**
   * Source-asserted for the same reason as the two above: `onchainProvider` is
   * consumed inside `Wallet.create` and no public API reads it back.
   *
   * The whole expression, not just the field name, because the CONDITIONAL is
   * the part that matters. The SDK takes `config.onchainProvider || new
   * EsploraProvider(default)`, so passing a provider unconditionally would
   * construct one against `undefined` and blank the per-network fallback that
   * every deployment not setting `ARK_ESPLORA_URL` relies on. A `toContain`
   * on the field alone would stay green through exactly that rewrite.
   */
  it('passes an onchain provider only when one was configured', () => {
    expect(walletSource).toContain(
      'onchainProvider: config.esploraUrl === undefined ? undefined : new EsploraProvider(config.esploraUrl)',
    )
  })
})
