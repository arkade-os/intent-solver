/**
 * The fund-source seam, the two built-ins, and the friction in front of the one
 * direction that cannot be undone.
 *
 * Three things are being pinned and they are not the same thing:
 *
 *  1. THE SEAM IS GENERAL. A source registered from outside this repo, with its
 *     own unit, its own balance split and its own capability set, flows through
 *     every action unchanged. A seam justified only by its single implementation
 *     is not a seam, so a non-Lightning source is exercised end to end here.
 *  2. CAPABILITY, NOT REQUIREMENT. What a source cannot do is expressed by
 *     OMITTING the method, so the console can tell "cannot" from "is broken" —
 *     and a source that omits `withdraw` cannot be made to withdraw through the
 *     action, however the request is shaped.
 *  3. THE WITHDRAWAL GATE. `fund-withdraw` is the only action in the console
 *     whose destination is not fixed by a swap, so it is the only one where a
 *     wrong value is a permanent loss rather than the wrong swap being unwound.
 *
 * The Lightning rail needed no new port method for any of this — a rail is a
 * pair, so `newReceiveAddress`/`settleReceiveAddress`/`fund` and the two
 * `getBalance()`s already said everything — which is why the rail's own tests
 * here are about its CHECKS rather than about plumbing.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Address } from '@scure/btc-signer'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import {
  capabilitiesOf,
  fundSources,
  registerFundSource,
  requireFundSource,
  summarise,
  type FundDeposit,
  type FundSource,
} from '@arkade-os/solver-app/ops/fundSources.js'
import { railFundSource } from '@arkade-os/solver-app/ops/railFunds.js'
import { arkadeFundSource } from '@arkade-os/solver-app/ops/arkadeFunds.js'

/** Deterministic, and REAL: a hand-written string would exercise the decode, not the path. */
const addressOn = (network: 'regtest' | 'bitcoin', fill: number): string =>
  Address(ONCHAIN_NETWORKS[network]).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(fill) })

const REGTEST_ADDRESS = addressOn('regtest', 0x11)
const OTHER_REGTEST_ADDRESS = addressOn('regtest', 0x22)
const MAINNET_ADDRESS = addressOn('bitcoin', 0x11)

/**
 * A placeholder, unlike the three above, and the asymmetry mirrors the code: an
 * Arkade address is handed over WITHOUT a decode, because it encodes the server
 * key of the service this wallet is connected to and has no wrong-chain form for
 * a guard to catch. Nothing here parses it, so a real one would prove nothing
 * the short string does not.
 */
const ARKADE_ADDRESS = 'tark1solverfloat'

/**
 * The option a test is about, by KIND rather than by index.
 *
 * Position is a real decision — the option needing no follow-up chore goes first
 * — and it is pinned on its own below. Everywhere else, indexing would couple a
 * test about the boarding address to how many other options happen to exist, and
 * the failure would arrive as a wrong assertion rather than as a missing option.
 */
const optionFor = async (source: FundSource, kind: RegExp): Promise<FundDeposit> => {
  const options = await source.depositOptions!()
  const found = options.find((o) => kind.test(o.addressKind))
  if (!found) throw new Error(`no ${kind} option — got [${options.map((o) => o.addressKind).join(', ')}]`)
  return found
}

const onchainBackend = (over: Record<string, unknown> = {}) => ({
  getBalance: vi.fn().mockResolvedValue({ confirmedSats: 1_000_000, unconfirmedSats: 25_000 }),
  estimateFeeRate: vi.fn().mockResolvedValue(7),
  newReceiveAddress: vi.fn().mockResolvedValue(REGTEST_ADDRESS),
  fund: vi.fn().mockResolvedValue({ txid: 'aa'.repeat(32), vout: 1 }),
  ...over,
})

const lnBackend = (over: Record<string, unknown> = {}) => ({
  getBalance: vi.fn().mockResolvedValue({ availableSats: 400_000, incomingSats: 900_000 }),
  ...over,
})

const arkadeWallet = (over: Record<string, unknown> = {}) => ({
  getBalance: vi.fn().mockResolvedValue({
    available: 300_000,
    boarding: { confirmed: 50_000, unconfirmed: 10_000, total: 60_000 },
    recoverable: 7_000,
    total: 367_000,
  }),
  getBoardingAddress: vi.fn().mockResolvedValue(REGTEST_ADDRESS),
  getAddress: vi.fn().mockResolvedValue(ARKADE_ADDRESS),
  ...over,
})

