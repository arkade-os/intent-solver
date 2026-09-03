/**
 * The confirmation gate, asserted at the API rather than through the UI.
 *
 * The point of these tests is that the friction survives a caller who never
 * opens the browser: every armed action is exercised by a bare `fetch`, which
 * is exactly how an operator scripting around the console at 3am would reach
 * it.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'

const adminStore = () => ({
  recordAction: vi.fn().mockResolvedValue(undefined),
  listActions: vi.fn().mockResolvedValue([]),
  getOverrides: vi.fn().mockResolvedValue({}),
})

/** Kept loosely typed rather than cast to `never`, so tests can read back the spies. */
const fakeServices = (over: Record<string, unknown> = {}) => ({
  adminStore: adminStore(),
  store: { get: vi.fn(), patch: vi.fn() },
  onchainStore: { get: vi.fn().mockResolvedValue({ id: 'swap-1' }) },
  arkade: { wallet: {} },
  config: {},
  ...over,
})

const app = (services: ReturnType<typeof fakeServices> = fakeServices()) =>
  buildAdminApp({ services: services as never, startedAt: 1_000_000, mode: 'relay' })

const post = (name: string, body: unknown, services: ReturnType<typeof fakeServices> = fakeServices()) =>
  app(services).fetch(
    new Request(`http://admin/api/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const ARMED = Object.entries(ACTIONS)
  .filter(([, definition]) => definition.tier === 'armed')
  .map(([name]) => name)

describe('the action registry', () => {
  it('marks every money-moving action as armed', () => {
    for (const name of ['refund-now', 'onchain-refund-now', 'reclaim-l1-htlc', 'pool-mint']) {
      expect(ACTIONS[name]?.tier, name).toBe('armed')
    }
  })

  it('gives every armed action a warning explaining the real danger', () => {
    for (const name of ARMED) expect(ACTIONS[name]?.warning, name).toBeTruthy()
  })

  it('says out loud that onchain-refund-now can double-pay', () => {
    expect(ACTIONS['onchain-refund-now']?.warning).toMatch(/DOUBLE-PAYOUT/i)
  })

  it('keeps read-only actions unarmed, so an operator is not trained to click through warnings', () => {
    expect(ACTIONS['pool-plan']?.tier).toBe('safe')
    expect(ACTIONS['tick']?.tier).toBe('safe')
  })
})

describe('the confirmation gate', () => {
  it('refuses EVERY armed action when confirm does not match', async () => {
    for (const name of ARMED) {
      const response = await post(name, { id: 'swap-1', confirm: 'wrong' })
      expect(response.status, name).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'confirm_required' })
    }
  })

  it('refuses an armed action with no confirm at all', async () => {
    for (const name of ARMED) {
      expect((await post(name, { id: 'swap-1' })).status, name).toBe(400)
    }
  })

  it('refuses an armed action with no body whatsoever', async () => {
    const response = await app().fetch(new Request('http://admin/api/actions/refund-now', { method: 'POST' }))
    expect(response.status).toBe(400)
  })

  it('does NOT run the action or audit it when the confirmation fails', async () => {
    const services = fakeServices()
    const store = { get: vi.fn(), patch: vi.fn() }
    await post(
      'refund-now',
      { id: 'swap-1', confirm: 'nope' },
      fakeServices({ store, adminStore: services.adminStore }),
    )
    expect(store.get).not.toHaveBeenCalled()
    // No attempt was made, so an audit row would record something that never happened.
    expect(services.adminStore.recordAction).not.toHaveBeenCalled()
  })

  it('requires the literal MINT for pool-mint, not a swap id and not lowercase', async () => {
    expect((await post('pool-mint', { confirm: 'mint' })).status).toBe(400)
    expect((await post('pool-mint', { confirm: 'swap-1' })).status).toBe(400)
  })

  it('returns the warning alongside the refusal so the UI need not hardcode it', async () => {
    const body = await (await post('onchain-refund-now', { id: 'swap-1', confirm: 'x' })).json()
    expect(body).toMatchObject({ error: 'confirm_required' })
    expect((body as { warning: string }).warning).toMatch(/DOUBLE-PAYOUT/i)
  })
})

describe('auditing', () => {
  it('records a SUCCESSFUL action', async () => {
    const services = fakeServices({
      arkade: { wallet: {} },
      store: { get: vi.fn(), patch: vi.fn() },
      service: { tick: vi.fn().mockResolvedValue({ id: 'swap-1', state: 'claimed' }) },
    })
    const response = await post('tick', { id: 'swap-1', corridor: 'arkade:BTC->lightning:BTC' }, services)
    expect(response.status).toBe(200)
    expect(services.adminStore.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tick', target: 'swap-1', outcome: 'ok' }),
    )
  })

  it('records a FAILED action — the one an operator most needs a record of', async () => {
    const services = fakeServices({
      service: { tick: vi.fn().mockRejectedValue(new Error('indexer unreachable')) },
    })
    const response = await post('tick', { id: 'swap-1', corridor: 'arkade:BTC->lightning:BTC' }, services)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, message: 'indexer unreachable' })
    expect(services.adminStore.recordAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tick', outcome: 'error', detail: 'indexer unreachable' }),
    )
  })

  it('never records the confirmation ceremony in the audit params', async () => {
    const services = fakeServices({ service: { tick: vi.fn().mockResolvedValue({}) } })
    await post('tick', { id: 'swap-1' }, services)
    const call = services.adminStore.recordAction.mock.calls[0]![0] as { params: string }
    expect(call.params).not.toContain('confirm')
  })
})

describe('GET /api/audit', () => {
  const auditGet = (query: string, services = fakeServices()) =>
    app(services).fetch(new Request(`http://admin/api/audit${query}`))

  it('caps an absurd limit rather than handing SQLite a million-row request', async () => {
    const services = fakeServices()
    await auditGet('?limit=999999', services)
    expect(services.adminStore.listActions).toHaveBeenCalledWith(500)
  })

  it('rejects a non-numeric limit instead of silently returning nothing', async () => {
    // Number('abc') is NaN, and better-sqlite3 coerces LIMIT NaN to zero — so
    // an unvalidated typo would return an EMPTY audit log, and an operator
    // seeing no entries would conclude no actions had been taken.
    const response = await auditGet('?limit=abc')
    expect(response.status).toBe(400)
  })

  it('rejects a zero or negative limit', async () => {
    expect((await auditGet('?limit=0')).status).toBe(400)
    expect((await auditGet('?limit=-5')).status).toBe(400)
  })

  it('passes undefined through when no limit is given, letting the store default', async () => {
    const services = fakeServices()
    await auditGet('', services)
    expect(services.adminStore.listActions).toHaveBeenCalledWith(undefined)
  })
})

