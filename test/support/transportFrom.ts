/**
 * Build a transport from the flat service+store shape these tests already write.
 *
 * `HttpDeps` and `RelayIngressDeps` take assembled sets; the tests here are
 * about routing, refusals and framing, so the assembly happens once rather than
 * at every call site. A test about the interface itself should call `buildApp`
 * directly — `test/packaging/sdkSurface.test.ts` does.
 */
import type { Hono } from 'hono'
import { buildApp, type HttpDeps } from '@arkade-os/solver-transport/http/server.js'
import { RelayIngress, type RelayIngressDeps } from '@arkade-os/solver-transport/ingress/relay.js'
import { corridorSetFromDeps, readerSetFromDeps, type FlatCorridorDeps } from '../../src/ops/corridorSet.js'

/** The two fields the composition root supplies, which these helpers stand in for. */
type Assembled = 'corridors' | 'readers'

export const buildAppFrom = (deps: FlatCorridorDeps & Omit<HttpDeps, Assembled>): Hono =>
  buildApp({ ...deps, corridors: corridorSetFromDeps(deps), readers: readerSetFromDeps(deps) })

export const relayIngressFrom = (deps: FlatCorridorDeps & Omit<RelayIngressDeps, Assembled>): RelayIngress =>
  new RelayIngress({ ...deps, corridors: corridorSetFromDeps(deps), readers: readerSetFromDeps(deps) })
