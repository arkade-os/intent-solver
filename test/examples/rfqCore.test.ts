/**
 * The trader library's protocol core, proven against the REAL service — the
 * same Hono app over an injected fetch, and the same RelayIngress over a real
 * in-process WebSocket broker. What passes here is what an intent-submitter
 * POC experiences.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { WebSocketServer, WebSocket as WsClient } from 'ws'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import {
  webSocketRelayConnection,
  matchesFilter,
  type RelayEvent,
} from '@arkade-os/solver-transport/relay/connection.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { ROUTE_CLTV_BUDGET_BLOCKS } from '@arkade-os/solver-core/core/send.js'
import {
  AddressMismatch,
  SwapRefusal,
  assertFundable,
  httpTransport,
  newRfqId,
  pollStatus,
  relayTransport,
  requestQuote,
  verifyLockupAddress,
} from '../../examples/lib/rfq-core.mjs'
import { buildAppFrom, relayIngressFrom } from '../support/transportFrom.js'

const INVOICE =
  'lnbc21u1pnk8larsp526g88ejh9ac0es9j6juxwenzdzvs6hcrphna5pp3jefpukmtk3hqpp5m206npk0fr6k45u8f90capqw48k3pzymlqhk0j98kyx4mz383pkqdz9235x2gr3w45kx6eqvfex7amwypnx77pqdf6k6urnyphhvetjyp6xsefqd3sh57fqv3hkwxqyp2xqcqz95rzjqv9ruzr6quwpsuwmyshlvenk0xm7djrtt8ugt2ja6cx3dkqtccdgvzzxeyqq28qqqqqqqqqqqqqqq9gq2y9qyysgqvu5k5w9q0xe62envhds058r9h8v5uak09hn3uzlw39sqkcuwh34j44gc53j6x6sg0u6yf6l0durxqqekytupxpf66zc7rc9cpav72ssqpcgv3p'
const PAYMENT_HASH = 'da9fa986cf48f56ad387495f8e840ea9ed10889bf82f67c8a7b10d5d8a27886c'
const INVOICE_TIMESTAMP = 1_734_606_755

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))
const CLIENT_REFUND_PUBKEY = key(20)

const REFUND_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(5),
  server: keyBytes(3),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 4096,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(9),
    receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
    senderPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(5)]),
  },
})
  .address('ark', keyBytes(3))
  .encode()

/** Below the service's minSats — triggers amount_out_of_range. */
const TINY_INVOICE = forgeInvoice({
  network: 'bc',
  amountSats: 50,
  paymentHash: sha256(new Uint8Array(32).fill(8)),
  timestamp: INVOICE_TIMESTAMP,
  expirySeconds: 86_400,
})

const arkade: ArkadeOps = {
  providerPubkey: key(1),
  serverPubkey: key(3),
  emulatorPubkey: key(9),
  receiverPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(1)])),
  delays: { unilateralClaimDelay: 4096, unilateralRefundDelay: 4608, unilateralRefundWithoutReceiverDelay: 5120 },
  hrp: 'ark',
  findLockups: async () => [],
  lockupProvablySpent: async () => false,
  claim: async () => 'claim-txid',
  refund: async () => 'refund-txid',
}

/**
 * The trader's own view of its Arkade stack, matching the service fixture —
 * which is exactly the situation of a real client: both sides independently
 * know the same server and emulator.
 *
 * This mirrors `deriveLockup` (examples/lib/swap-client.mjs) rather than
 * importing it directly: that file imports the BUILT `../../dist/index.js`,
 * which `tsc -p tsconfig.json` cannot resolve without a prior `pnpm build`
 * (vitest tolerates it only via `vitest.config.ts`'s own alias, which `tsc`
 * does not share) — importing it here would trade one drift risk for a
 * `pnpm typecheck` regression.
 *
 * So it is still a hand-kept copy, but it is no longer an UNCHECKED one:
 * "derives byte-identical lockups to the example client it mirrors" runs both
 * against the same inputs and requires the same two addresses in the same
 * order. That test loads `swap-client.mjs` through a specifier assembled at
 * runtime, which tsc does not resolve and vitest does — the copy exists
 * because of a static-import constraint that a dynamic one does not have.
 *
 * Returns BOTH candidate addresses, matching `deriveLockup`'s own contract
 * exactly: nothing on the wire says which shape the solver quoted (see
 * docs/rfq-protocol.md § 7.1.1.1), so `verifyLockupAddress` must be given
 * both and pick whichever the quote's own address matches.
 */
