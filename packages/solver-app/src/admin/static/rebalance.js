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
        'label.wallet-field',
        label,
        h('input', {
          type,
          inputmode:
            type === 'text' && key !== 'solverPubkey' && key !== 'confirm' && key !== 'policyConfirm'
              ? 'numeric'
              : undefined,
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
      h(
        'div.wallet-section-heading',
        h('h2', 'Rebalance liquidity'),
        button('Refresh', () => {
          this.error = null
          return this.refresh()
        }),
      ),
      h(
        'p.muted',
        'Arkade funds replenish configured pools. Minimum credit and maximum source debit are checked before sending.',
      ),
    ]
    if (this.error) children.push(h('p.banner', { role: 'alert' }, this.error))
    if (!this.data)
      return h(
        'section.wallet-section',
        children,
        h('p.muted', this.error ? 'Rebalancing unavailable. Refresh to retry.' : 'Loading liquidity…'),
      )
    const pools = this.data.pools
    children.push(
      h(
        'div.wallet-pools',
        pools.map((p) =>
          h(
            'div.wallet-pool',
            h('span', p.label),
            h(
              'strong.wallet-number',
              p.balanceSats === null ? 'Unavailable' : `${Number(p.balanceSats).toLocaleString('en-US')} sat`,
            ),
            h('span.muted', `Routes: ${p.kinds.join(', ')}`),
            p.error ? h('p.banner', p.error) : null,
          ),
        ),
      ),
    )
    const select = (label, key, options) =>
      h(
        'label.wallet-field',
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
      h(
        'div.wallet-manual',
        h('h3', 'Move Arkade funds'),
        h('p.muted', 'Choose a destination and amount, then review the quote before sending.'),
        h(
          'div.wallet-form-grid',
          select(
            'Destination pool',
            'poolId',
            pools.map((p) => [p.id, p.label]),
          ),
          select('Deposit route', 'kind', [
            ['', 'Automatic · lowest bounded cost'],
            ['onchain', 'Onchain'],
            ['lightning', 'Lightning'],
          ]),
          field('Minimum credit (sat)', this.draft, 'amount'),
        ),
        h(
          'div.wallet-actions',
          button('Review quote', () => this.act('quote', this.quoteBody())),
        ),
      ),
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
          h(
            'div.wallet-confirm',
            field('Type quote ID to send', this.draft, 'confirm'),
            button('Send confirmed quote', () => this.act('submit', { id: quote.id, confirm: this.draft.confirm })),
          ),
        )
    }
    children.push(
      h(
        'div.wallet-history',
        h('h3', 'Transfer history'),
        transfers.length === 0
          ? h('p.wallet-empty', 'No transfers yet. Review a quote to start a transfer.')
          : transfers.map((t) =>
              h(
                'div.wallet-transfer',
                h(
                  'p',
                  `${t.id}: ${t.state}; minimum ${t.netSats} sat; debit ${t.debitSats} sat${t.creditedSats === undefined ? '' : `; credited ${t.creditedSats} sat`}${t.error ? ` — ${t.error}` : ''}`,
                ),
                t.state === 'quoted'
                  ? button('cancel unsubmitted quote', () => this.act('cancel', { id: t.id, confirm: t.id }))
                  : null,
              ),
            ),
      ),
    )
    const policy = this.policy
    const policyChildren = [
      h(
        'p.muted',
        'Refill pools when they fall below your minimum. Saving these settings also sets the spending limits for manual transfers.',
      ),
      h(
        'label.wallet-toggle',
        h('input', {
          type: 'checkbox',
          checked: policy.enabled,
          disabled: this.busy,
          onchange: (e) => {
            policy.enabled = e.target.checked
          },
        }),
        'Enable automatic rebalancing',
      ),
    ]
    const limits = []
    for (const [key, label] of Object.entries({
      reserveSats: 'Arkade reserve (sat)',
      maxDebitSats: 'Maximum debit per transfer (sat)',
      dailyDebitSats: 'Maximum debit per 24 hours (sat)',
      maxFeeSats: 'Maximum fees (sat)',
      maxFeeBps: 'Maximum fees (basis points)',
      minTransferSats: 'Minimum transfer (sat)',
      cooldownSeconds: 'Cooldown (seconds)',
    }))
      limits.push(field(label, policy, key))
    policyChildren.push(
      h('fieldset.wallet-fieldset', h('legend', 'Spending limits'), h('div.wallet-form-grid', limits)),
    )
    for (const pool of pools) {
      policy.targets[pool.id] ??= { minimumSats: '', targetSats: '' }
      policyChildren.push(
        h(
          'fieldset.wallet-fieldset',
          h('legend', pool.label),
          h(
            'div.wallet-form-grid',
            field('Refill below (sat)', policy.targets[pool.id], 'minimumSats'),
            field('Refill to (sat)', policy.targets[pool.id], 'targetSats'),
          ),
        ),
      )
    }
    policy.counterparty ??= { solverPubkey: '', relays: [] }
    policyChildren.push(
      h(
        'fieldset.wallet-fieldset',
        h('legend', 'External Lightning counterparty'),
        h('p.muted', 'Required for Lightning refills through an external solver.'),
        h(
          'div.wallet-form-grid',
          field('Solver public key', policy.counterparty, 'solverPubkey'),
          h(
            'label.wallet-field',
            'Relay URLs (one per line)',
            h(
              'textarea',
              {
                disabled: this.busy,
                rows: 3,
                oninput: (e) => {
                  policy.counterparty.relays = e.target.value.split(/\s+/).filter(Boolean)
                },
              },
              policy.counterparty.relays.join('\n'),
            ),
          ),
        ),
      ),
      h(
        'div.wallet-confirm',
        field('Type REBALANCE to save changes', this.draft, 'policyConfirm'),
        button('Save policy', () => this.savePolicy()),
      ),
    )
    children.push(
      h(
        'details.wallet-policy',
        {
          open: this.policyOpen ?? policy.enabled,
          ontoggle: (e) => {
            this.policyOpen = e.target.open
          },
        },
        h(
          'summary',
          'Automatic rebalancing & limits',
          h('span.phase', this.data.policy.enabled ? 'Enabled' : 'Disabled'),
        ),
        h('div.wallet-policy-body', policyChildren),
      ),
    )
    if (this.data.lastEvaluation)
      children.push(h('p.muted', `Last automatic evaluation: ${this.data.lastEvaluation.reason}`))
    return h('section.wallet-section', children)
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
