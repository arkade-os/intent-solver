/**
 * The REAL second Lightning node, driven from the test.
 *
 * arkade-regtest runs TWO LND nodes with a live, balanced channel between
 * them, and the channel exists for exactly this purpose:
 *
 *   boltz-lnd  alias "Ark Labs"             — the SOLVER's own backend
 *                                             (`LND_SOCKET`, `.env.regtest.lnd`)
 *   lnd        alias "arkade-counterparty"  — free, and named for the job
 *
 * That second node is what lets both Lightning legs run against real Lightning
 * instead of a fake:
 *
 *   receive (`lightning:BTC->arkade:BTC`)  the counterparty is the PAYER of the
 *                                          solver's hold invoice
 *   send    (`arkade:BTC->lightning:BTC`)  the counterparty is the ISSUER of the
 *                                          invoice the solver pays
 *
 * Neither role is expressible through {@link LightningBackend} — that port is
 * the SOLVER's view of ITS OWN node, and nothing in it can pay someone else's
 * invoice or issue one on a node we do not operate. So this module drives the
 * counterparty out of band, the same way `support/chain.ts` drives the miner:
 * by shelling out.
 *
 * WHY `docker exec lncli` AND NOT gRPC. `chain.ts` already establishes
 * shelling out to the stack as this suite's way of reaching something that is
 * not the service under test, and `lncli` needs no credentials plumbed into
 * the repo — the counterparty's macaroon and TLS cert live inside its
 * container and never have to be extracted, copied, or added to an env file.
 * A gRPC client would mean a second set of secrets in `.env.regtest.lnd` for a
 * node that is deliberately NOT the one the service talks to.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: any way to make the solver's node do
 * something. Everything the solver does goes through the real
 * `LndLightningBackendAdapter` (see `openSolverLightning` in `stack.ts`), so
 * the code under test is the shipped adapter. The one exception is
 * {@link solverInvoice}, which READS the solver's node directly — never writes
 * — because the shipped adapter drops fields a test needs to assert on. It is
 * documented at its own definition.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * How long one `lncli` round trip may take. Generous for a local container
 * exec, and far below any scenario's own budget so an unreachable node fails
 * with THIS error rather than as a mystery timeout in the caller's poll.
 */
const LNCLI_TIMEOUT_MS = 30_000

/** The counterparty container: the node the SERVICE DOES NOT USE. */
export const COUNTERPARTY_CONTAINER = process.env.E2E_LN_COUNTERPARTY_CONTAINER ?? 'lnd'

/** The solver's own container, for reads the shipped adapter cannot express. */
export const SOLVER_CONTAINER = process.env.E2E_LN_SOLVER_CONTAINER ?? 'boltz-lnd'

const dockerArgs = (container: string, args: readonly string[]): string[] => [
  'exec',
  container,
  'lncli',
  '--network=regtest',
  ...args,
]

/**
 * Run one `lncli` command in `container` and parse its JSON.
 *
 * Failures name the container and the command, because the two ways this goes
 * wrong — docker not on PATH, or the container not running — are
 * indistinguishable from the caller's side and both look like "the Lightning
 * leg hung" without it.
 */
export const lncli = async <T>(container: string, args: readonly string[]): Promise<T> => {
  let stdout: string
  try {
    ;({ stdout } = await run('docker', dockerArgs(container, args), { timeout: LNCLI_TIMEOUT_MS }))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        `lncli ${args.join(' ')} failed in container ${container}.`,
        detail,
        '',
        "The e2e Lightning legs drive arkade-regtest's SECOND LND node as the real counterparty.",
        `Check it is up:  docker exec ${container} lncli --network=regtest getinfo`,
        'Override the container name with E2E_LN_COUNTERPARTY_CONTAINER / E2E_LN_SOLVER_CONTAINER.',
      ].join('\n'),
    )
  }
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new Error(`lncli ${args.join(' ')} in ${container} returned non-JSON output: ${stdout.slice(0, 400)}`)
  }
}

// -- invoices the counterparty ISSUES (the send leg's payee) --

export interface CounterpartyInvoice {
  /** The BOLT11 string, for the solver to pay. */
  invoice: string
  /** `sha256(P)`, hex. */
  paymentHash: string
}

interface AddInvoiceResponse {
  r_hash: string
  payment_request: string
}

/**
 * How long an issued invoice stays payable, seconds.
 *
 * Two hours, matching `FakeLightningBackend.forgeInvoice`'s own default. No
 * quoting floor forces it any more: the only expiry a quote is now refused for
 * is an invoice with no fundable window left at all (`lockupDeadlineFor`,
 * `src/core/send.ts`), so LND's own 3600s `addinvoice` default — and anything
 * down to a couple of minutes — is served. Two successive floors used to demand
 * otherwise: `DEFAULT_LOCKUP_TIMEOUT + MIN_INVOICE_WINDOW` (1020s), and before
 * it `MIN_INVOICE_WINDOW + MIN_CLAIM_WINDOW` (5520s), which an ordinary payee
 * invoice did NOT clear — the quote came back `invoice_expires_too_soon`. Kept
 * at two hours so the fixture exercises the whole funding window rather than one
 * clipped to the invoice.
 */
