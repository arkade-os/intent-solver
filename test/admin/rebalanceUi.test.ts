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
  it('renders a fee preview before submitting and sends the typed quote confirmation', async () => {
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
    const nodes: { tag: string; children: any[] }[] = []
    const walk = (node: any): void => {
      if (Array.isArray(node)) node.forEach(walk)
      else if (node?.tag) {
        nodes.push(node)
        node.children.forEach(walk)
      }
    }
    walk(tree)
    const label = nodes.find((node) => node.tag === 'label' && node.children[0] === 'type quote ID to send')!
    const input = label.children[1]
    input.children[0].oninput({ target: { value: 'quote-1' } })
    const send = nodes.find((node) => node.tag === 'button.act' && node.children[1] === 'send confirmed quote')!
    await send.children[0].onclick()
    expect(api.mock.calls[1]).toEqual([
      '/api/rebalance/submit',
      { method: 'POST', body: JSON.stringify({ id: 'quote-1', confirm: 'quote-1' }) },
    ])
  })
  it('keeps failures visible after refreshing transfer status', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('needs reconciliation')).mockResolvedValue(overview)
    const panel = new RebalancePanel(api, vi.fn())
    await panel.act('submit', { id: 'q1', confirm: 'q1' })
    expect(panel.error).toBe('needs reconciliation')
    expect(panel.data).toEqual(overview)
    expect(api.mock.calls[1]?.[0]).toBe('/api/rebalance')
  })
})
