/**
 * Two fund sources answering to one id.
 *
 * Its own file because `registerFundSource` is append-only module state — the
 * same shape as `registerLightningRail`, and for the same reason: a consumer
 * registers at import time, above the entrypoint, and nothing ever unregisters.
 * A clashing id registered inside `fundSources.test.ts` would therefore break
 * every test after it rather than the one asserting the refusal. Vitest isolates
 * modules per file, so here it breaks nothing.
 *
 * Worth a file of its own anyway: the failure it prevents is a withdrawal
 * reaching whichever source was built first, which is the wrong wallet paying
 * out while the console shows a button that appears to work.
 */

import { describe, it, expect } from 'vitest'
import { fundSources, registerFundSource } from '@arkade-os/solver-app/ops/fundSources.js'

const services = {
  config: { network: 'regtest' },
  ln: null,
  onchain: null,
  arkade: { wallet: {} },
} as never as Parameters<typeof fundSources>[0]

describe('the fund-source registry', () => {
  it('refuses a duplicate id rather than silently picking one', () => {
    const stub = (label: string) => () => ({
      id: 'twice',
      label,
      unit: 'sats',
      readBalance: async () => ({ unit: 'sats', figures: [] }),
    })
    registerFundSource(stub('first'))
    registerFundSource(stub('second'))

    expect(() => fundSources(services)).toThrow(/two fund sources are registered as 'twice'/)
  })
})