const DEFAULT_INVOICE_EXPIRY = 7200

/**
 * Issue an ordinary invoice on the counterparty.
 *
 * The counterparty picks `P` and keeps it, exactly as a real payee does — which
 * is the whole point on the send leg: the solver LEARNS the preimage by paying,
 * rather than being handed it by a fake that forged both sides.
 */
export const counterpartyInvoice = async (
  amountSats: number,
  expirySeconds = DEFAULT_INVOICE_EXPIRY,
): Promise<CounterpartyInvoice> => {
  const added = await lncli<AddInvoiceResponse>(COUNTERPARTY_CONTAINER, [
    'addinvoice',
    '--amt',
    String(amountSats),
    '--expiry',
    String(expirySeconds),
  ])
  return { invoice: added.payment_request, paymentHash: added.r_hash }
}

/**
 * Cancel an invoice the counterparty issued.
 *
 * This is how the send leg's failure path is provoked with a REAL terminal
 * failure. A payment to a canceled invoice is rejected by the destination
 * itself — LND reports `FAILURE_REASON_INCORRECT_PAYMENT_DETAILS`, which the
 * `lightning` package surfaces as `PaymentRejectedByDestination`, one of the
 * six reasons `FAILED_PAYMENT_REASONS` (`src/ln/lnd/adapter.ts`) treats as
 * "the sats provably did not leave".
 *
 * Chosen over the two other ways to make a payment fail:
 *
 *  - AN AMOUNT ABOVE CHANNEL CAPACITY also fails terminally, but the swap
 *    amount is derived from the invoice, so the CLIENT would have to fund an
 *    Arkade lockup of that size for the test to reach the payment at all —
 *    hundreds of thousands of sats of real wallet balance to prove a refusal.
 *  - A HOLD INVOICE THE COUNTERPARTY NEVER SETTLES does not fail at all: the
 *    payment sits IN_FLIGHT, which the adapter correctly maps to `pending`, so
 *    the solver polls forever and the refund path never runs. It tests the
 *    opposite of what is wanted here.
 */
export const cancelCounterpartyInvoice = async (paymentHash: string): Promise<void> => {
  await lncli(COUNTERPARTY_CONTAINER, ['cancelinvoice', paymentHash])
}

/** LND's own view of an invoice, as `lookupinvoice` reports it. */
export interface LndInvoiceView {
  state: 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED'
  settled: boolean
  /** `P`, hex — empty until settled. */
  r_preimage: string
  amt_paid_sat: string
  /** BOLT11 validity window, seconds. NOT the held HTLC's deadline. */
  expiry: string
  creation_date: string
  htlcs: {
    state: 'ACCEPTED' | 'SETTLED' | 'CANCELED'
    /** The block height at which this held HTLC times out. THIS is `E`. */
    expiry_height: number
    accept_height: number
    amt_msat: string
  }[]
}

/** Read back an invoice the counterparty issued — how the send leg proves it got paid. */
export const counterpartyInvoiceState = (paymentHash: string): Promise<LndInvoiceView> =>
  lncli<LndInvoiceView>(COUNTERPARTY_CONTAINER, ['lookupinvoice', paymentHash])

// -- payments the counterparty MAKES (the receive leg's payer) --

/** A payment started on the counterparty and left running. */
export interface CounterpartyPayment {
  /** Stop following the payment. Does NOT abort it — LND owns it now. */
  stop(): void
}

/**
 * Start paying `invoice` FROM the counterparty, and return immediately.
 *
 * NOT awaited, and that is the entire point on the receive leg: the solver
 * issues a HOLD invoice, so `payinvoice` blocks for as long as the HTLC is
 * held — which is the whole swap. Awaiting it would deadlock every receive
 * test against the very behaviour those tests exist to prove.
 *
 * The payment survives the child process either way: `payinvoice` drives
 * SendPaymentV2, which LND persists and continues on its own, so killing the
 * CLI stops the progress stream and nothing else. Callers therefore observe
 * the outcome through {@link counterpartyPayment}, reading LND's payment
 * database rather than this process's stdout.
 */
export const payFromCounterparty = (invoice: string, timeoutSeconds = 600): CounterpartyPayment => {
  const child: ChildProcess = spawn(
    'docker',
    dockerArgs(COUNTERPARTY_CONTAINER, ['payinvoice', '--force', '--timeout', `${timeoutSeconds}s`, invoice]),
    { stdio: 'ignore', detached: false },
  )
  // A test that finishes while the HTLC is still held must not keep vitest's
  // fork alive waiting on this child.
  child.unref()
  // Nothing reads the child's outcome, so an error event with no listener
  // would be an unhandled 'error' and take the whole fork down.
  child.on('error', () => {})
  return {
    stop: () => {
      if (!child.killed) child.kill()
    },
  }
}