describe('unknown actions', () => {
  it('404s something that is not in the registry', async () => {
    expect((await post('rm-rf', {})).status).toBe(404)
  })

  it('does not audit an unknown action', async () => {
    const services = fakeServices()
    await post('rm-rf', {}, services)
    expect(services.adminStore.recordAction).not.toHaveBeenCalled()
  })
})

describe('GET /api/actions', () => {
  it('advertises tiers and warnings so the UI does not hardcode them', async () => {
    const response = await app().fetch(new Request('http://admin/api/actions'))
    const body = (await response.json()) as { actions: { name: string; tier: string; confirmKind: string | null }[] }
    expect(body.actions.find((a) => a.name === 'pool-mint')).toMatchObject({
      tier: 'armed',
      confirmKind: 'literal:MINT',
    })
    expect(body.actions.find((a) => a.name === 'refund-now')?.confirmKind).toBe('swap-id')
    expect(body.actions.find((a) => a.name === 'pool-plan')?.confirmKind).toBeNull()
  })
})

describe('tick across corridors', () => {
  it('drives the corridor it was told, not whichever store answers first', async () => {
    // A swap id is unique within its OWN corridor's store. Trying each in turn
    // would tick the wrong swap on a collision — a money path, one step, on a
    // row nobody asked about.
    const receiveTick = vi.fn().mockResolvedValue({ id: 'swap-1', state: 'settled' })
    const sendTick = vi.fn()
    const services = fakeServices({
      service: { tick: sendTick },
      receiveService: { tick: receiveTick },
    })
    const response = await post('tick', { id: 'swap-1', corridor: 'lightning:BTC->arkade:BTC' }, services)
    expect(response.status).toBe(200)
    expect(receiveTick).toHaveBeenCalledWith('swap-1')
    expect(sendTick).not.toHaveBeenCalled()
  })

  it('says the corridor is disabled rather than crashing', async () => {
    // Every corridor is optional by design, so absent is a normal answer.
    const response = await post('tick', { id: 'swap-1', corridor: 'onchain:BTC->arkade:BTC' }, fakeServices({}))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('not enabled') })
  })

  it('refuses a request that names no corridor', async () => {
    const response = await post('tick', { id: 'swap-1' }, fakeServices({}))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('corridor is required') })
  })
})

