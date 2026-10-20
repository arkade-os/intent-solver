import { describe, expect, it, vi } from 'vitest'
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
  })
  it('renders a fee preview before submitting and sends the quote id the server checks', async () => {
    const quote = {
      id: 'quote-1',
      state: 'quoted',
      netSats: 123,
      feeSats: 5,
      debitSats: 128,
      kind: 'onchain',
      expiresAt: 2000000000,
    }
    const api = vi.fn().mockResolvedValue({ ...overview, transfers: [quote] })
    const panel = new RebalancePanel(api, vi.fn())
    await panel.refresh()
    panel.quote = quote
    const tree = panel.render(h)
    expect(JSON.stringify(tree)).toContain('fee upper bound 5 sat; source debit 128 sat')
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
    ['Deposit route', 'onchange'],
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
    ).toEqual(['Destination pool', 'Deposit route', 'Minimum credit (sat)'])
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
})
