/**
 * Source-level guards on how the EVM corridors are assembled: that a deployment
 * serving NO token gets nothing new, and that the pieces a deployment which DOES
 * serve one gets are wired the only way that is safe.
 *
 * Asserted against the source text for the reason `overridesApplied.test.ts`
 * gives: constructing services needs live backends and
 * exports nothing, so importing it from a test would kill the runner.
 *
 * SCOPED to `createServices`, not the whole file. A whole-file substring would
 * be satisfied by any mention of these symbols anywhere — including the import
 * line — and would go green while the construction was wrong. That failure mode
 * cost real time elsewhere in this repo.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { corridorSetFromDeps } from '../../src/ops/corridorSet.js'
import { createServicesBody, servicesSource } from '../support/createServicesBody.js'
import { evmCorridorFor } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { EvmCorridorPolicy } from '@arkade-os/solver-core/core/evmCorridorConfig.js'

const createServices = createServicesBody

describe('createServices — EVM stores', () => {
  it('opens them only when a token is configured', () => {
    // The property every existing deployment depends on: no EVM_TOKENS means no
    // SQLite files it never asked for.
    const body = createServices()
    expect(body).toContain('config.evmCorridors.length > 0')
    expect(body).toMatch(/servesEvm \? await EvmSendSwapStore\.open/)
    expect(body).toMatch(/servesEvm \? await EvmReceiveSwapStore\.open/)
  })

  it('puts their tables in the swap file rather than inventing two more', () => {
    // Changed from a pair of `-evm-send`/`-evm-receive` files, and it serves the
    // reason those were introduced for better: the goal was that a deployment
    // serving no token gains no file it never asked for, and this way it gains
    // none at all. `src/db/layout.ts` has the argument — the split layout exists
    // to avoid moving rows a previous release wrote, and a corridor with no
    // previous release has none to preserve.
    //
    // Sharing the driver, not just the path: opening a second connection to a
    // file this process already holds is how a single-writer database starts
    // returning SQLITE_BUSY under load.
    const body = createServices()
    expect(body).toContain('EvmSendSwapStore.open(swapFile)')
    expect(body).toContain('EvmReceiveSwapStore.open(swapFile)')
    expect(body).not.toContain('evmDbPath')
  })

  it('opens ONE store per direction, not one per token', () => {
    // `token_address` is a column, so every token shares these two. A store per
    // token would multiply files and connections with the token list.
    const body = createServices()
    expect(body.match(/EvmSendSwapStore\.open/g)).toHaveLength(1)
    expect(body.match(/EvmReceiveSwapStore\.open/g)).toHaveLength(1)
  })

  it('hands both to Services so a null cannot be forgotten', () => {
    const body = createServices()
    expect(body).toContain('evmSendStore,')
    expect(body).toContain('evmReceiveStore,')
  })
})

describe('the extractor itself', () => {
  it('stops at the function that follows, so the assertions here are scoped', () => {
    // If that boundary is ever renamed, `end` is -1 and the slice silently runs
    // to the end of the module - which is precisely the failure this file's
    // header says cost real time elsewhere in this repo. Every count and
    // ordering assertion below would go green while measuring the wrong text.
    const body = createServices()
    expect(body).not.toContain('const watchUntilStopped')
    expect(body.length).toBeLessThan(servicesSource.length)
  })
})

describe('a half-configured EVM chain is refused, not degraded', () => {
  it('throws when tokens are named but no chain is configured', () => {
    // Tokens with no EVM_RPC_URL still populate `config.evmCorridors` and still
    // open both stores, so the ingress would quote `ethereum:<token>->arkade:BTC`
    // and accept a client's ERC20 lock that no orchestrator exists to answer.
    const body = createServices()
    expect(body).toContain('servesEvm && evmChain === null')
    expect(body).toMatch(/servesEvm && evmChain === null[\s\S]{0,200}?throw new Error\(/)
  })

  it('refuses BEFORE constructing either service, not after', () => {
    const body = createServices()
    expect(body.indexOf('servesEvm && evmChain === null')).toBeLessThan(body.indexOf('new EvmSendSwapService('))
  })
})

describe('one broadcaster across both legs', () => {
  it('constructs exactly one, because the nonce source is per ACCOUNT', () => {
    // Two broadcasters means two nonce sources over one key, which hands out the
    // same nonce twice. The node drops one of the two transactions and neither
    // leg sees an error - a swap that simply never settles.
    expect(createServices().match(/createEvmBroadcaster\(/g)).toHaveLength(1)
  })

  it('gives that same broadcaster to both services', () => {
    expect(createServices().match(/\bbroadcast,/g)).toHaveLength(2)
  })

  it('builds it before either service is constructed', () => {
    const body = createServices()
    expect(body.indexOf('createEvmBroadcaster(')).toBeLessThan(body.indexOf('new EvmSendSwapService('))
    expect(body.indexOf('createEvmBroadcaster(')).toBeLessThan(body.indexOf('new EvmReceiveSwapService('))
  })
})

describe('the EVM receive leg shares the BTC receive ops', () => {
  it('derives them once rather than building a second identical object', () => {
    // Two derivations from one context work, and give the corridors two places
    // to drift apart.
    const body = createServices()
    expect(body.match(/receiveArkadeOpsFromContext\(/g)).toHaveLength(1)
    expect(body).toContain('evmReceiveArkadeDeps(receiveOps)')
  })
})

describe('both legs are actually driven', () => {
  const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const SEND_PAIR = `arkade:BTC->ethereum:${TOKEN}`
  const RECEIVE_PAIR = `ethereum:${TOKEN}->arkade:BTC`
  const policy = (direction: 'send' | 'receive', enabled = true): EvmCorridorPolicy => ({
    corridor: evmCorridorFor(TOKEN, direction),
    token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
    direction,
    limits: { minSats: 1, maxSats: 1_000_000 },
    fee: { bps: 0, flatSats: 0 },
    enabled,
  })

  it('registers each enabled EVM corridor, so the sweep drives it beside the other four', () => {
    // The services existing is not the same as them running: the watch loop
    // drives `services.corridors` and nothing else, so a corridor the registry
    // does not hold never advances a row.
    const corridors = corridorSetFromDeps({
      store: {} as never,
      onchainStore: {} as never,
      evmSendService: { tickAll: async () => [] } as never,
      evmSendStore: {} as never,
      evmReceiveService: { tickAll: async () => [] } as never,
      evmReceiveStore: {} as never,
      evmCorridors: [policy('send'), policy('receive')],
    })
    expect(corridors.get(SEND_PAIR)).toBeDefined()
    expect(corridors.get(RECEIVE_PAIR)).toBeDefined()
  })

  it('drives every enabled leg when the sweep runs the corridor set', async () => {
    const sendTick = vi.fn().mockResolvedValue([])
    const receiveTick = vi.fn().mockResolvedValue([])
    const corridors = corridorSetFromDeps({
      store: {} as never,
      onchainStore: {} as never,
      evmSendService: { tickAll: sendTick } as never,
      evmSendStore: {} as never,
      evmReceiveService: { tickAll: receiveTick } as never,
      evmReceiveStore: {} as never,
      evmCorridors: [policy('send'), policy('receive')],
    })
    // Exactly what watchUntilStopped's sweep does.
    for (const corridor of corridors) await corridor.tickAll()
    expect(sendTick).toHaveBeenCalledTimes(1)
    expect(receiveTick).toHaveBeenCalledTimes(1)
  })

  it('registers nothing for a disabled EVM policy, so its pair refuses by name', () => {
    const corridors = corridorSetFromDeps({
      store: {} as never,
      onchainStore: {} as never,
      evmSendService: { tickAll: async () => [] } as never,
      evmSendStore: {} as never,
      evmReceiveService: { tickAll: async () => [] } as never,
      evmReceiveStore: {} as never,
      evmCorridors: [policy('send', false), policy('receive', false)],
    })
    expect(corridors.get(SEND_PAIR)).toBeUndefined()
    expect(corridors.get(RECEIVE_PAIR)).toBeUndefined()
  })
})