const adminStore = () => ({
  recordAction: vi.fn().mockResolvedValue(undefined),
  listActions: vi.fn().mockResolvedValue([]),
  getOverrides: vi.fn().mockResolvedValue({}),
})

type Fake = Parameters<typeof arkadeFundSource>[0]

const fakeServices = (over: Record<string, unknown> = {}) =>
  ({
    adminStore: adminStore(),
    config: { network: 'regtest' },
    ln: lnBackend(),
    onchain: onchainBackend(),
    arkade: { wallet: arkadeWallet() },
    ...over,
  }) as never as Fake

const post = (name: string, body: unknown, services: unknown) =>
  buildAdminApp({ services: services as never, startedAt: 1_000_000, mode: 'relay' }).fetch(
    new Request(`http://admin/api/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const resultOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { result?: unknown }).result

/**
 * A source this repo has never heard of, registered the way a consumer's would
 * be — and deliberately UNLIKE both built-ins in every dimension the seam is
 * supposed to abstract over.
 *
 * The unit is a token symbol rather than sats; the balance splits into one
 * figure rather than five; the amount is a 256-bit quantity that a JS number
 * cannot hold; it can withdraw but has no deposit address and no settle step.
 * If any of that required a change to the interface, the interface would be the
 * wrong shape — which is precisely the claim the tests below check.
 *
 * Registered at module scope on purpose: `registerFundSource` is module-level
 * state exactly like `registerLightningRail`, so this exercises the real
 * registration path rather than a hand-assembled list. Vitest isolates modules
 * per file, so it does not leak.
 */
const TOKEN_WITHDRAWALS: { address: string; amount: string }[] = []
const HUGE = '123456789012345678901234567890'

registerFundSource(() => ({
  id: 'token-vault',
  label: 'token vault',
  unit: 'USDX',
  readBalance: async () => ({ unit: 'USDX', figures: [{ label: 'held', amount: HUGE }] }),
  withdraw: async ({ address, amount }) => {
    TOKEN_WITHDRAWALS.push({ address, amount })
    return { reference: '0xdeadbeef', address, amount }
  },
}))

describe('the seam is general, not Lightning-shaped', () => {
  it('lists a consumer source beside the built-ins', async () => {
    const summaries = fundSources(fakeServices()).map(summarise)

    expect(summaries.map((s) => s.id)).toEqual(['rail', 'arkade', 'token-vault'])
  })

  it('lets each source declare its own unit and its own balance split', async () => {
    const services = fakeServices()
    const byId = Object.fromEntries(fundSources(services).map((s) => [s.id, s]))

    const rail = await byId['rail']!.readBalance()
    const arkade = await byId['arkade']!.readBalance()
    const token = await byId['token-vault']!.readBalance()

    // Three sources, three different splits and two different units. A seam with
    // fixed fields could carry at most one of these.
    expect(rail.figures.map((f) => f.label)).toContain('channel out')
    expect(arkade.figures.map((f) => f.label)).toContain('boarding confirmed')
    expect(rail.figures.map((f) => f.label)).not.toEqual(arkade.figures.map((f) => f.label))
    expect(token.unit).toBe('USDX')
  })

  it('carries an amount a JS number cannot hold, unchanged, end to end', async () => {
    // The reason amounts are strings: `evm_amount` is TEXT in the EVM corridor's
    // own store because ERC20 quantities are 256-bit. A numeric field here would
    // have worked for every BTC source and silently truncated the first token
    // one — which is the definition of the wrong seam.
    const response = await post(
      'fund-withdraw',
      { source: 'token-vault', address: '0xabc', amount: HUGE, confirm: '0xabc' },
      fakeServices(),
    )

    expect(response.status).toBe(200)
    expect(TOKEN_WITHDRAWALS.at(-1)).toEqual({ address: '0xabc', amount: HUGE })
  })

  it('reads a balance through the action for a source this repo does not implement', async () => {
    const body = await resultOf(await post('fund-balance', { source: 'token-vault' }, fakeServices()))

    expect(body).toMatchObject({ unit: 'USDX', figures: [{ label: 'held', amount: HUGE }] })
  })

  // The duplicate-id refusal lives in `fundSourceRegistry.test.ts`: the registry
  // is append-only module state, exactly like `registerLightningRail`'s, so
  // registering a clashing id here would poison every test after it.
})

describe('capability, not requirement', () => {
  const services = fakeServices()

  it('reads what a source can do off its METHODS', () => {
    expect(capabilitiesOf(railFundSource(services)!)).toEqual({ deposit: true, settle: false, withdraw: true })
    // The Arkade float: it has a boarding address, and it deliberately offers
    // neither of the other two. @see ops/arkadeFunds.ts
    expect(capabilitiesOf(arkadeFundSource(services))).toEqual({ deposit: true, settle: false, withdraw: false })
  })

  it('turns the rail’s settle step on only where the backend has one', () => {
    const withStep = fakeServices({ onchain: onchainBackend({ settleReceiveAddress: vi.fn() }) })

    expect(capabilitiesOf(railFundSource(services)!).settle).toBe(false)
    expect(capabilitiesOf(railFundSource(withStep)!).settle).toBe(true)
  })

  it('has no rail source at all on a deployment with no BTC rail', () => {
    // The same treatment the four BTC corridors get: absent, not present and
    // failing. A panel reporting the rail as unreadable would report a fault
    // that is actually a configuration.
    const railless = fakeServices({ ln: null, onchain: null })

    expect(railFundSource(railless)).toBeNull()
    expect(fundSources(railless).map((s) => s.id)).not.toContain('rail')
  })

  it('refuses a withdrawal from a source that cannot withdraw, by name', async () => {
    // The Arkade float. Paying an arbitrary address out of it would spend coins
    // outside the process-local reservation ledger, taking one out from under an
    // in-flight lockup funding.
    const response = await post(
      'fund-withdraw',
      { source: 'arkade', address: REGTEST_ADDRESS, amount: '1000', confirm: REGTEST_ADDRESS },
      fakeServices(),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('arkade float source cannot withdraw'),
    })
  })

  it('refuses a settle on a source with no settle step, rather than an empty list', async () => {
    // "settled 0 deposits" and "this source has no settle step" look identical
    // through `[]`, and only one of them means the operator should keep waiting.
    const response = await post('fund-settle-deposits', { source: 'rail' }, fakeServices())

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('cannot settle deposits') })
  })

  it('names what IS available when the source is unknown', async () => {
    // The id an operator typed is usually right for a deployment they are
    // thinking of; the useful answer is which deployment this one is.
    const response = await post('fund-balance', { source: 'lightning' }, fakeServices())

    expect(await response.json()).toMatchObject({ message: expect.stringContaining('it has rail, arkade') })
  })

  it('advertises each source’s capabilities so the console draws only the buttons that work', async () => {
    const body = (await resultOf(await post('fund-sources', {}, fakeServices()))) as {
      sources: { id: string; can: Record<string, boolean> }[]
    }

    expect(body.sources.find((s) => s.id === 'arkade')?.can).toEqual({
      deposit: true,
      settle: false,
      withdraw: false,
    })
  })
})

describe('the lightning rail source', () => {
  it('reports channel and onchain figures apart, never summed', async () => {
    const balance = await railFundSource(fakeServices())!.readBalance()
    const labelled = Object.fromEntries(balance.figures.map((f) => [f.label, f.amount]))

    // Outbound and inbound answer different questions, and so do confirmed and
    // unconfirmed. One number would hide a rail that is dead for one direction
    // and healthy for the other.
    expect(labelled).toMatchObject({
      'channel out': '400000',
      'channel in': '900000',
      'onchain confirmed': '1000000',
      'onchain unconfirmed': '25000',
    })
  })

  it('still reports the side that answered when the other is down', async () => {
    const services = fakeServices({
      ln: lnBackend({ getBalance: vi.fn().mockRejectedValue(new Error('node unreachable')) }),
    })
    const figures = (await railFundSource(services)!.readBalance()).figures
    const byLabel = Object.fromEntries(figures.map((f) => [f.label, f]))

    // "L1 holds a million, the node is unreachable" is a decision an operator
    // can act on; one error for the whole read is only a shrug.
    expect(byLabel['channel out']!.amount).toBeNull()
    expect(byLabel['channel out']!.note).toBe('node unreachable')
    expect(byLabel['onchain confirmed']!.amount).toBe('1000000')
  })

  it('warns about a shared pool only when the backend says so', async () => {
    // Three cases because ABSENT and explicit FALSE are different facts that
    // must produce the same silence: the flag is optional on the port, so
    // absence means "not stated", and warning on anything short of an explicit
    // `true` would put this on every LND deployment — which really does keep two
    // pools, and whose adapter never sets the flag.
    const balanceWith = (sharedWithLightning?: boolean) =>
      railFundSource(
        fakeServices({
          onchain: onchainBackend({
            getBalance: vi.fn().mockResolvedValue({ confirmedSats: 1, unconfirmedSats: 0, sharedWithLightning }),
          }),
        }),
      )!.readBalance()

    expect((await balanceWith(undefined)).figures.map((f) => f.label)).not.toContain('pools')
    expect((await balanceWith(false)).figures.map((f) => f.label)).not.toContain('pools')
    expect((await balanceWith(true)).figures.find((f) => f.label === 'pools')?.note).toMatch(/ONE pool/)
  })

  it('refuses a deposit address that does not belong to this deployment’s network', async () => {
    // The backend pointed at the wrong chain. Handing this over would be an
    // irreversible send to a wallet this solver is not running — and unlike a
    // withdrawal, the operator has no reason to doubt an address the console
    // itself gave them.
    const services = fakeServices({
      onchain: onchainBackend({ newReceiveAddress: vi.fn().mockResolvedValue(MAINNET_ADDRESS) }),
    })

    await expect(railFundSource(services)!.depositOptions!()).rejects.toThrow(/not a regtest address/i)
  })

  it('says arrivals need settling exactly when the backend has a settle step', async () => {
    const plain = await optionFor(railFundSource(fakeServices())!, /^bitcoin/)
    const deposits = await optionFor(
      railFundSource(fakeServices({ onchain: onchainBackend({ settleReceiveAddress: vi.fn() }) }))!,
      /^bitcoin/,
    )

    // Without this the operator is left watching a balance that will never move
    // on its own.
    expect(plain.settleRequired).toBe(false)
    expect(deposits.settleRequired).toBe(true)
  })

  it('says out loud that a deposit does not become channel liquidity', async () => {
    // Neither port has a channel primitive. A deposit that silently only funded
    // the onchain half would be read as the other thing, on the screen where the
    // corridor's capacity is being judged.
    const deposit = await optionFor(railFundSource(fakeServices())!, /^bitcoin/)

    expect(deposit.note).toMatch(/does not open a channel/i)
  })

  /**
   * `createInvoice` is an OPTIONAL port capability, so both halves are pinned:
   * the rail that has one offers it, and the rail that does not still has
   * somewhere to send. A backend without it must not lose its onchain option to
   * a `TypeError`, which is what an unguarded call would produce.
   */
  it('offers an invoice first where the backend can mint one, and onchain regardless', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const createInvoice = vi.fn().mockResolvedValue({ invoice: 'lnbcrt1solverfloat', expiresAt })
    const withInvoice = railFundSource(fakeServices({ ln: lnBackend({ createInvoice }) }))!

    expect((await withInvoice.depositOptions!()).map((o) => o.addressKind)).toEqual([
      'lightning invoice',
      'bitcoin regtest',
    ])
    // Amountless, because the console asks for no amount before showing an
    // option: minting for a guessed one hands over an invoice the operator
    // cannot pay what they meant to.
    expect(createInvoice).toHaveBeenCalledWith({ memo: expect.any(String) })
    const invoice = (await withInvoice.depositOptions!())[0]!
    expect(invoice).toMatchObject({ address: 'lnbcrt1solverfloat', settleRequired: false, expiresAt })
    expect(invoice.amountSats).toBeUndefined()

    // The fake `lnBackend` has no `createInvoice` — the shape of a backend that
    // cannot mint one — and the onchain option survives it.
    expect((await railFundSource(fakeServices())!.depositOptions!()).map((o) => o.addressKind)).toEqual([
      'bitcoin regtest',
    ])
  })

  it('runs the backend’s own claim step and reports each outcome', async () => {
    const settleReceiveAddress = vi.fn().mockResolvedValue([
      { settled: true, txid: 'bb'.repeat(32), vout: 0, reference: 'transfer-1' },
      { settled: false, txid: 'cc'.repeat(32), vout: 2, reason: 'not confirmed yet' },
    ])
    const source = railFundSource(fakeServices({ onchain: onchainBackend({ settleReceiveAddress }) }))!

    const settlements = await source.settleDeposits!()

    // One failure must not hide the deposits either side of it.
    expect(settlements).toEqual([
      { settled: true, reference: `${'bb'.repeat(32)}:0 (transfer-1)` },
      { settled: false, reference: `${'cc'.repeat(32)}:2`, reason: 'not confirmed yet' },
    ])
  })
})

describe('the arkade float source', () => {
  it('splits the balance the way a FUNDING decision needs it', async () => {
    const figures = (await arkadeFundSource(fakeServices()).readBalance()).figures
    const labelled = Object.fromEntries(figures.map((f) => [f.label, f.amount]))

    // `available` is the only figure that answers "can this fund a swap", and
    // each of the others is a way it can be low while the wallet looks full.
    expect(labelled).toMatchObject({ available: '300000', 'boarding confirmed': '50000', recoverable: '7000' })
  })

  it('names recoverable float as the trap it is', async () => {
    // It reads as balance and funds nothing until recovery runs, and a float in
    // that state fails every corridor with a reason that names the corridor
    // rather than the float.
    const figures = (await arkadeFundSource(fakeServices()).readBalance()).figures

    expect(figures.find((f) => f.label === 'recoverable')?.note).toMatch(/funds nothing until/i)
  })

  it('hands out the boarding address and points at the action that settles it', async () => {
    const deposit = await optionFor(arkadeFundSource(fakeServices()), /boarding/)

    expect(deposit.address).toBe(REGTEST_ADDRESS)
    // `settleRequired` true with NO settle method is not a contradiction — the
    // two are different facts, and the note is what closes the gap.
    expect(deposit.settleRequired).toBe(true)
    expect(deposit.note).toMatch(/float-lifecycle/)
    expect(arkadeFundSource(fakeServices()).settleDeposits).toBeUndefined()
  })

  it('refuses a boarding address for another chain', async () => {
    const services = fakeServices({
      arkade: { wallet: arkadeWallet({ getBoardingAddress: vi.fn().mockResolvedValue(MAINNET_ADDRESS) }) },
    })

    await expect(arkadeFundSource(services).depositOptions!()).rejects.toThrow(/not a regtest address/i)
  })

  /**
   * The plural half, and the reason this feature exists.
   *
   * Offering only the boarding address told an operator already holding VTXOs to
   * go out to L1 and wait for a settlement — a chore with a cheaper alternative
   * the console simply did not mention.
   */
  it('offers the Arkade address BESIDE the boarding one, and puts the chore-free one first', async () => {
    const options = await arkadeFundSource(fakeServices()).depositOptions!()

    // Order is the recommendation. An operator who takes the top option should
    // get spendable float rather than a second thing to run.
    expect(options.map((o) => o.settleRequired)).toEqual([false, true])
    expect(options[0]).toMatchObject({ address: ARKADE_ADDRESS, addressKind: 'arkade regtest' })
    expect(options[0]!.note).toMatch(/on arrival/i)
    expect(options[1]!.address).toBe(REGTEST_ADDRESS)
  })
})

describe('withdrawing from the rail — the checks that run before the backend is touched', () => {
  const withdraw = (services: Fake, params: { address: string; amount: string }) =>
    railFundSource(services)!.withdraw!(params)

  it('pays the address once every check passes', async () => {
    const onchain = onchainBackend()
    const result = await withdraw(fakeServices({ onchain }), { address: REGTEST_ADDRESS, amount: '50000' })

    expect(onchain.fund).toHaveBeenCalledWith(expect.objectContaining({ address: REGTEST_ADDRESS, amountSats: 50_000 }))
    // The vout the wallet actually used, never 0 by assumption: a wallet-funded
    // spend may put its change first.
    expect(result).toMatchObject({ reference: 'aa'.repeat(32), amount: '50000', detail: { vout: 1 } })
  })

  it('refuses an address for another chain WITHOUT touching the backend', async () => {
    // The one mistake retyping the address cannot catch: the operator confirms
    // the same wrong string a second time. So it is caught here, before `fund`.
    const onchain = onchainBackend()

    await expect(withdraw(fakeServices({ onchain }), { address: MAINNET_ADDRESS, amount: '50000' })).rejects.toThrow(
      /not a valid regtest address/i,
    )
    expect(onchain.fund).not.toHaveBeenCalled()
  })

  it('refuses more than the CONFIRMED balance, and names both numbers', async () => {
    // Unconfirmed sats can still be replaced, so spending them chains the
    // withdrawal behind whatever might be.
    const onchain = onchainBackend()

    await expect(withdraw(fakeServices({ onchain }), { address: REGTEST_ADDRESS, amount: '1000001' })).rejects.toThrow(
      /requested: 1000001, confirmed: 1000000/,
    )
    expect(onchain.fund).not.toHaveBeenCalled()
  })

  it('refuses anything that is not exactly a whole positive sat count', async () => {
    const onchain = onchainBackend()
    // `1e3` and ` 12 ` both coerce to a number happily, which is why the parse
    // is round-tripped rather than merely coerced — and a 256-bit token quantity
    // that wandered in must not be silently truncated to a sat count.
    for (const amount of ['0', '-1', '0.5', 'abc', '1e3', '  ', '9007199254740993', HUGE]) {
      await expect(withdraw(fakeServices({ onchain }), { address: REGTEST_ADDRESS, amount }), amount).rejects.toThrow(
        /whole positive number of sats/i,
      )
    }
    expect(onchain.fund).not.toHaveBeenCalled()
  })

  it('uses a DIFFERENT idempotency key per attempt', async () => {
    // Deliberate. Nothing persists or re-drives this call, so a key derived from
    // address-and-amount would make a second, intended withdrawal of the same
    // amount to the same address return the FIRST txid and move nothing — a
    // silent no-op wearing a success. Two presses can also land in the same
    // millisecond, so a clock-derived key would be stable for exactly the case
    // it must not be.
    const onchain = onchainBackend()
    const services = fakeServices({ onchain })
    await withdraw(services, { address: REGTEST_ADDRESS, amount: '1000' })
    await withdraw(services, { address: REGTEST_ADDRESS, amount: '1000' })

    const keys = onchain.fund.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey)
    expect(keys[0]).not.toBe(keys[1])
  })
})

/**
 * The gate, asserted at the API — the way an operator scripting around the
 * console at 3am reaches it, with no browser and no dialog in the way.
 */
describe('the withdrawal confirmation', () => {
  it('is armed, and confirms on the DESTINATION rather than a fixed word', () => {
    const action = ACTIONS['fund-withdraw']
    expect(action?.tier).toBe('armed')
    if (action?.tier !== 'armed') throw new Error('fund-withdraw is not armed')
    // A literal is the same keystrokes every time and becomes muscle memory; a
    // confirmation that differs per request cannot.
    expect(action.confirmKind).toBe('destination-address')
    expect(action.expectedConfirm({ address: REGTEST_ADDRESS })).toBe(REGTEST_ADDRESS)
  })

  it('refuses when the typed address is a DIFFERENT valid address', async () => {
    // The case a length or format check would wave through: both are real
    // regtest addresses, and only one of them is the one being paid.
    const onchain = onchainBackend()
    const response = await post(
      'fund-withdraw',
      { source: 'rail', address: REGTEST_ADDRESS, amount: '1000', confirm: OTHER_REGTEST_ADDRESS },
      fakeServices({ onchain }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'confirm_required' })
    expect(onchain.fund).not.toHaveBeenCalled()
  })

  it('refuses with no confirmation at all, and audits nothing', async () => {
    const services = fakeServices({ onchain: onchainBackend() })
    const response = await post('fund-withdraw', { source: 'rail', address: REGTEST_ADDRESS, amount: '1000' }, services)

    expect(response.status).toBe(400)
    // Nothing was attempted, so an audit row would record something that never
    // happened.
    expect(
      (services as unknown as { adminStore: { recordAction: unknown } }).adminStore.recordAction,
    ).not.toHaveBeenCalled()
  })

  it('refuses a request that names no destination, however it is confirmed', async () => {
    // `expectedConfirm` answers null, and the route rejects rather than letting
    // an undefined confirm match an undefined address.
    for (const body of [
      { source: 'rail', amount: '1000' },
      { source: 'rail', amount: '1000', confirm: '' },
      { source: 'rail', address: '   ', confirm: '   ' },
    ]) {
      expect((await post('fund-withdraw', body, fakeServices())).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('pays once the typed address matches', async () => {
    const onchain = onchainBackend()
    const response = await post(
      'fund-withdraw',
      { source: 'rail', address: REGTEST_ADDRESS, amount: '1000', confirm: REGTEST_ADDRESS },
      fakeServices({ onchain }),
    )

    expect(response.status).toBe(200)
    expect(onchain.fund).toHaveBeenCalledTimes(1)
  })

  it('tolerates surrounding whitespace on both sides, so a pasted address still matches', async () => {
    // Trimmed on the SAME path the payment uses, never separately: a confirm
    // that matched a string different from the one being paid would be worse
    // than no confirm at all.
    const onchain = onchainBackend()
    const response = await post(
      'fund-withdraw',
      { source: 'rail', address: ` ${REGTEST_ADDRESS} `, amount: '1000', confirm: REGTEST_ADDRESS },
      fakeServices({ onchain }),
    )

    expect(response.status).toBe(200)
    expect(onchain.fund).toHaveBeenCalledWith(expect.objectContaining({ address: REGTEST_ADDRESS }))
  })

  it('refuses a request that names no source, without a default', async () => {
    // There is no sensible default wallet to pay out of, and guessing one is a
    // withdrawal from somewhere nobody chose.
    const response = await post(
      'fund-withdraw',
      { address: REGTEST_ADDRESS, amount: '1000', confirm: REGTEST_ADDRESS },
      fakeServices(),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('source is required') })
  })

  it('records the destination on the audit row, on success AND on failure', async () => {
    const ok = fakeServices({ onchain: onchainBackend() })
    await post(
      'fund-withdraw',
      { source: 'rail', address: REGTEST_ADDRESS, amount: '1000', confirm: REGTEST_ADDRESS },
      ok,
    )

    const broken = fakeServices({
      onchain: onchainBackend({ fund: vi.fn().mockRejectedValue(new Error('wallet locked')) }),
    })
    await post(
      'fund-withdraw',
      { source: 'rail', address: REGTEST_ADDRESS, amount: '1000', confirm: REGTEST_ADDRESS },
      broken,
    )

    const record = (s: unknown) =>
      (s as { adminStore: { recordAction: { mock: { calls: [Record<string, unknown>][] } } } }).adminStore.recordAction
    expect(record(ok).mock.calls[0]![0]).toMatchObject({
      action: 'fund-withdraw',
      target: REGTEST_ADDRESS,
      outcome: 'ok',
    })
    // A withdrawal that threw is exactly the one an operator needs a record of.
    expect(record(broken).mock.calls[0]![0]).toMatchObject({ target: REGTEST_ADDRESS, outcome: 'error' })
  })

  it('warns about what is actually dangerous here, not a borrowed hazard', () => {
    const warning = ACTIONS['fund-withdraw']?.warning ?? ''
    expect(warning).toMatch(/irreversible/i)
    // The two facts an operator cannot recover from being wrong about.
    expect(warning).toMatch(/NOT SAFE TO REPEAT/i)
    expect(warning).toMatch(/NOT channel liquidity/i)
    // The send legs' hazard is a different one; claiming it here would train an
    // operator to discount the warning that does apply.
    expect(warning).not.toMatch(/DOUBLE-PAYOUT/i)
  })
})

describe('the read-only fund actions stay unarmed', () => {
  // So an operator is not trained to click through warnings on the reads and
  // then does the same on the one that empties a wallet.
  it.each(['fund-sources', 'fund-balance', 'fund-deposit-address', 'fund-settle-deposits'])('%s is safe', (name) => {
    expect(ACTIONS[name]?.tier).toBe('safe')
  })
})

describe('requireFundSource', () => {
  const source = (id: string): FundSource => ({
    id,
    label: id,
    unit: 'sats',
    readBalance: async () => ({ unit: 'sats', figures: [] }),
  })

  it('refuses a missing or non-string id by naming what is here', () => {
    for (const id of [undefined, '', 42, null]) {
      expect(() => requireFundSource([source('a')], id)).toThrow(/source is required and must be one of a/)
    }
  })
})

/**
 * The console half. `app.js` is a browser module with no exports and no DOM
 * here, so this reads the source the way `test/admin/armedActions.test.ts` does.
 */
describe('the wallet page’s funding panel', () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
    'utf8',
  )
  const walletView = (): string => {
    const start = appSource.indexOf('const walletView')
    if (start === -1) throw new Error('walletView is gone')
    return appSource.slice(start, appSource.indexOf('const backendsView', start))
  }

  it('is rendered from the wallet view, not merely defined beside it', () => {
    // Adding the panel and forgetting the call is how a change ships invisible.
    expect(walletView()).toContain('fundsPanel()')
  })

  it('draws each button only where the source declares the capability', () => {
    // A button for something the source cannot do is a click guaranteed to fail
    // — and on this screen "cannot" and "is broken" must not look the same.
    const start = appSource.indexOf('const fundSourcePanel')
    const block = appSource.slice(start, appSource.indexOf('const fundsPanel', start))
    expect(block).toContain('source.can.deposit')
    expect(block).toContain('source.can.settle')
    expect(block).toContain('source.can.withdraw')
  })

  it('asks the dialog for the address, so the prompt matches what the server checks', () => {
    // The server compares `body.address`. A dialog that asked for anything else
    // would be a confirmation nobody can pass — correct on the server, unusable
    // through the console.
    expect(appSource).toMatch(/confirmKind === 'destination-address'\s*\?\s*body\.address/)
  })

  it('puts the source, amount and destination in front of the operator before the confirm box', () => {
    // `armDialog`'s third argument is the override gate: a banner plus a checkbox
    // that must be ticked before the typed address counts.
    const start = appSource.indexOf('const fundWithdraw')
    expect(start).toBeGreaterThan(-1)
    const block = appSource.slice(start, appSource.indexOf('const fundFigureRows', start))
    // Whitespace-tolerant: prettier owns the wrapping, and an assertion on its
    // exact output would fail on a reformat that changed nothing.
    expect(block).toMatch(/armDialog\(\s*'fund-withdraw',\s*\{ source: source\.id, address, amount \},/)
    expect(block).toMatch(/About to send \$\{fundAmount\(amount\)\} \$\{source\.unit\} from \$\{source\.label\}/)
  })

  /** One option's own render, bounded so an assertion cannot pass on its caller. */
  const depositBlock = (): string => {
    const start = appSource.indexOf('const fundDepositOption')
    if (start === -1) throw new Error('fundDepositOption is gone')
    return appSource.slice(start, appSource.indexOf('const fundResult', start))
  }

  /** The list around them, and the two answers that are not a list. */
  const resultBlock = (): string => {
    const start = appSource.indexOf('const fundResult')
    if (start === -1) throw new Error('fundResult is gone')
    return appSource.slice(start, appSource.indexOf('const fundSourcePanel', start))
  }

  it('renders a deposit address untruncated', () => {
    // The shared result banner cuts at 160 characters. A silently shortened
    // address is a send to nowhere, so this answer gets its own slice and a
    // selectable block.
    expect(depositBlock()).toContain("h('pre.faint', option.address)")
    expect(depositBlock()).not.toContain('slice(0, 160)')
    expect(depositBlock()).not.toContain('shortId(')
  })

  it('renders EVERY option rather than the first', () => {
    // The whole feature. A render that reached for `options[0]` would drop the
    // boarding address on Arkade and the onchain one on the rail — and would
    // look correct, because the option it kept is a real one.
    expect(resultBlock()).toContain('options.map(fundDepositOption)')
    expect(resultBlock()).not.toMatch(/options\[0\]/)
  })

  it('says an expired option is dead, rather than showing a stale countdown', () => {
    // An invoice paid late fails at the payer's node with an error that names
    // none of this. The console has to be what says the string is no longer
    // good, and it must say it as a banner — a faint note beside an address is
    // read as a caption, not as "do not pay this".
    expect(depositBlock()).toMatch(/left <= 0[\s\S]{0,80}h\('p\.banner'/)
    // Recomputed per render against the clock, never a value frozen when the
    // option was fetched — the page re-renders on the stream tick, so a live
    // countdown stays honest and a captured one does not.
    expect(depositBlock()).toContain('Math.floor(Date.now() / 1000)')
  })

  it('distinguishes an empty option list from an answer it cannot render', () => {
    // A source that declared the capability and produced nothing is a fault.
    // Rendering it as blank space leaves an operator pressing a button that
    // appears to do nothing at all.
    expect(resultBlock()).toMatch(/options\.length === 0[\s\S]{0,40}h\('p\.banner'/)
    expect(resultBlock()).toContain('JSON.stringify(read.result, null, 2)')
  })

  it('emits the figure rows FLAT, as `.kv` grid children', () => {
    // `.kv` is a two-column grid and its items are its direct children, so
    // pairing each label with its value inside a wrapper collapses the list into
    // one stacked column. Caught by reading styles.css, not by any test that
    // could see it — there is no DOM here.
    const start = appSource.indexOf('const fundFigureRows')
    const block = appSource.slice(start, appSource.indexOf('const fundSourcePanel', start))
    expect(block).toContain('flatMap')
    expect(block).toMatch(/h\('dt', f\.label\),/)
  })

  it('groups a figure only where the grouping is exact', () => {
    // A 256-bit token quantity does not round-trip through `Number`, and a
    // grouped-but-wrong figure is worse than an ungrouped right one on the
    // screen someone funds a wallet from.
    const start = appSource.indexOf('const fundAmount')
    const block = appSource.slice(start, appSource.indexOf('const fundAction', start))
    expect(block).toMatch(/Number\.isSafeInteger\(n\) && String\(n\) === String\(raw\)/)
  })
})
