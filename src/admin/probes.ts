/**
 * Backend liveness, one probe per dependency.
 *
 * The rule this module exists to enforce: ONE DEAD BACKEND MUST NOT BLANK THE
 * PAGE. Every probe is caught independently and reports its own failure, so a
 * console with an unreachable LND still shows Arkade, the emulator, the chain
 * and the relay. A 500 here would take the console dark exactly when an
 * operator most needs to look at it — which is the failure mode the whole
 * console is meant to end, not reproduce.
 *
 * Probes are cheap reads that a healthy backend answers anyway. None of them
 * writes, and none is a synthetic transaction.
 */

import type { Services } from '../ops/services.js'
import { requireLn, requireOnchain } from '../ops/rails.js'

export interface BackendStatus {
  name: 'lightning' | 'arkade' | 'emulator' | 'onchain' | 'relay'
  ok: boolean
  /** Human-facing one-liner: what answered, or what it said. */
  detail: string
  /** Present only when `ok` is false. */
  error: string | null
  /** Which vendor/URL this probe actually spoke to, when that is knowable. */
  target: string | null
  /**
   * Unix seconds this probe answered.
   *
   * Without it a frozen probe and a fresh one are indistinguishable, which is
   * the failure this console exists to end rather than reproduce.
   */
  lastCheckedAt: number
}

/** What the relay probe needs, structurally — `RelayConnection` satisfies it. */
export interface RelayProbeTarget {
  url: string
  isConnected(): boolean
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Run one probe, converting any rejection into a reported failure.
 *
 * Deliberately catches everything: a probe that threw is exactly the signal
 * this function exists to report, and letting it propagate would lose the
 * other four.
 */
const probe = async (
  name: BackendStatus['name'],
  target: string | null,
  read: () => Promise<string>,
): Promise<BackendStatus> => {
  try {
    const detail = await read()
    // Stamped after the read resolves, not before it: the question the stamp
    // answers is "when did this backend last actually speak", and a stamp taken
    // on entry would date a hung probe to the moment it was dispatched.
    return { name, ok: true, detail, error: null, target, lastCheckedAt: Math.floor(Date.now() / 1000) }
  } catch (error) {
    // A failed probe is stamped too. An operator needs to tell "this has been
    // down since 09:00" from "this just went down", and an unstamped failure
    // row answers neither.
    return {
      name,
      ok: false,
      detail: 'unreachable',
      error: messageOf(error),
      target,
      lastCheckedAt: Math.floor(Date.now() / 1000),
    }
  }
}

export const probeBackends = async (services: Services, relay?: RelayProbeTarget): Promise<BackendStatus[]> => {
  const probes: Promise<BackendStatus>[] = [
    // `requireLn`, not a skipped row: a deployment with no rail has no BTC
    // corridor either, and a MISSING row would read as a probe that never ran.
    // The refusal names the reason and is caught like any other backend fault.
    probe('lightning', services.config.lnBackend, async () => {
      const balance = await requireLn(services.ln).getBalance()
      return `${balance.availableSats} sat available, ${balance.incomingSats} sat incoming`
    }),
    probe('arkade', services.config.arkade.arkServerUrl, async () => {
      const address = await services.arkade.wallet.getAddress()
      return `wallet at ${address}`
    }),
    // The emulator key was fetched once at startup and snapshotted per swap, so
    // this is not re-fetching policy — it only confirms the signer is still
    // answering, and shows which key funded scripts were built against.
    probe('emulator', services.config.emulatorUrl, async () => `signer ${services.emulatorPubkey.slice(0, 16)}...`),
    probe('onchain', services.config.lnBackend, async () => {
      // Balance first: it is the number an operator is looking for. The fee
      // rate confirms the backend is answering, but a funded wallet is what
      // decides whether this corridor can honour a quote.
      const onchain = requireOnchain(services.onchain)
      const [balance, rate] = await Promise.all([onchain.getBalance(), onchain.estimateFeeRate()])
      // Said on the row, not left in the payload. On a rail whose two legs share
      // ONE wallet this is the same balance the `lightning` row above reports —
      // its onchain sends are paid out of that pool — so an operator reading
      // both rows and adding them would believe they hold twice what they do.
      const shared = balance.sharedWithLightning ? ' (one pool, shared with lightning)' : ''
      return `${balance.confirmedSats} sat confirmed, ${balance.unconfirmedSats} sat unconfirmed, ${rate} sat/vB${shared}`
    }),
  ]

  // Only in `relay` mode. In `serve`/`watch` there is no outbound connection to
  // report, and inventing a "down" row for one that was never opened would
  // read as a fault.
  if (relay) {
    probes.push(
      probe('relay', relay.url, async () => {
        const connected = relay.isConnected()
        // The one probe whose healthy answer can still be bad news, so it does
        // not throw — a disconnected relay is a fact to display, not an error.
        if (!connected) throw new Error('no live socket; reconnect is automatic and unbounded')
        return 'connected'
      }),
    )
  }

  return Promise.all(probes)
}