const traderDerivation = (quote: {
  solver_pubkey: string
  refund_locktime: number
  profile: Record<string, unknown>
}) => {
  const build = (nineLeaf: boolean) =>
    new CovenantSwapScript({
      receiver: hex.decode(quote.solver_pubkey),
      refundLocktime: quote.refund_locktime,
      server: keyBytes(3),
      preimageHash: scriptHashFromPaymentHash(PAYMENT_HASH),
      claimDelay: 4096,
      client: keyBytes(20),
      clientRefundDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: arkade.delays.unilateralRefundDelay,
      nonInteractiveParameters: {
        emulatorPubkey: keyBytes(9),
        // Compare-only, from the quote — see rfqQuotePayload's own doc comment
        // for why the trader cannot derive this itself.
        receiverPkScript: hex.decode(quote.profile.receiver_pk_script as string),
        // The trader's own wallet address, decoded the same way the solver
        // decodes the refund_address it was sent.
        senderPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
        ...(nineLeaf ? {} : { legacy: 'preTimelockedRefund' as const }),
      },
    })
      .address('ark', keyBytes(3))
      .encode()
  return [build(true), build(false)]
}

let clock: number
let store: SwapStore
let onchainStore: OnchainSendSwapStore
let app: ReturnType<typeof buildAppFrom>
let service: SendSwapService
let onchainService: OnchainSendSwapService

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  store = await SwapStore.open(':memory:', () => clock)
  service = new SendSwapService({
    store,
    ln: {
      routeCltvBudgetBlocks: ROUTE_CLTV_BUDGET_BLOCKS,
      enforcesRouteCltv: true,
      payInvoice: async () => ({ id: 'p', status: 'pending' as const }),
      getPayment: async () => ({ id: 'p', status: 'pending' as const }),
    },
    arkade,
    limits: { minSats: 500, maxSats: 10_000 },
    invoicePrefix: 'bc',
    maxExposedSats: 5_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    now: () => clock,
  })
  // Not exercised by this file's tests — real store + fake chain backend,
  // just enough to satisfy HttpDeps/RelayIngressDeps.
  onchainStore = await OnchainSendSwapStore.open(':memory:', () => clock)
  onchainService = new OnchainSendSwapService({
    store: onchainStore,
    onchain: new FakeOnchainBackend(),
    arkade,
    limits: { minSats: 500, maxSats: 10_000 },
    network: 'bitcoin',
    maxExposedSats: 5_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    signer: { sign: async (tx) => tx }, // never invoked — no test in this suite drives refunding_onchain
    refundDestinationScript: Uint8Array.from([0x51, 0x20, ...new Uint8Array(32).fill(1)]),
    now: () => clock,
  })
  app = buildAppFrom({ service, store, onchainService, onchainStore, network: 'bitcoin' })
})
afterEach(async () => {
  await store.close()
  await onchainStore.close()
})

/** The library's fetch, pointed at the in-process app — no socket, real code. */
const transport = () =>
  httpTransport('', { fetchImpl: (url, init) => app.request(url, init) as unknown as Promise<Response> })

/**
 * `rfq-core.d.mts` is HAND-WRITTEN — it is the only such file in the repo —
 * and nothing generated it from the implementation it describes.
 *
 * `checkJs` over `examples/` catches a declaration that disagrees about a
 * symbol the examples USE. It cannot see one that is simply absent, or one
 * declared for something that no longer exists: the examples import neither,
 * so nothing resolves against them. `expectQuote` sat missing here for as
 * long as the Nostr transport has needed it.
 *
 * Compared against the module's REAL runtime exports rather than a parse of
 * the implementation, so the check cannot drift with the regex that reads it.
 * Types are excluded on purpose — they have no runtime counterpart to compare.
 */
