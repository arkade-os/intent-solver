import { afterEach, describe, expect, it, vi } from 'vitest'
import { RebalancePanel } from '../../packages/solver-app/src/admin/static/rebalance.js'

const policy = {
  enabled: false,
  reserveSats: 10,
  maxDebitSats: 100,
  dailyDebitSats: 200,
  maxFeeSats: 5,
  maxFeeBps: 50,
  minTransferSats: 1,
  cooldownSeconds: 300,
  targets: {},
}
const overview = {
  policy,
  pools: [{ id: 'rail:shared', label: 'shared pool', balanceSats: 50, kinds: ['onchain', 'lightning'] }],
  transfers: [],
}
const h = (tag: string, ...children: unknown[]) => ({ tag, children })
const nodesIn = (tree: any): { tag: string; children: any[] }[] => {
  if (Array.isArray(tree)) return tree.flatMap(nodesIn)
  if (!tree?.tag) return []
  return [tree, ...tree.children.flatMap(nodesIn)]
}

afterEach(() => vi.useRealTimers())

describe('rebalance wallet panel', () => {
  it('omits untouched automatic targets when saving a manual-only policy after rendering', async () => {
    const panel = new RebalancePanel(vi.fn().mockResolvedValue(overview), vi.fn())
    await panel.refresh()
    panel.render(h)
    expect(panel.policy.targets['rail:shared']).toEqual({ minimumSats: '', targetSats: '' })
    expect(panel.policyPayload()).toEqual(policy)
    expect(panel.policy.targets['rail:shared']).toEqual({ minimumSats: '', targetSats: '' })
  })
  it.each([
    { minimumSats: '1', targetSats: '' },
    { minimumSats: '', targetSats: '10' },
  ])('refuses a partially entered automatic target: %j', async (target) => {
    const panel = new RebalancePanel(vi.fn().mockResolvedValue(overview), vi.fn())
    await panel.refresh()
    panel.render(h)
    panel.policy.targets['rail:shared'] = target
    expect(() => panel.policyPayload()).toThrow(/whole/)
  })
  it('refuses blank, exponential and unsafe monetary inputs before sending policy', () => {
    const panel = new RebalancePanel(vi.fn(), vi.fn())
    panel.policy = { ...policy, targets: {}, counterparty: { solverPubkey: '', relays: [] } }
    for (const value of ['', '1e3', '9007199254740992']) {
      panel.policy.reserveSats = value
      expect(() => panel.policyPayload()).toThrow(/whole/)
    }
  })
  it('keeps typed inputs across redraw and never fetches balances on a redraw', async () => {
    const api = vi.fn().mockResolvedValue(overview)
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    panel.draft.amount = '123'
    panel.render(h)
    panel.render(h)
    expect(panel.draft.amount).toBe('123')
    expect(api).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(panel.render(h))).toContain('shared pool')
    expect(panel.policy.enabled).toBe(false)
  })
  it('retains the request key for retry and never includes a destination', () => {
    const panel = new RebalancePanel(vi.fn(), vi.fn())
    panel.draft.amount = '123'
    panel.draft.poolId = 'rail:shared'
    const first = panel.quoteBody()
    expect(panel.quoteBody()).toEqual(first)
    expect(first).not.toHaveProperty('destination')
    expect(first).not.toHaveProperty('kind')
    expect(first.receivingFeeAllowanceSats).toBe('1000')
  })
  it('renders a fee preview before submitting and sends the quote id the server checks', async () => {
    const quote = {
      id: 'quote-1',
      state: 'quoted',
      netSats: 123,
      feeSats: 5,
      debitSats: 128,
      poolId: 'rail:shared',
      kind: 'onchain',
      deposit: { kind: 'onchain', feeSats: 2 },
      expiresAt: 2000000000,
    }
    const api = vi.fn().mockResolvedValue({ ...overview, transfers: [quote] })
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    panel.quote = quote
    const tree = panel.render(h)
    const review = nodesIn(tree).find((node) => node.tag === 'section.wallet-quote')!
    expect(JSON.stringify(review)).toContain('Review this transfer')
    expect(JSON.stringify(review)).toContain('Arkade wallet')
    expect(JSON.stringify(review)).toContain('shared pool')
    expect(JSON.stringify(review)).toContain('Maximum total fees')
    expect(JSON.stringify(review)).toContain('5 sat')
    expect(JSON.stringify(review)).toContain('Maximum Arkade debit')
    expect(JSON.stringify(review)).toContain('128 sat')
    expect(JSON.stringify(review)).toContain('Destination fee allowance')
    expect(JSON.stringify(review)).toContain('2 sat')
    expect(JSON.stringify(review)).toContain('No funds have been sent')
    expect(api).toHaveBeenCalledTimes(1)
    const nodes = nodesIn(tree)
    const send = nodes.find((node) => node.tag === 'button.act' && node.children[1] === 'Send')!
    await send.children[0].onclick()
    expect(api.mock.calls[1]).toEqual([
      '/api/rebalance/submit',
      { method: 'POST', body: JSON.stringify({ id: 'quote-1', confirm: 'quote-1' }) },
    ])
  })
  it.each([
    ['Minimum credit (sat)', 'oninput'],
    ['Destination pool', 'onchange'],
    ['Deposit route', 'onchange'],
    ['Destination fee allowance (sat)', 'oninput'],
  ])('drops a reviewed quote and its Send once %s changes', async (label, event) => {
    const quote = { id: 'q1', state: 'quoted', netSats: 1, feeSats: 1, debitSats: 2, kind: 'onchain', expiresAt: 2e9 }
    const redraw = vi.fn()
    const panel = new RebalancePanel(vi.fn().mockResolvedValue({ ...overview, transfers: [quote] }), redraw)
    await panel.refresh()
    panel.quote = quote
    const sends = () => nodesIn(panel.render(h)).filter((node) => node.children[1] === 'Send')
    expect(sends()).toHaveLength(1)
    const field = nodesIn(panel.render(h)).find(
      (node) => node.tag === 'label.wallet-field' && node.children[0] === label,
    )!
    field.children[1].children[0][event]({ target: { value: '124' } })
    expect(panel.quote).toBeNull()
    expect(redraw).toHaveBeenCalledTimes(2)
    expect(sends()).toHaveLength(0)
  })
  it('keeps failures visible after refreshing transfer status', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('needs reconciliation')).mockResolvedValue(overview)
    const panel = new RebalancePanel(api, vi.fn())
    await panel.act('submit', { id: 'q1', confirm: 'q1' })
    expect(panel.error).toBe('needs reconciliation')
    expect(panel.data).toEqual(overview)
    expect(api.mock.calls[1]?.[0]).toBe('/api/rebalance')
  })
  it.each([
    ['submit', 'pending', 'On its way'],
    ['cancel', 'cancelled', 'Cancelled before sending.'],
  ])('keeps a successful %s result when the following refresh fails', async (action, state, label) => {
    const quote = {
      id: 'quote-1',
      state: 'quoted',
      poolId: 'rail:shared',
      netSats: 123,
      feeSats: 5,
      debitSats: 128,
      kind: 'onchain',
      expiresAt: 2_000_000_000,
      createdAt: 1_793_866_175,
    }
    const result = { ...quote, state, ...(state === 'pending' ? { chargedAt: 1_793_866_176 } : {}) }
    const api = vi
      .fn()
      .mockResolvedValueOnce({ ...overview, transfers: [quote] })
      .mockResolvedValueOnce({ ok: true, result })
      .mockRejectedValueOnce(new Error('Status refresh unavailable'))
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    panel.quote = quote
    await panel.act(action, { id: quote.id, confirm: quote.id })
    expect(panel.data.transfers[0]).toEqual(result)
    expect(panel.quote).toEqual(result)
    const tree = panel.render(h)
    expect(JSON.stringify(tree)).toContain(label)
    expect(JSON.stringify(tree)).not.toContain('No funds have been sent')
    expect(nodesIn(tree).some((node) => node.children[1] === 'Send')).toBe(false)
    expect(panel.error).toBe('Status refresh unavailable')
  })
  it('clears an older reviewed quote when a new quote fails and explains that nothing was sent', async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error('Available Arkade funds cannot cover this transfer.'))
      .mockResolvedValue(overview)
    const panel = new RebalancePanel(api, vi.fn())
    panel.quote = { id: 'old', state: 'quoted' }
    await panel.act('quote', { amount: '2000000' })
    expect(panel.quote).toBeNull()
    expect(panel.error).toBe(
      'Could not prepare a quote. No funds were sent. Available Arkade funds cannot cover this transfer.',
    )
    expect(nodesIn(panel.render(h)).some((node) => node.children[1] === 'Send')).toBe(false)
  })
  it('shows a manual quote above automatic fee limits and disables Send when it expires', async () => {
    const quote = {
      id: 'manual-high-fee',
      state: 'quoted',
      poolId: 'rail:shared',
      netSats: 2_000_000,
      feeSats: 15_759,
      debitSats: 2_015_759,
      kind: 'onchain',
      expiresAt: 2_000_000_000,
      deposit: { kind: 'onchain', feeSats: 1000 },
    }
    const panel = new RebalancePanel(vi.fn().mockResolvedValue({ ...overview, transfers: [quote] }), vi.fn())
    await panel.refresh()
    panel.quote = quote
    const review = () => nodesIn(panel.render(h)).find((node) => node.tag === 'section.wallet-quote')!
    expect(JSON.stringify(review())).toContain('15,759 sat')
    expect(JSON.stringify(review())).toContain('2,015,759 sat')
    expect(nodesIn(review()).find((node) => node.children[1] === 'Send')!.children[0].disabled).toBe(false)
    quote.expiresAt = 1
    expect(JSON.stringify(review())).toContain('This quote has expired')
    expect(nodesIn(review()).find((node) => node.children[1] === 'Send')!.children[0].disabled).toBe(true)
    quote.state = 'pending'
    expect(review()).toBeUndefined()
  })
  it('redraws the countdown and disables an expired quote without a status refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const quote = {
      id: 'short-quote',
      state: 'quoted',
      poolId: 'rail:shared',
      netSats: 123,
      feeSats: 5,
      debitSats: 128,
      kind: 'onchain',
      expiresAt: Date.now() / 1000 + 2,
    }
    const api = vi.fn().mockResolvedValue({ ...overview, transfers: [quote] })
    const redraw = vi.fn()
    const panel = new RebalancePanel(api, redraw)
    await panel.refresh()
    panel.quote = quote
    let tree = panel.render(h)
    redraw.mockImplementation(() => {
      tree = panel.render(h)
    })
    const originalSend = nodesIn(tree).find((node) => node.children[1] === 'Send')!
    expect(JSON.stringify(tree)).toContain('Expires in 2 seconds')
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.stringify(tree)).toContain('Expires in 1 second')
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.stringify(tree)).toContain('This quote has expired')
    expect(nodesIn(tree).find((node) => node.children[1] === 'Send')!.children[0].disabled).toBe(true)
    expect(nodesIn(tree).some((node) => node.children[1] === 'Review a fresh quote')).toBe(true)
    await originalSend.children[0].onclick()
    expect(api).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reviews an expired transfer with a new request key before allowing Send again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const expired = {
      id: 'old-quote',
      state: 'quoted',
      poolId: 'rail:shared',
      netSats: 123,
      feeSats: 5,
      debitSats: 128,
      kind: 'onchain',
      expiresAt: Date.now() / 1000 - 1,
    }
    const fresh = { ...expired, id: 'fresh-quote', feeSats: 6, debitSats: 129, expiresAt: Date.now() / 1000 + 60 }
    const api = vi
      .fn()
      .mockResolvedValueOnce({ ...overview, transfers: [expired] })
      .mockResolvedValueOnce({ ok: true, result: fresh })
      .mockResolvedValueOnce({ ...overview, transfers: [fresh, expired] })
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    panel.quote = expired
    panel.draft.amount = '123'
    const previousKey = panel.quoteBody().requestKey
    const review = nodesIn(panel.render(h)).find((node) => node.children[1] === 'Review a fresh quote')!
    await review.children[0].onclick()
    const request = JSON.parse(api.mock.calls[1]![1].body)
    expect(request.requestKey).not.toBe(previousKey)
    expect(request.amount).toBe('123')
    expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/rebalance', '/api/rebalance/quote', '/api/rebalance'])
    const tree = panel.render(h)
    expect(JSON.stringify(tree)).toContain('129 sat')
    expect(JSON.stringify(tree)).toContain('Expires in 60 seconds')
    expect(nodesIn(tree).find((node) => node.children[1] === 'Send')!.children[0].disabled).toBe(false)
    expect(JSON.stringify(tree)).toContain('These limits govern automatic transfers.')
  })
  it('clears a failed balance read when the operator retries with Refresh', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('backend unavailable')).mockResolvedValue(overview)
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    expect(panel.error).toBe('backend unavailable')
    const refresh = nodesIn(panel.render(h)).find(
      (node) => node.tag === 'button.act' && node.children[1] === 'Refresh',
    )!
    await refresh.children[0].onclick()
    expect(panel.error).toBeNull()
    expect(panel.data).toEqual(overview)
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('groups labelled transfer fields separately from policy and gives empty history a next action', async () => {
    const panel = new RebalancePanel(vi.fn().mockResolvedValue(overview), vi.fn())
    await panel.refresh()
    const nodes = nodesIn(panel.render(h))
    const manual = nodes.find((node) => node.tag === 'div.wallet-manual')!
    expect(
      nodesIn(manual)
        .filter((node) => node.tag === 'label.wallet-field')
        .map((node) => node.children[0]),
    ).toEqual(['Destination pool', 'Deposit route', 'Minimum credit (sat)', 'Destination fee allowance (sat)'])
    const settings = nodes.find((node) => node.tag === 'details.wallet-policy')!
    expect(settings.children[0].open).toBe(false)
    expect(nodesIn(settings).some((node) => node.tag === 'fieldset.wallet-fieldset')).toBe(true)
    expect(JSON.stringify(nodes)).toContain('No transfers yet. Review a quote to start a transfer.')
  })
  it('keeps expanded policy and edits through a balance refresh without saving or enabling automation', async () => {
    const api = vi.fn().mockResolvedValue(overview)
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    const nodes = nodesIn(panel.render(h))
    nodes.find((node) => node.tag === 'details.wallet-policy')!.children[0].ontoggle({ target: { open: true } })
    const reserve = nodes.find(
      (node) => node.tag === 'label.wallet-field' && node.children[0] === 'Arkade reserve (sat)',
    )!
    reserve.children[1].children[0].oninput({ target: { value: '25000' } })
    await panel.refresh()
    const settings = nodesIn(panel.render(h)).find((node) => node.tag === 'details.wallet-policy')!
    expect(settings.children[0].open).toBe(true)
    expect(panel.policy.reserveSats).toBe('25000')
    expect(panel.policy.enabled).toBe(false)
    expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/rebalance', '/api/rebalance'])
  })

  it('shows the completed money path and links each identifier to the correct explorer', async () => {
    const sourceTxid = 'a'.repeat(64)
    const fundingTxid = 'b'.repeat(64)
    const address = 'bc1pdepositaddress'
    const transfer = {
      id: 'transfer-1',
      origin: 'automatic',
      poolId: 'rail:shared',
      state: 'completed',
      netSats: 500_000,
      debitSats: 500_500,
      feeSats: 500,
      creditedSats: 500_102,
      createdAt: 1_793_866_175,
      updatedAt: 1_793_866_593,
      inputs: [{ txid: sourceTxid, vout: 0, value: 7_779_649 }],
      fundingTxid,
      deposit: { kind: 'onchain', destination: address, amountSats: 500_300 },
    }
    const panel = new RebalancePanel(
      vi.fn().mockResolvedValue({ ...overview, transfers: [transfer] }),
      vi.fn(),
      () => ({ arkade: 'https://arkade.space', onchain: 'https://mempool.arkade.sh' }),
    )
    await panel.refresh()
    const row = nodesIn(panel.render(h)).find((node) => node.tag === 'li.wallet-transfer')!
    const rendered = JSON.stringify(row)
    expect(rendered).toContain('Arkade wallet')
    expect(rendered).toContain('shared pool')
    expect(rendered).toContain('From Arkade (up to)')
    expect(rendered).toContain('500,500 sat')
    expect(rendered).toContain('500,300 sat confirmed')
    expect(rendered).toContain('500,102 sat credited')
    expect(rendered).toContain('Fee limit')
    expect(rendered).toContain('500 sat')
    expect(rendered).not.toContain('398 sat paid')
    expect(rendered).toContain('Transfer ID')
    const links = nodesIn(row).filter((node) => node.tag === 'a')
    expect(links.map((node) => node.children[0].href)).toEqual([
      `https://arkade.space/tx/${sourceTxid}`,
      `https://mempool.arkade.sh/tx/${fundingTxid}`,
      `https://mempool.arkade.sh/address/${address}`,
    ])
    expect(links.every((node) => node.children[0].rel === 'noreferrer noopener')).toBe(true)
  })

  it('distinguishes a created quote from a send that actually started', async () => {
    const transfer = {
      id: 'transfer-before-send',
      origin: 'manual',
      poolId: 'rail:shared',
      state: 'quoted',
      kind: 'onchain',
      netSats: 500_000,
      debitSats: 500_500,
      feeSats: 500,
      createdAt: 1_793_866_175,
      chargedAt: undefined as number | undefined,
      inputs: [],
    }
    const panel = new RebalancePanel(vi.fn().mockResolvedValue({ ...overview, transfers: [transfer] }), vi.fn())
    await panel.refresh()
    const row = () => JSON.stringify(nodesIn(panel.render(h)).find((node) => node.tag === 'li.wallet-transfer'))
    for (const state of ['quoted', 'cancelled', 'failed']) {
      transfer.state = state
      expect(row()).toContain('Manual quote created')
      expect(row()).not.toContain('send started')
      expect(row()).not.toContain('transfer started')
    }
    transfer.state = 'pending'
    transfer.chargedAt = 1_793_866_200
    expect(row()).toContain('quote created')
    expect(row()).toContain('send started')
  })

  it('describes a Lightning refill as pending without inventing an explorer link for its invoice', async () => {
    const fundingTxid = 'c'.repeat(64)
    const transfer = {
      id: 'transfer-2',
      origin: 'manual',
      poolId: 'rail:shared',
      state: 'pending',
      netSats: 300_000,
      debitSats: 300_250,
      feeSats: 250,
      createdAt: 1_793_866_175,
      inputs: [],
      fundingTxid,
      deposit: { kind: 'lightning', destination: 'lnbc1notanexploreraddress' },
    }
    const panel = new RebalancePanel(
      vi.fn().mockResolvedValue({ ...overview, transfers: [transfer] }),
      vi.fn(),
      () => ({ arkade: 'https://arkade.space', onchain: 'https://mempool.arkade.sh' }),
    )
    await panel.refresh()
    const row = nodesIn(panel.render(h)).find((node) => node.tag === 'li.wallet-transfer')!
    const rendered = JSON.stringify(row)
    expect(rendered).toContain('On its way')
    expect(rendered).toContain('At least 300,000 sat expected')
    expect(rendered).toContain('Waiting for the destination to confirm the credit.')
    expect(rendered).not.toContain('sat credited')
    const links = nodesIn(row).filter((node) => node.tag === 'a')
    expect(links.map((node) => node.children[0].href)).toEqual([`https://arkade.space/tx/${fundingTxid}`])
    transfer.state = 'needs_reconciliation'
    const uncertain = JSON.stringify(nodesIn(panel.render(h)).find((node) => node.tag === 'li.wallet-transfer'))
    expect(uncertain).toContain('Credit unconfirmed')
    expect(uncertain).not.toContain('300,250 sat sent')
  })

  it('shows when the next automatic attempt can begin', async () => {
    const panel = new RebalancePanel(
      vi.fn().mockResolvedValue({
        ...overview,
        lastEvaluation: { reason: 'cooldown active', nextEligibleAt: 1_793_878_231 },
      }),
      vi.fn(),
    )
    await panel.refresh()
    const rendered = JSON.stringify(panel.render(h))
    expect(rendered).toContain('Automatic refill: cooldown active')
    expect(rendered).toContain('Next eligible')
    expect(rendered).toContain('UTC')
  })
})
