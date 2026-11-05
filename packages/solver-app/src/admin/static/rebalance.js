const sats = (value) => (Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString('en-US')} sat` : '—')

const time = (value) =>
  Number.isSafeInteger(value) && value >= 0
    ? `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value * 1000))} UTC`
    : 'time unavailable'

const short = (value) => (value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value)

const explorerLink = (h, bases, chain, path, value, label) => {
  const base = bases?.[chain]
  if (
    typeof base !== 'string' ||
    !/^https?:\/\//.test(base) ||
    typeof value !== 'string' ||
    (path === 'tx' ? !/^[0-9a-f]{64}$/i.test(value) : !value.trim())
  )
    return null
  return h(
    'a',
    {
      href: `${base}/${path}/${encodeURIComponent(value.trim())}`,
      target: '_blank',
      rel: 'noreferrer noopener',
      title: value,
    },
    `${label} ${short(value)}`,
  )
}

const transferState = {
  quoted: ['Ready to send', '', 'Review the quote before sending.'],
  submitting: ['Sending', 'phase-exposed', 'The send has started. The destination credit may take time.'],
  pending: ['On its way', 'phase-exposed', 'Waiting for the destination to confirm the credit.'],
  needs_reconciliation: [
    'Needs checking',
    'phase-failed',
    'The send result is uncertain. Check this transfer before trying again.',
  ],
  completed: ['Arrived', 'phase-done', 'The destination confirmed the credit.'],
  refunded: ['Returned', 'quiet', 'The source funds were returned to Arkade.'],
  failed: ['Failed', 'quiet', 'This transfer did not complete.'],
  cancelled: ['Cancelled', 'quiet', 'Cancelled before sending.'],
}

export class RebalancePanel {
  constructor(api, redraw, explorers = () => null) {
    this.api = api
    this.redraw = redraw
    this.explorers = explorers
    this.data = null
    this.error = null
    this.busy = false
    this.loaded = false
    this.draft = { poolId: '', amount: '', kind: '', receivingFeeAllowanceSats: '1000' }
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
    if (action === 'quote') this.quote = null
    this.redraw()
    try {
      const answer = await this.api(`/api/rebalance/${action}`, { method: 'POST', body: JSON.stringify(body) })
      if (['quote', 'submit', 'cancel'].includes(action) && answer.result) {
        const result = answer.result
        if (action === 'quote' || this.quote?.id === result.id) this.quote = result
        if (this.data) {
          const exists = this.data.transfers.some((row) => row.id === result.id)
          this.data.transfers = exists
            ? this.data.transfers.map((row) => (row.id === result.id ? result : row))
            : [result, ...this.data.transfers]
        }
      }
      if (action === 'quote') {
        this.requestKey = null
      }
      if (action === 'policy') this.policy = structuredClone(answer.result)
    } catch (error) {
      this.error =
        action === 'quote' ? `Could not prepare a quote. No funds were sent. ${error.message}` : error.message
    } finally {
      this.busy = false
      await this.refresh()
    }
  }

  /** A quote prices the fields it was asked with; once one changes, Send waits for a fresh review. */
  invalidateQuote() {
    this.requestKey = null
    if (!this.quote) return
    this.quote = null
    this.redraw()
  }

  quoteBody() {
    this.requestKey ??= crypto.randomUUID()
    return {
      poolId: this.draft.poolId,
      amount: this.draft.amount,
      receivingFeeAllowanceSats: this.draft.receivingFeeAllowanceSats,
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
          inputmode: type === 'text' && key !== 'solverPubkey' ? 'numeric' : undefined,
          value: object[key] ?? '',
          disabled: this.busy,
          oninput: (e) => {
            object[key] = e.target.value
            if (object === this.draft && ['poolId', 'amount', 'kind', 'receivingFeeAllowanceSats'].includes(key))
              this.invalidateQuote()
          },
        }),
      )
    const button = (label, action) => h('button.act', { disabled: this.busy, onclick: action }, label)
    const children = [
      h(
        'div.wallet-section-heading',
        h(
          'h2',
          {
            title:
              'Arkade funds replenish configured pools. Minimum credit and maximum source debit are checked before sending.',
          },
          'Rebalance liquidity',
        ),
        button('Refresh', () => {
          this.error = null
          return this.refresh()
        }),
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
              this.invalidateQuote()
            },
          },
          options.map(([value, text]) => h('option', { value, selected: this.draft[key] === value }, text)),
        ),
      )
    children.push(
      h(
        'div.wallet-manual',
        h('h3', 'Move Arkade funds'),
        h('p.muted', 'Choose an amount, review the fees, then confirm the transfer.'),
        h(
          'div.wallet-form-grid',
          select(
            'Destination pool',
            'poolId',
            pools.map((p) => [p.id, p.label]),
          ),
          select('Deposit route', 'kind', [
            ['', 'Lowest quoted cost'],
            ['onchain', 'Onchain'],
            ['lightning', 'Lightning'],
          ]),
          field('Minimum credit (sat)', this.draft, 'amount'),
          field('Destination fee allowance (sat)', this.draft, 'receivingFeeAllowanceSats'),
        ),
        h(
          'p.muted',
          'The destination fee allowance covers receiving or claim fees. Any unused allowance is credited to the destination.',
        ),
        h(
          'div.wallet-actions',
          button('Review quote', () => this.act('quote', this.quoteBody())),
        ),
      ),
    )
    const transfers = this.data.transfers
    const quote = transfers.find((t) => t.id === this.quote?.id) ?? this.quote
    if (quote?.state === 'quoted') {
      const destination = pools.find((pool) => pool.id === quote.poolId)?.label ?? 'Backend wallet'
      const kind = quote.deposit?.kind ?? quote.kind
      const expired = Number.isSafeInteger(quote.expiresAt) && quote.expiresAt <= Date.now() / 1000
      children.push(
        h(
          'section.wallet-quote',
          h('h3', 'Review this transfer'),
          h('p.wallet-quote-route', h('span', 'Arkade wallet'), h('span', '→'), h('strong', destination)),
          h(
            'p.muted',
            kind === 'onchain'
              ? 'Via Bitcoin deposit'
              : kind === 'lightning'
                ? 'Via Lightning invoice'
                : 'Configured deposit route',
          ),
          h(
            'dl.wallet-transfer-amounts',
            h('div', h('dt', 'Minimum destination credit'), h('dd', sats(quote.netSats))),
            h('div', h('dt', 'Maximum total fees'), h('dd', sats(quote.feeSats))),
            Number.isSafeInteger(quote.deposit?.feeSats)
              ? h('div', h('dt', 'Destination fee allowance'), h('dd', sats(quote.deposit.feeSats)))
              : null,
            h('div', h('dt', 'Maximum Arkade debit'), h('dd', sats(quote.debitSats))),
          ),
          h(
            'p',
            'No funds have been sent. Send authorizes this quote’s maximum debit; the destination may receive more than the minimum.',
          ),
          h(
            'p.muted',
            expired
              ? 'This quote has expired. Review a new quote to continue.'
              : `Quote valid until ${time(quote.expiresAt)}.`,
          ),
          h(
            'div.wallet-confirm',
            h(
              'button.act',
              {
                disabled: this.busy || expired,
                onclick: () => this.act('submit', { id: quote.id, confirm: quote.id }),
              },
              'Send',
            ),
          ),
          h('p.wallet-transfer-id', 'Quote ID ', h('code', quote.id)),
        ),
      )
    }
    const bases = this.explorers()
    const transfer = (t) => {
      const destination = pools.find((pool) => pool.id === t.poolId)?.label ?? 'Backend wallet'
      const kind = t.deposit?.kind ?? t.kind
      const [label, phase, description] = transferState[t.state] ?? [t.state, '', '']
      const isDone = t.state === 'completed' && Number.isSafeInteger(t.creditedSats)
      const credit = isDone
        ? `${sats(t.creditedSats)} credited`
        : t.state === 'needs_reconciliation'
          ? 'Credit unconfirmed'
          : ['failed', 'cancelled', 'refunded'].includes(t.state)
            ? 'No destination credit'
            : `At least ${sats(t.netSats)} expected`
      const depositWord =
        t.state === 'completed'
          ? 'confirmed'
          : t.state === 'pending'
            ? 'submitted'
            : t.state === 'needs_reconciliation'
              ? 'unconfirmed'
              : t.state === 'refunded'
                ? 'previously submitted'
                : 'quoted'
      const links = []
      for (const [index, input] of (Array.isArray(t.inputs) ? t.inputs : []).entries()) {
        const link = explorerLink(h, bases, 'arkade', 'tx', input.txid, `Arkade source ${index + 1}`)
        if (link) links.push(link)
      }
      const funding = explorerLink(
        h,
        bases,
        kind === 'onchain' ? 'onchain' : 'arkade',
        'tx',
        t.fundingTxid,
        kind === 'onchain' ? 'Bitcoin transfer' : 'Arkade funding',
      )
      if (funding) links.push(funding)
      if (kind === 'onchain') {
        const address = explorerLink(h, bases, 'onchain', 'address', t.deposit?.destination, 'Deposit address')
        if (address) links.push(address)
      }
      const moments = [`${t.origin === 'automatic' ? 'Automatic' : 'Manual'} quote created ${time(t.createdAt)}`]
      if (Number.isSafeInteger(t.chargedAt)) moments.push(`send started ${time(t.chargedAt)}`)
      if (isDone) moments.push(`credit confirmed ${time(t.updatedAt)}`)
      else if (t.state === 'refunded') moments.push(`refund confirmed ${time(t.updatedAt)}`)
      return h(
        'li.wallet-transfer',
        h(
          'div.wallet-transfer-heading',
          h(
            'div.wallet-transfer-route',
            h('span', 'Arkade wallet'),
            h('span.wallet-transfer-arrow', '→'),
            h('strong', destination),
          ),
          h(`span.phase${phase ? `.${phase}` : ''}`, label),
        ),
        h(
          'p.wallet-transfer-meta',
          `${moments.join('; ')}. ${kind === 'onchain' ? 'Via Bitcoin deposit.' : kind === 'lightning' ? 'Via Lightning invoice.' : ''}`,
        ),
        h(
          'dl.wallet-transfer-amounts',
          h('div', h('dt', 'From Arkade (up to)'), h('dd', sats(t.debitSats))),
          kind === 'onchain' && Number.isSafeInteger(t.deposit?.amountSats)
            ? h('div', h('dt', 'Bitcoin deposit'), h('dd', `${sats(t.deposit.amountSats)} ${depositWord}`))
            : null,
          h('div', h('dt', `To ${destination}`), h('dd', credit)),
          h('div', h('dt', 'Fee limit'), h('dd', sats(t.feeSats))),
        ),
        description ? h('p.wallet-transfer-description', description) : null,
        t.error ? h('p.banner', { role: 'alert' }, t.error) : null,
        links.length ? h('div.wallet-transfer-links', links) : null,
        h('p.wallet-transfer-id', 'Transfer ID ', h('code', t.id)),
        t.state === 'quoted' ? button('Cancel', () => this.act('cancel', { id: t.id, confirm: t.id })) : null,
      )
    }
    children.push(
      h(
        'div.wallet-history',
        h('h3', 'Transfer history'),
        transfers.length === 0
          ? h('p.wallet-empty', 'No transfers yet. Review a quote to start a transfer.')
          : h('ol.wallet-transfer-list', transfers.map(transfer)),
      ),
    )
    const policy = this.policy
    const policyChildren = [
      h('p.notice', 'These limits also govern manual transfers.'),
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
      h('fieldset.wallet-fieldset', h('legend', 'Automatic spending limits'), h('div.wallet-form-grid', limits)),
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
        h(
          'legend',
          { title: 'Required for Lightning refills through an external solver.' },
          'External Lightning counterparty',
        ),
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
          {
            title: 'Refill pools when they fall below your minimum.',
          },
          'Automatic rebalancing',
          h('span.phase', this.data.policy.enabled ? 'Enabled' : 'Disabled'),
        ),
        h('div.wallet-policy-body', policyChildren),
      ),
    )
    if (this.data.lastEvaluation) {
      const evaluation = this.data.lastEvaluation
      children.push(
        h(
          'p.muted',
          `Automatic refill: ${evaluation.reason}${Number.isSafeInteger(evaluation.nextEligibleAt) ? ` Next eligible ${time(evaluation.nextEligibleAt)}.` : ''}`,
        ),
      )
    }
    return h('section.wallet-section', children)
  }

  savePolicy() {
    try {
      void this.act('policy', { policy: this.policyPayload(), confirm: 'REBALANCE' })
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