describe('rfq-core.d.mts', () => {
  it('declares exactly the values rfq-core.mjs exports', async () => {
    // Typed, despite being `.mjs`, BY THE VERY FILE UNDER TEST — which is why
    // the runtime keys and not the static type are what gets compared.
    const implementation = await import('../../examples/lib/rfq-core.mjs')
    const exported = Object.keys(implementation)
      .filter((name) => name !== 'default')
      .sort()

    const source = readFileSync(new URL('../../examples/lib/rfq-core.d.mts', import.meta.url), 'utf8')
    const declared = [...source.matchAll(/^export declare (?:const|class|function)\s+(\w+)/gm)]
      .map((match) => match[1] as string)
      .sort()

    // Neither list empty: a regex that stopped matching, or a module that
    // failed to load, would otherwise make this agree with itself about
    // nothing.
    expect(exported.length).toBeGreaterThan(0)
    expect(declared.length).toBeGreaterThan(0)
    expect(declared).toEqual(exported)
  })

  /**
   * `traderDerivation` above is a HAND-KEPT COPY of `deriveLockup`, and the
   * comment on it says so — "a real, known risk and not a hypothetical one".
   * This is that risk, measured instead of described.
   *
   * The copy exists because `swap-client.mjs` imports the app's BUILT
   * `dist/index.js`, which `tsc -p tsconfig.json` cannot resolve without a
   * prior `pnpm build`; a static import here would trade a drift risk for a
   * typecheck that only passes on a warm tree. The specifier is therefore
   * assembled at runtime — tsc does not resolve a non-literal one, and
   * `vitest.config.ts` already aliases that dist path to source, so the module
   * loads with no build.
   *
   * Both derivations are given the SAME inputs and must produce the SAME two
   * addresses, in the same order. Nothing about the copy is asserted
   * structurally: if it drifts in any way that moves an address — a parameter
   * renamed, a delay swapped, the legacy variant reordered — this fails, and
   * if it drifts in a way that does not, the copy is still correct.
   */
  it('derives byte-identical lockups to the example client it mirrors', async () => {
    const specifier = ['..', '..', 'examples', 'lib', 'swap-client.mjs'].join('/')
    const { deriveLockup } = (await import(specifier)) as {
      deriveLockup: (input: Record<string, unknown>) => { candidates: { address: string }[] }
    }

    const quote = {
      solver_pubkey: key(1),
      refund_locktime: 1_800_000_000,
      profile: { receiver_pk_script: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(1)])) },
    }

    const mine = deriveLockup({
      quote,
      // `deriveLockup` decodes a string and passes an object through; the
      // object form keeps this independent of bolt11 parsing.
      invoice: { paymentHash: PAYMENT_HASH },
      refundAddress: REFUND_ADDRESS,
      arkade: {
        wallet: { arkServerPublicKey: keyBytes(3) },
        unilateralDelays: {
          unilateralClaimDelay: 4096,
          unilateralRefundWithoutReceiverDelay: arkade.delays.unilateralRefundWithoutReceiverDelay,
          unilateralRefundDelay: arkade.delays.unilateralRefundDelay,
        },
        hrp: 'ark',
      },
      emulatorPubkey: key(9),
      clientRefundPubkey: key(20),
    })

    const theirs = mine.candidates.map((candidate) => candidate.address)
    // Two, not one: the current suite and the pre-timelocked-refund variant.
    // A single address would mean one derivation lost a shape and this
    // compared a shorter list to itself.
    expect(theirs).toHaveLength(2)
    expect(traderDerivation(quote)).toEqual(theirs)
  })
})