/**
 * `confirmKind` is stated per action, never derived from its name.
 *
 * It used to be `name === 'pool-mint' ? 'literal:MINT' : 'swap-id'` in the
 * listing route, so a new armed action that was not swap-scoped inherited
 * `swap-id` — the UI then prompted for an identifier that does not exist, which
 * an operator cannot satisfy, making the action unusable through the console
 * while looking well-formed in the registry.
 *
 * The type now refuses an armed action without one; these pin that the values
 * are the right ones and that the wallet-level actions do not ask for a swap id.
 */
describe('confirmKind is declared, not inferred', () => {
  const armedEntries = Object.entries(ACTIONS).filter(([, d]) => d.tier === 'armed')

  it('is present on every armed action', () => {
    expect(armedEntries.length).toBeGreaterThan(0)
    for (const [name, definition] of armedEntries) {
      expect(definition.tier === 'armed' && definition.confirmKind, name).toBeTruthy()
    }
  })

  /**
   * Anchored on what the SERVER compares, not on whether a `target` exists.
   *
   * `target` is "what this action acted on, for the audit row", which is not the
   * same claim as "scoped to one swap" — `fund-withdraw` targets a destination
   * ADDRESS and is scoped to no swap at all. Reading `target !== undefined` as
   * swap-scoping was an accident of every targeted action having been swap-shaped
   * until then, and it would have forced a wallet-level action to either prompt
   * for a swap id it has none of or drop itself out of the audit log.
   *
   * Strictly stronger than that reading for the case it was written for: the
   * regression was a new armed action inheriting `swap-id` and prompting for an
   * identifier the operator cannot supply, and such an action's
   * `expectedConfirm` does not read `body.id`, so it still fails here.
   */
  it('asks for a swap id only where the confirmation IS the swap id', () => {
    for (const [name, definition] of armedEntries) {
      if (definition.tier !== 'armed') continue
      const readsTheId = definition.expectedConfirm({ id: 'swap-1' }) === 'swap-1'
      expect(definition.confirmKind === 'swap-id', `${name} readsTheId=${readsTheId}`).toBe(readsTheId)
    }
  })

  it.each([
    ['pool-mint', 'literal:MINT'],
    ['float-lifecycle', 'literal:FLOAT'],
  ])('%s asks for the literal %s', (name, expected) => {
    const definition = ACTIONS[name]
    expect(definition?.tier).toBe('armed')
    expect(definition?.tier === 'armed' && definition.confirmKind).toBe(expected)
  })

  it('agrees with what the server will actually check', () => {
    // The two must not drift: `confirmKind` is what the UI asks for and
    // `expectedConfirm` is what the route compares against. A literal prompt
    // whose word differs from the expected string is a dialog nobody can pass.
    for (const [name, definition] of armedEntries) {
      if (definition.tier !== 'armed') continue
      const kind = definition.confirmKind
      if (!kind.startsWith('literal:')) continue
      expect(definition.expectedConfirm({}), name).toBe(kind.slice('literal:'.length))
    }
  })
})

