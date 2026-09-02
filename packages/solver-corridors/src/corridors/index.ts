/**
 * The corridors this build serves, as DATA.
 *
 * Lives above `src/core/` rather than inside it because a descriptor names its
 * corridor's state vocabulary, and that vocabulary belongs to the corridor's
 * store — core must not reach into `src/db/`. When corridors become packages
 * each descriptor moves beside its corridor and this file becomes the
 * composition root's list.
 *
 * The four descriptor modules import ONLY types, so tsc erases every one of
 * their imports and they emit with no runtime dependency at all. That is
 * load-bearing rather than incidental: `config.ts` imports this file as a
 * value, and `db/driver.ts` statically imports the `better-sqlite3` native
 * binding — so re-exporting the stores' `NON_TERMINAL`/`EXPOSED` here would
 * pull a native module into every caller of `loadConfig()`, including tests
 * that touch no database. `test/corridors/registry.test.ts` guards both that
 * property and the resulting duplication.
 */
import { createCorridorRegistry, type CorridorDescriptor } from '@arkade-os/solver-core/core/corridorDescriptor.js'
import { LN_SEND } from './lnSend.js'
import { LN_RECEIVE } from './lnReceive.js'
import { ONCHAIN_SEND } from './onchainSend.js'
import { ONCHAIN_RECEIVE } from './onchainReceive.js'

export const ALL_DESCRIPTORS: readonly CorridorDescriptor[] = [LN_SEND, LN_RECEIVE, ONCHAIN_SEND, ONCHAIN_RECEIVE]

export const CORRIDOR_REGISTRY = createCorridorRegistry(ALL_DESCRIPTORS)

/**
 * The descriptor for a pair, or a throw.
 *
 * Throws rather than returning undefined because every caller in this plan is
 * reading a corridor it already knows exists (the union is still closed), so an
 * absent descriptor is a build fault rather than a runtime condition to branch
 * on. The registry-driven dispatch that CAN legitimately miss arrives with the
 * Corridor interface in a later plan.
 */
export const descriptorFor = (pair: string): CorridorDescriptor => {
  const descriptor = CORRIDOR_REGISTRY.get(pair)
  if (descriptor === undefined) throw new Error(`no corridor descriptor for ${pair}`)
  return descriptor
}

export { LN_SEND, LN_RECEIVE, ONCHAIN_SEND, ONCHAIN_RECEIVE }