describe('rfq-core over HTTP against the real service', () => {
  it('runs the taker flow: quote → derive → verify → gates', async () => {
    const rfqId = newRfqId()
    const quote = await requestQuote(transport(), {
      invoice: INVOICE,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      rfqId,
    })
    expect(quote.rfq_id).toBe(rfqId)
    expect(quote.to_amount).toBe(2100)
    expect(quote.profile.payment_hash).toBe(PAYMENT_HASH)

    // The trader's own derivation matches the solver's address — the real
    // compare that gates funding. `derived` is both candidate shapes;
    // whichever one the solver actually quoted is the one that must match.
    const derived = traderDerivation(quote)
    expect(verifyLockupAddress(quote, derived)).toBe(quote.profile.lockup_address)

    // Gates pass with a fresh quote and a live invoice.
    assertFundable({ quote, invoiceExpiresAt: INVOICE_TIMESTAMP + 86_400, now: clock })
  })

  it('throws AddressMismatch on a tampered lockup address — the refuse-to-fund guardrail', async () => {
    const quote = await requestQuote(transport(), {
      invoice: INVOICE,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    const tampered = { ...quote, profile: { ...quote.profile, lockup_address: 'ark1qtampered' } }
    expect(() => verifyLockupAddress(tampered, traderDerivation(quote))).toThrow(AddressMismatch)
  })

  it('surfaces refusals as SwapRefusal with the closed reason', async () => {
    await expect(
      requestQuote(transport(), {
        invoice: TINY_INVOICE,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      }),
    ).rejects.toThrow(SwapRefusal)
    await expect(
      requestQuote(transport(), {
        invoice: TINY_INVOICE,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      }),
    ).rejects.toMatchObject({ reason: 'amount_out_of_range' })
  })

  it('refuses to fund past valid_until or under the headroom gate', async () => {
    const quote = await requestQuote(transport(), {
      invoice: INVOICE,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
    })
    expect(() =>
      assertFundable({ quote, invoiceExpiresAt: INVOICE_TIMESTAMP + 86_400, now: quote.valid_until }),
    ).toThrow(/quote expired/)
    // Headroom in isolation needs a synthetic deadline: a genuine quote's
    // valid_until always trips first, since refund_locktime sits days out.
    const shortDeadline = { ...quote, refund_locktime: clock + 60 * 60 }
    expect(() =>
      assertFundable({ quote: shortDeadline, invoiceExpiresAt: INVOICE_TIMESTAMP + 86_400, now: clock }),
    ).toThrow(/headroom/)
  })

  it('polls status through to settled and reads the preimage receipt', async () => {
    const rfqId = newRfqId()
    await requestQuote(transport(), {
      invoice: INVOICE,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      rfqId,
    })
    const row = (await store.findByPaymentHash(PAYMENT_HASH))!
    await store.transition(row.id, 'quoted', 'funded', { lockup_value: 2100 })
    await store.transition(row.id, 'funded', 'paying', { idempotency_key: 'k' })
    await store.transition(row.id, 'paying', 'paid', { payment_id: 'p' })
    await store.transition(row.id, 'paid', 'claiming', { preimage: 'aa'.repeat(32) })
    await store.transition(row.id, 'claiming', 'claimed', { claim_ark_txid: 'c' })

    const status = await pollStatus(transport(), rfqId, { pollMs: 1, maxAttempts: 3 })
    expect(status?.state).toBe('settled')
    expect(status?.profile.preimage).toBe('aa'.repeat(32))
  })
})

describe('rfq-core over the relay against the real ingress', () => {
  const PORT = 7462
  const closers: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (closers.length) await closers.pop()!()
  })

  /** The mock-relay broker, embedded (same frames as scripts/mock-relay.mjs). */
  const startBroker = (): WebSocketServer => {
    const server = new WebSocketServer({ port: PORT })
    const subscribers = new Map<import('ws').WebSocket, Map<string, { recipient?: string }>>()
    server.on('connection', (socket) => {
      subscribers.set(socket, new Map())
      socket.on('close', () => subscribers.delete(socket))
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as {
          op: string
          id?: string
          filter?: { recipient?: string }
          event?: RelayEvent
        }
        if (frame.op === 'sub' && frame.id) subscribers.get(socket)?.set(frame.id, frame.filter ?? {})
        if (frame.op === 'unsub' && frame.id) subscribers.get(socket)?.delete(frame.id)
        if (frame.op === 'event' && frame.event) {
          for (const [peer, subs] of subscribers) {
            for (const filter of subs.values()) {
              if (matchesFilter(frame.event, filter)) {
                peer.send(JSON.stringify({ op: 'event', event: frame.event }))
                break
              }
            }
          }
        }
      })
    })
    closers.push(async () => new Promise((resolve) => server.close(() => resolve())))
    return server
  }

  it('round-trips quote and status through a real broker to the real ingress', async () => {
    startBroker()
    const connection = webSocketRelayConnection(`ws://127.0.0.1:${PORT}`, {
      WebSocketCtor: WsClient as unknown as typeof WebSocket,
    })
    const ingress = relayIngressFrom({
      connection,
      service,
      store,
      onchainService,
      onchainStore,
      providerPubkey: key(1),
      now: () => clock * 1000,
    })
    await ingress.start()
    closers.push(() => ingress.stop())

    const trader = relayTransport(`ws://127.0.0.1:${PORT}`, {
      solverPubkey: key(1),
      clientPubkey: key(7),
      WebSocketCtor: WsClient as unknown as new (url: string) => WebSocket,
      timeoutMs: 5000,
    })
    closers.push(() => trader.close())

    const rfqId = newRfqId()
    const quote = await requestQuote(trader, {
      invoice: INVOICE,
      refundAddress: REFUND_ADDRESS,
      clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      rfqId,
    })
    expect(quote.rfq_id).toBe(rfqId)
    expect(verifyLockupAddress(quote, traderDerivation(quote))).toBeDefined()

    const status = await trader.status(rfqId)
    expect(status?.state).toBe('quoted')

    // A refusal travels the same path and lands as a typed error.
    await expect(
      requestQuote(trader, {
        invoice: TINY_INVOICE,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      }),
    ).rejects.toMatchObject({
      reason: 'amount_out_of_range',
    })
  })
})