/**
 * The receive legs' operator refund — TLA+ findings F4 and F5 (#38) both need
 * a way to act on a row that has stopped moving, and until these existed there
 * was none: `stuck` is terminal, excluded from every sweep, and no action
 * touched either receive store.
 *
 * The direction is the thing these pin. `refund-now` and `onchain-refund-now`
 * return the CLIENT's lockup on the two SEND corridors and can pay twice; the
 * receive corridors fund out of the solver's own float, so these recover OUR
 * sats. A future edit that got that backwards would be a double payout wearing
 * a safe-sounding name.
 */
describe('the receive legs’ operator refund', () => {
  for (const name of ['receive-refund-now', 'onchain-receive-refund-now']) {
    it(`${name} is armed and confirms on a swap id`, () => {
      // Armed not because it can double-pay — it cannot — but because it can
      // kill a live swap by spending the output the client was about to claim.
      const action = ACTIONS[name]
      expect(action?.tier).toBe('armed')
      // Narrowed rather than asserted through `?.`: `confirmKind` only exists
      // on the armed arm of the union, so reaching for it unconditionally
      // would not compile — and would hide a safe-tier regression if it did.
      if (action?.tier !== 'armed') throw new Error(`${name} is not armed`)
      expect(action.confirmKind).toBe('swap-id')
    })

    it(`${name} says whose money it moves, and does not borrow the send legs' warning`, () => {
      const warning = ACTIONS[name]?.warning ?? ''
      expect(warning).toMatch(/SOLVER'S OWN|SOLVER’S OWN/i)
      // The send-leg hazard must NOT be copied here: claiming it can double-pay
      // would train an operator to discount the warning that actually applies.
      expect(warning).not.toMatch(/DOUBLE-PAYOUT/i)
    })
  }

  it('refuses without the confirmation, like every other armed action', async () => {
    const body = await (await post('receive-refund-now', { id: 'swap-1', confirm: 'nope' })).json()
    expect(body).toMatchObject({ error: 'confirm_required' })
  })
})

/**
 * TLA+ finding F4 (#38) — the fee-dust retry, and the correction that came
 * with it.
 *
 * F4's row is at `claimed`: the client already took the Arkade lockup and
 * revealed `P`, so the solver has PAID OUT and merely cannot collect the L1
 * HTLC economically. The Arkade lockup is gone, which is why the refund
 * actions above do not answer this — a fact worth pinning, because "receive
 * leg is stuck, use the receive refund" is the wrong reach and an expensive
 * one to make at 3am.
 */
describe('the onchain receive leg’s fee-dust claim retry', () => {
  it('is armed and confirms on a swap id', () => {
    const action = ACTIONS['onchain-receive-claim-now']
    expect(action?.tier).toBe('armed')
    if (action?.tier !== 'armed') throw new Error('not armed')
    expect(action.confirmKind).toBe('swap-id')
  })

  it('says it is safe to repeat, because it is', () => {
    // Every attempt spends the SAME output, so a redundant broadcast is a
    // double-spend the network rejects. This is the one operator action here
    // with no judgement call in it, and the warning must not imply otherwise.
    const warning = ACTIONS['onchain-receive-claim-now']?.warning ?? ''
    expect(warning).toMatch(/same output/i)
    expect(warning).not.toMatch(/DOUBLE-PAYOUT/i)
  })

  it("claims the CLIENT's L1 HTLC, and says so — not the solver's lockup", () => {
    // The direction is the whole distinction from `onchain-receive-refund-now`.
    const warning = ACTIONS['onchain-receive-claim-now']?.warning ?? ''
    expect(warning).toMatch(/CLIENT'S L1 HTLC|CLIENT’S L1 HTLC/i)
  })
})

/**
 * The row whose sats are committed under a payment hash that no id names.
 *
 * `read-payment` answers off `row.paymentId`, and a null one used to mean
 * `never-submitted` outright. That is false on any backend that commits our
 * funds against the payment hash one call BEFORE it mints the id — a shape seen
 * on a production rail — and it is false in the costly direction: an operator
 * reading `never-submitted` refunds a lockup whose payment already went out.
 */
describe('read-payment on a row with no payment id', () => {
  const LN_SEND = 'arkade:BTC->lightning:BTC'
  const PAYMENT_HASH = 'ab'.repeat(32)

  const withCommitment = (getSendHtlcState?: unknown) =>
    fakeServices({
      store: { get: vi.fn().mockResolvedValue({ id: 'swap-1', paymentId: null, paymentHash: PAYMENT_HASH }) },
      ln: getSendHtlcState === undefined ? {} : { getSendHtlcState },
    })

  const read = async (services: ReturnType<typeof fakeServices>) =>
    (await (await post('read-payment', { id: 'swap-1', corridor: LN_SEND }, services)).json()) as {
      result?: { verdict?: string; commitment?: string }
    }

  it('does NOT say never-submitted when the backend holds a settled commitment', async () => {
    const body = await read(withCommitment(vi.fn().mockResolvedValue({ status: 'settled', preimage: 'cd'.repeat(32) })))

    expect(body.result?.verdict).toBe('paid-do-not-refund')
  })

  it('says never-submitted only once the backend confirms it holds nothing', async () => {
    const body = await read(withCommitment(vi.fn().mockResolvedValue(null)))

    expect(body.result?.verdict).toBe('never-submitted')
    expect(body.result?.commitment).toBe('none')
  })

  it('will not authorise a refund when the commitment is still undecided', async () => {
    const body = await read(withCommitment(vi.fn().mockResolvedValue({ status: 'committed' })))

    expect(body.result?.verdict).toBe('undecided-push-nothing')
  })

  it('reports a returned commitment as safe to refund', async () => {
    const body = await read(withCommitment(vi.fn().mockResolvedValue({ status: 'returned' })))

    expect(body.result?.verdict).toBe('not-paid-refund-is-safe')
  })

  it('never reads a FAILED probe as "nothing committed"', async () => {
    const body = await read(withCommitment(vi.fn().mockRejectedValue(new Error('operator unreachable'))))

    // "We could not tell" and "nothing was taken" are different facts, and only
    // one of them may put an operator's hand on the refund button.
    expect(body.result?.verdict).toBe('undecided-push-nothing')
    expect(body.result?.commitment).toBe('probe-failed')
  })

  it('says so when the backend cannot be asked at all', async () => {
    const body = await read(withCommitment())

    // Kept as the old answer — true on a backend with no commit-before-id gap —
    // but the caveat is reported rather than hidden.
    expect(body.result?.verdict).toBe('never-submitted')
    expect(body.result?.commitment).toBe('probe-unavailable')
  })

  it('never puts the preimage in the response', async () => {
    const preimage = 'cd'.repeat(32)
    const services = withCommitment(vi.fn().mockResolvedValue({ status: 'settled', preimage }))
    const raw = JSON.stringify(await read(services))

    expect(raw).not.toContain(preimage)
  })
})

describe('claim-now', () => {
  it('is armed, and warns that the danger here is the REFUND', () => {
    expect(ACTIONS['claim-now']?.tier).toBe('armed')
    expect(ACTIONS['claim-now']?.warning).toMatch(/DOUBLE-PAYOUT/i)
  })

  it('returns a stuck row to claiming with the preimage the backend held', async () => {
    const PREIMAGE = 'cd'.repeat(32)
    // A REAL pair: claimNow refuses a preimage that does not hash to the row's
    // payment hash, so an invented one would exercise the refusal, not the path.
    const PAYMENT_HASH = '7969ec0fcb8b648dfde24b1d0ae24568d398dcc3a83b80a850f973238cdfd3d9'
    const transition = vi.fn().mockResolvedValue(true)
    const services = fakeServices({
      store: {
        get: vi.fn().mockResolvedValue({ id: 'swap-1', state: 'stuck', paymentHash: PAYMENT_HASH }),
        transition,
      },
      ln: { getSendHtlcState: vi.fn().mockResolvedValue({ status: 'settled', preimage: PREIMAGE }) },
    })

    const response = await post('claim-now', { id: 'swap-1', confirm: 'swap-1' }, services)

    expect(response.status).toBe(200)
    expect(transition).toHaveBeenCalledWith('swap-1', 'stuck', 'claiming', { preimage: PREIMAGE })
  })
})

describe('park-swap', () => {
  it('is armed, and warns that it forecloses the automatic path', () => {
    expect(ACTIONS['park-swap']?.tier).toBe('armed')
    expect(ACTIONS['park-swap']?.warning).toMatch(/stops/i)
  })

  it('refuses without a reason, even with a matching confirm', async () => {
    const services = fakeServices({
      store: { get: vi.fn().mockResolvedValue({ id: 'swap-1', state: 'paying' }), fail: vi.fn() },
    })
    const response = await post('park-swap', { id: 'swap-1', confirm: 'swap-1' }, services)

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ message: expect.stringMatching(/reason is required/i) })
  })

  it('parks with the reason once confirmed', async () => {
    const fail = vi.fn()
    const services = fakeServices({
      store: {
        get: vi.fn().mockResolvedValueOnce({ id: 'swap-1', state: 'paying' }).mockResolvedValue({ state: 'stuck' }),
        fail,
      },
    })
    const response = await post('park-swap', { id: 'swap-1', reason: 'orphaned request', confirm: 'swap-1' }, services)

    expect(response.status).toBe(200)
    expect(fail).toHaveBeenCalledWith('swap-1', 'paying', 'orphaned request')
  })
})