/** One row of the counterparty's payment database. */
export interface CounterpartyPaymentView {
  payment_hash: string
  status: 'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'INITIATED'
  /** `P`, hex — all zeroes until the payment succeeds. */
  payment_preimage: string
  failure_reason: string
  value_sat: string
}

/**
 * How many of the counterparty's most recent payments to search.
 *
 * `listpayments` returns newest-first, and every payment a test cares about was
 * started by that same test moments earlier, so a small window is enough. It is
 * bounded rather than unbounded because this regtest node accumulates payments
 * across every run that has ever used it.
 */
const PAYMENT_SEARCH_WINDOW = 200

/**
 * What the counterparty's own node says about a payment it made, or null if it
 * has no record of one.
 *
 * This is the receive leg's proof of payment, and it is the assertion no fake
 * can make: a fake can only report what the test told it. `SUCCEEDED` here
 * means a real HTLC was settled with a real preimage across a real channel and
 * the sats moved to the solver.
 */
export const counterpartyPayment = async (paymentHash: string): Promise<CounterpartyPaymentView | null> => {
  const listed = await lncli<{ payments: CounterpartyPaymentView[] }>(COUNTERPARTY_CONTAINER, [
    'listpayments',
    '--include_incomplete',
    '--max_payments',
    String(PAYMENT_SEARCH_WINDOW),
  ])
  return listed.payments.find((payment) => payment.payment_hash === paymentHash) ?? null
}

// -- reads against the SOLVER's node --

/**
 * Read the solver's own node for an invoice IT issued.
 *
 * The service never goes through here; it uses the shipped
 * `LndLightningBackendAdapter`. This exists because that adapter's
 * {@link HoldState} deliberately narrows LND's response to three fields, and
 * two things a receive test must assert on are not among them:
 *
 *  - `htlcs[].state === 'ACCEPTED'` — that the HTLC is genuinely HELD and not
 *    settled. `HoldStatus` says `armed`, but only the raw HTLC record proves
 *    the sats are still hanging in the channel rather than already collected.
 *  - `htlcs[].expiry_height` — the block height at which a held HTLC is failed
 *    back. That IS the `E` the port documents, and the adapter does not return
 *    it (see `holdSettleDeadline` in `stack.ts`).
 */
export const solverInvoice = (paymentHash: string): Promise<LndInvoiceView> =>
  lncli<LndInvoiceView>(SOLVER_CONTAINER, ['lookupinvoice', paymentHash])

/**
 * Mint an ORDINARY invoice on the solver's own node — the issue-#41 repro.
 *
 * A write to the solver's node, which this module's header otherwise
 * forbids: everything the service does must go through the shipped adapter.
 * This is the same exception `cancelSolverHold` already is — the harness
 * standing in for an outside actor (an operator running `lncli addinvoice`,
 * or party B's receive swap minting a hold on the same node), never for the
 * service under test. What the service then DOES about the invoice is
 * entirely the shipped code's business.
 */
export const solverMintedInvoice = async (
  amountSats: number,
  expirySeconds = DEFAULT_INVOICE_EXPIRY,
): Promise<CounterpartyInvoice> => {
  const added = await lncli<AddInvoiceResponse>(SOLVER_CONTAINER, [
    'addinvoice',
    '--amt',
    String(amountSats),
    '--expiry',
    String(expirySeconds),
  ])
  return { invoice: added.payment_request, paymentHash: added.r_hash }
}

/**
 * Cancel a hold invoice on the solver's node, failing its held HTLC back to
 * the payer NOW.
 *
 * The harness standing in for the network, not for the service. A held HTLC is
 * failed back when its CLTV expires — `expiry_height`, some eighty blocks out
 * on this stack, which no test can wait for and which mining to would take the
 * chain past deadlines every other scenario depends on. Cancelling produces
 * the same observable outcome for both parties (the payer's payment FAILS, the
 * solver collects nothing) in a second.
 *
 * Note this is deliberately NOT reachable through {@link ReceiveBackend}: the
 * port has no `cancelHold`, and `src/ln/port.ts` explains at length why the
 * SERVICE must never assume it can abort a hold. That reasoning is about the
 * service's own flows; a test simulating the network is a different caller.
 */
export const cancelSolverHold = async (paymentHash: string): Promise<void> => {
  await lncli(SOLVER_CONTAINER, ['cancelinvoice', paymentHash])
}

/** Chain height as a Lightning node sees it — for turning a CLTV height into a deadline. */
export const nodeBlockHeight = async (container: string): Promise<number> => {
  const info = await lncli<{ block_height: number }>(container, ['getinfo'])
  return info.block_height
}
