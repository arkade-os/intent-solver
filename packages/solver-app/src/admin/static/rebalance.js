export class RebalancePanel {
  constructor(api, redraw) {
    this.api = api
    this.redraw = redraw
    this.data = null
    this.error = null
    this.busy = false
    this.loaded = false
    this.draft = { poolId: '', amount: '', kind: '', confirm: '', policyConfirm: '' }
    this.policy = null
    this.requestKey = null
  }

  async refresh() {
    if (this.busy) return
    this.loaded = true
    try {
      this.data = await this.api('/api/rebalance')
      if (!this.policy) this.policy = structuredClone(this.data.policy)
      if (!this.draft.poolId) this.draft.poolId = this.data.pools[0]?.id ?? ''
    } catch (error) {
      this.error = error.message
    }
    this.redraw()
  }

  async act(action, body) {
    if (this.busy) return
    this.busy = true
    this.error = null
    this.redraw()
    try {
      const answer = await this.api(`/api/rebalance/${action}`, { method: 'POST', body: JSON.stringify(body) })
      if (action === 'quote') {
        this.quote = answer.result
        this.draft.confirm = ''
        this.requestKey = null
      }
      if (action === 'policy') this.policy = structuredClone(answer.result)
    } catch (error) {
      this.error = error.message
    } finally {
      this.busy = false
      await this.refresh()
    }
  }

  quoteBody() {
    this.requestKey ??= crypto.randomUUID()
    return {
      poolId: this.draft.poolId,
      amount: this.draft.amount,
      requestKey: this.requestKey,
      ...(this.draft.kind ? { kind: this.draft.kind } : {}),
    }
  }

  render(h) {
    if (!this.loaded) void this.refresh()
    const field = (label, object, key, type = 'text') =>
      h(
        'label',
        label,
        h('input', {
          type,
          value: object[key] ?? '',
          disabled: this.busy,
          oninput: (e) => {
            object[key] = e.target.value
            if (object === this.draft && ['poolId', 'amount', 'kind'].includes(key)) this.requestKey = null
          },
        }),
      )
    const button = (label, action) => h('button.act', { disabled: this.busy, onclick: action }, label)
    const children = [
      h('h2', 'rebalance backend liquidity'),
      h(
        'p.muted',
        'Arkade funds replenish configured pools. Minimum credit and maximum source debit are checked before sending.',
      ),
      button('refresh rebalancing', () => this.refresh()),
    ]
    if (this.error) children.push(h('p.banner', this.error))
    if (!this.data)
      return h('section.panel', children, h('p.muted', this.loaded ? 'Rebalancing unavailable.' : 'loading…'))
    const pools = this.data.pools
    children.push(
      h(
        'ul',
        pools.map((p) =>
          h(
            'li',
            `${p.label}: ${p.balanceSats === null ? 'unreadable' : `${p.balanceSats} sat`} (${p.kinds.join(', ')})`,
            p.error ? ` — ${p.error}` : '',
          ),
        ),
      ),
    )
    const select = (label, key, options) =>
      h(
        'label',
        label,
        h(
          'select',
          {
            disabled: this.busy,
            onchange: (e) => {
              this.draft[key] = e.target.value
              this.requestKey = null
            },
          },
          options.map(([value, text]) => h('option', { value, selected: this.draft[key] === value }, text)),
        ),
      )
    children.push(
      select(
        'destination pool',
        'poolId',
        pools.map((p) => [p.id, p.label]),
      ),
      select('deposit route', 'kind', [
        ['', 'auto (lowest bounded cost)'],
        ['onchain', 'onchain'],
        ['lightning', 'lightning'],
      ]),
      field('minimum credit (sat)', this.draft, 'amount'),
      button('prepare quote', () => this.act('quote', this.quoteBody())),
    )
    const transfers = this.data.transfers
    const quote = transfers.find((t) => t.id === this.quote?.id) ?? this.quote
    if (quote) {
      children.push(
        h(
          'p.notice',
          `Quote ${quote.id}: minimum credit ${quote.netSats} sat; fee upper bound ${quote.feeSats} sat; source debit ${quote.debitSats} sat; ${quote.kind}; expires ${new Date(quote.expiresAt * 1000).toISOString()}`,
        ),
      )
      if (quote.state === 'quoted')
        children.push(
          field('type quote ID to send', this.draft, 'confirm'),
          button('send confirmed quote', () => this.act('submit', { id: quote.id, confirm: this.draft.confirm })),
        )
    }
    children.push(
      h('h3', 'transfer history'),
      transfers.map((t) =>
        h(
          'div',
          h(
            'p',
            `${t.id}: ${t.state}; minimum ${t.netSats} sat; debit ${t.debitSats} sat${t.creditedSats === undefined ? '' : `; credited ${t.creditedSats} sat`}${t.error ? ` — ${t.error}` : ''}`,
          ),
          t.state === 'quoted'
            ? button('cancel unsubmitted quote', () => this.act('cancel', { id: t.id, confirm: t.id }))
            : null,
        ),
      ),
    )
    const policy = this.policy
    children.push(
      h('h3', 'automatic policy'),
      h(
        'label',
        h('input', {
          type: 'checkbox',
          checked: policy.enabled,
          disabled: this.busy,
          onchange: (e) => {
            policy.enabled = e.target.checked
          },
        }),
        'enable automatic rebalancing',
      ),
    )
    for (const [key, label] of Object.entries({
      reserveSats: 'Arkade reserve (sat)',
      maxDebitSats: 'maximum debit per transfer (sat)',
      dailyDebitSats: 'maximum debit per 24 hours (sat)',
      maxFeeSats: 'maximum fees (sat)',
      maxFeeBps: 'maximum fees (basis points)',
      minTransferSats: 'minimum transfer (sat)',
      cooldownSeconds: 'cooldown (seconds)',
    }))
      children.push(field(label, policy, key))
    for (const pool of pools) {
      policy.targets[pool.id] ??= { minimumSats: '', targetSats: '' }
      children.push(
        h('h4', pool.label),
        field('minimum trigger (sat)', policy.targets[pool.id], 'minimumSats'),
        field('refill target (sat)', policy.targets[pool.id], 'targetSats'),
      )
    }
    policy.counterparty ??= { solverPubkey: '', relays: [] }
    children.push(
      field('external solver public key', policy.counterparty, 'solverPubkey'),
      h(
        'label',
        'relay URLs (one per line)',
        h(
          'textarea',
          {
            disabled: this.busy,
            oninput: (e) => {
              policy.counterparty.relays = e.target.value.split(/\s+/).filter(Boolean)
            },
          },
          policy.counterparty.relays.join('\n'),
        ),
      ),
      field('type REBALANCE to save any policy change', this.draft, 'policyConfirm'),
      button('save confirmed policy', () => this.savePolicy()),
    )
    if (this.data.lastEvaluation)
      children.push(h('p.muted', `Last automatic evaluation: ${this.data.lastEvaluation.reason}`))
    return h('section.panel', children)
  }

  savePolicy() {
    try {
      void this.act('policy', { policy: this.policyPayload(), confirm: this.draft.policyConfirm })
    } catch (error) {
      this.error = error.message
      this.redraw()
    }
  }

  policyPayload() {
    const whole = (value) => {
      const text = String(value)
      const number = Number(text)
      if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(number))
        throw new Error('Policy values must be whole nonnegative safe integers.')
      return number
    }
    const policy = structuredClone(this.policy)
    for (const key of [
      'reserveSats',
      'maxDebitSats',
      'dailyDebitSats',
      'maxFeeSats',
      'maxFeeBps',
      'minTransferSats',
      'cooldownSeconds',
    ])
      policy[key] = whole(policy[key])
    for (const [id, target] of Object.entries(policy.targets)) {
      if (target.minimumSats === '' && target.targetSats === '') {
        delete policy.targets[id]
        continue
      }
      for (const key of ['minimumSats', 'targetSats']) target[key] = whole(target[key])
    }
    if (!policy.counterparty.solverPubkey && !policy.counterparty.relays.length) delete policy.counterparty
    return policy
  }
}