/**
 * A payment id is only meaningful to the backend that minted it, pointed at the
 * wallet it was minted from. Switching providers — or the same provider onto a
 * different seed — makes every live id unresolvable, and the lookup failure
 * reads exactly like a sick backend.
 *
 * Observed after a vendor migration: a row minted under one rail, read back on
 * another, returned "StorageError: Payment with id ... not found" and a bare
 * `undecided`.
 */
describe('read-payment across a provider or wallet change', () => {
  const LN_SEND = 'arkade:BTC->lightning:BTC'
  const rowPaidBy = (backend: string | null, wallet: string | null) => ({
    id: 'swap-1',
    paymentId: 'LightningSendRequest:01a0',
    paymentHash: 'ab'.repeat(32),
    paymentBackend: backend,
    paymentWallet: wallet,
  })
  const ask = async (row: Record<string, unknown>, fingerprint: string) =>
    (await (
      await post(
        'read-payment',
        { id: 'swap-1', corridor: LN_SEND },
        fakeServices({
          // The deployment is running `lnd`; the row says who paid.
          config: { lnBackend: 'lnd' },
          store: { get: vi.fn().mockResolvedValue(row) },
          ln: {
            getPayment: vi.fn().mockRejectedValue(new Error('StorageError: Payment with id ... not found')),
            walletFingerprint: vi.fn().mockResolvedValue(fingerprint),
          },
        }),
      )
    ).json()) as { result?: { verdict?: string; wallet?: string } }

  it('names a WALLET change rather than reporting an undecided lookup', async () => {
    const body = await ask(rowPaidBy('lnd', 'aaaa'), 'bbbb')

    expect(body.result?.verdict).toBe('other-wallet-push-nothing')
  })

  it('names a BACKEND change too', async () => {
    const body = await ask(rowPaidBy('lnd', 'aaaa'), 'aaaa')
    // Same wallet, different provider: the id may still be unresolvable here.
    const other = await ask(rowPaidBy('fake', 'aaaa'), 'aaaa')

    expect(body.result?.verdict).not.toBe('other-wallet-push-nothing')
    expect(other.result?.verdict).toBe('other-wallet-push-nothing')
  })

  it('stays UNDECIDED when the row predates the recording', async () => {
    // Null is "unknown", never "matches" — an old row must not be claimed as
    // ours just because it carries no fingerprint.
    const body = await ask(rowPaidBy(null, null), 'bbbb')

    expect(body.result?.verdict).toBe('undecided-push-nothing')
  })
})
