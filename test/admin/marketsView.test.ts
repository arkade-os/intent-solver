/**
 * What the markets screen says, read from its source.
 *
 * `app.js` is a browser module with no exports and there is no DOM here, so this
 * reads the file — the approach `armedActions.test.ts` and `quotesView.test.ts`
 * already take, and for the same reason.
 *
 * The claims worth pinning are the honest ones. CRUD applies live; the notice
 * and the `active` list are how the screen says a stored row is this process's
 * serve list. A row that is stored but served by nothing is still the failure
 * this screen most easily produces.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// The REAL ordered-save client, not a stand-in: it is what turns the route's 200-carrying-`unapplied`
// into a throw, so a harness that stubbed it would be measuring its own mock rather than the seam.
import { applyPricing } from '../../packages/solver-app/src/admin/static/pricingSave.js'
import * as simpleMarket from '../../packages/solver-app/src/admin/static/simpleMarket.js'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

/**
 * The whole delimited markets block, both markers included.
 *
 * Bounded at both ends deliberately. A slice to end-of-file would let an
 * assertion be satisfied by unrelated code further down, which is how a guard
 * goes green while the thing it names is gone.
 */
const marketsBlock = (): string => {
  const start = appSource.indexOf('/* ==== asset markets — BEGIN')
  const end = appSource.indexOf('/* ==== asset markets — END')
  if (start === -1 || end === -1) throw new Error('the asset markets block is gone from app.js')
  return appSource.slice(start, end)
}

describe('the markets screen is reachable', () => {
  it('is in the nav, the endpoint table and the view table', () => {
    // All three, because two of the three renders a dead tab: a nav entry with
    // no body falls through to the overview and looks like a broken link.
    expect(appSource).toContain("['pricing', 'pricing']")
    expect(appSource).toContain("markets: () => '/api/markets'")
    expect(appSource).toContain('pricing: pricingView')
  })

  it('is exempt from the swap-event reload, like settings', () => {
    // A rebuild mid-typing hands back an input with no focus and a caret at
    // zero — the field looks fine and silently stops accepting characters,
    // which is worse than losing the text.
    expect(appSource).toContain("state.view !== 'markets'")
  })
})

describe('the screen does not let a stored market read as a live one', () => {
  it('shows the restart notice the API sends, standing rather than conditional', () => {
    expect(marketsBlock()).toContain('m.restartNotice')
  })

  it('distinguishes trading from not quoting, using the API’s active list', () => {
    const block = marketsBlock()
    expect(block).toContain('new Set(m.active)')
    expect(block).toMatch(/not quoting/)
    expect(block).toMatch(/trading/)
  })

  it('says what an empty list means, rather than showing a bare "none"', () => {
    // An empty markets table means this solver refuses every offer. Read as
    // "nothing configured yet" it looks like a setup step; read correctly it is
    // the current trading posture.
    expect(marketsBlock()).toMatch(/refuses every offer/)
  })
})

describe('the form does not fight the operator', () => {
  it('keeps the draft outside `state`, so typing does not re-render the console', () => {
    expect(marketsBlock()).toContain('let marketDraft = null')
  })

  it('writes each keystroke to the draft without rendering', () => {
    // `oninput` must not call render(): the input it typed into would be
    // replaced by a new node on every character.
    //
    // Bounded by the declaration that FOLLOWS, not by a brace — an unbounded
    // slice would run to the end of the block and pick up the edit button's
    // legitimate render(), which is how this assertion first went green for the
    // wrong reason.
    const block = marketsBlock()
    const start = block.indexOf('const field =')
    const end = block.indexOf('const saveMarket')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(block.slice(start, end)).not.toContain('render()')
  })

  /** `saveMarket` with every seam injected, so the draft it keeps or clears is observable.
   *
   *  `applyPricing` is the REAL ordered-save client, not a stand-in: a refusal arrives as a 200 whose
   *  body the client has to read, so a stubbed reader would assert the mock instead of the seam. */
  const savedWith = async (response: unknown, overrides: Record<string, string> = {}) => {
    const block = marketsBlock()
    const start = block.indexOf('const saveMarket')
    if (start === -1) throw new Error('saveMarket is gone from the markets block')
    const source = block.slice(start, block.indexOf('\n}', start) + 2)
    const sent: { path: string; body: string }[] = []
    const failures: string[] = []
    const built = new Function(
      'api',
      'marketBody',
      'carrierDefaultOverride',
      'state',
      'load',
      'fail',
      'applyPricing',
      `let marketDraft = { marketKey: 'k' }
       ${source}
       return async () => (await saveMarket(), marketDraft)`,
    ) as (...args: unknown[]) => () => Promise<unknown>
    const draft = await built(
      async (path: string, init: { body: string }) => (sent.push({ path, body: init.body }), response),
      (d: unknown) => d,
      () => overrides,
      { banner: 'x' },
      async () => {},
      (error: Error) => failures.push(error.message),
      applyPricing,
    )()
    return { draft, sent, failures }
  }

  it('saves through the ordered endpoint, not the single-market write', async () => {
    const { sent } = await savedWith(
      { revision: 'r', applied: ['k'], unapplied: [] },
      { ASSET_CARRIER_PRICING: 'true' },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.path).toBe('/api/pricing/apply')
    // Both halves ride ONE request: the ordering the route promises is a property of one save.
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      markets: [{ marketKey: 'k' }],
      overrides: { ASSET_CARRIER_PRICING: 'true' },
    })
  })

  // A refusal arrives INSIDE a 200 here, so status alone is not success.
  it('keeps the draft when the ordered save reports the market unapplied', async () => {
    const { draft, failures } = await savedWith({
      revision: 'r',
      applied: [],
      unapplied: [{ key: 'k', reason: 'the feed did not answer' }],
    })
    expect(draft).toEqual({ marketKey: 'k' })
    // The operator has to see which key was refused as well as why.
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('k')
    expect(failures[0]).toContain('the feed did not answer')
  })

  it('clears the draft when nothing is unapplied', async () => {
    const { draft, failures } = await savedWith({ revision: 'r', applied: ['k'], unapplied: [] })
    expect(draft).toBeNull()
    expect(failures).toEqual([])
  })

  it('leaves the form open when a write is refused', () => {
    // Every refusal names one field. Closing the form would make the operator
    // retype the other ten to fix it.
    const save = marketsBlock().slice(marketsBlock().indexOf('const saveMarket'))
    const body = save.slice(0, save.indexOf('\n}'))
    const failBranch = body.slice(body.indexOf('catch'))
    expect(failBranch).not.toContain('marketDraft = null')
  })
})

describe('the form speaks the API’s dialect', () => {
  it('sends bounds as strings and the small integers as numbers', () => {
    // An atomic-unit bound is a bigint; a JSON number would lose a ceiling past
    // 2^53 silently, and in the direction that widens it.
    const block = marketsBlock()
    expect(block).toContain('toleranceBps: draftInt(d.toleranceBps)')
    expect(block).toContain("sellBase: draftBounds(atomic('sellBaseMin', 'quote'), atomic('sellBaseMax', 'quote'))")
    expect(block).toMatch(/min: min\.trim\(\), max: max\.trim\(\)/)
  })

  it('omits a bound entirely unless both halves are filled', () => {
    // The server rejects a half-stated bound, so sending one would turn a blank
    // field into an error banner.
    expect(marketsBlock()).toContain("min.trim() === '' && max.trim() === '' ? null")
  })

  it('encodes the market key into the delete path', () => {
    // The key carries `/` and `:`; unencoded it would address a different route.
    expect(marketsBlock()).toContain('encodeURIComponent(key)')
  })
})

describe('the form is laid out rather than run together', () => {
  it('uses one grid for the whole form, not a toolbar per row', () => {
    const block = marketsBlock()
    expect(block).toContain("'div.form-grid'")
    expect(block).not.toContain('const field = (label, key, hint) =>')
  })

  it('carries a plain-English sentence for the fields that decide money', () => {
    const block = marketsBlock()
    for (const phrase of [
      'Our margin, taken out of what the client receives',
      'Bounds on what the client receives per swap',
      'Our margin for one direction only',
    ]) {
      expect(block).toContain(phrase)
    }
  })

  it('renders the sentence through a tooltip rather than as a second hint', () => {
    expect(marketsBlock()).toContain("h('span.tip'")
  })

  it('groups the fields, so the form reads as sections rather than a list', () => {
    expect(marketsBlock()).toContain("group('what we charge')")
  })

  it('renders an input for each per-direction spread, which #171 stored but never showed', () => {
    const panel = previewHarness(RESOLVED)
    const view = panel.marketsView()
    fire(labelled(view, 'BTC → asset fee bps'), 'input', { value: '20' })
    fire(labelled(view, 'asset → BTC fee bps'), 'input', { value: '35' })
    expect(panel.draft()).toMatchObject({ sellBaseFeeBps: '20', buyBaseFeeBps: '35' })
  })

  it('carries the saved key on the draft, and keeps it off the wire body', () => {
    const block = marketsBlock()
    expect(block).toContain('marketKey: market.marketKey')
    const body = block.slice(block.indexOf('const marketBody'), block.indexOf('const adoptSavedPair'))
    expect(body).not.toContain('marketKey')
  })

  it('declares schedulePreview exactly once, and as a `let` Task 11 can assign to', () => {
    const block = marketsBlock()
    expect(block).toContain('let schedulePreview')
    expect(block.match(/(?:let|const|var)\s+schedulePreview\b/g)).toHaveLength(1)
  })
})

describe('the preview styles spend no new colour', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/admin/static/styles.css', import.meta.url)),
    'utf8',
  )

  const previewCss = (): string => {
    const marker = '/* ---- the pricing editor'
    const at = css.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    return css.slice(at)
  }

  it('introduces no token outside the two saturated ones', () => {
    const block = previewCss()
    expect(block.match(/var\(--failed\)/g)).toBeNull()
    expect(block.match(/#[0-9a-fA-F]{3,6}/g)).toBeNull()
  })

  it('ships no rule this task does not render', () => {
    const block = previewCss()
    expect(block).not.toContain('.headline')
    expect(block).not.toContain('.lead')
    for (const cls of ['form-grid', 'tip']) expect(marketsBlock()).toContain(cls)
  })
})

describe('the preview panel', () => {
  it('posts to the preview route rather than reloading the markets list', () => {
    const block = marketsBlock()
    expect(block).toContain("'/api/pricing/preview'")
    expect(block).toContain("method: 'POST'")
  })

  it('never calls render() from the refresh path, which would eat the caret', () => {
    const block = marketsBlock()
    const start = block.indexOf('const refreshPreview')
    const end = block.indexOf('const previewPanel')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(block.slice(start, end)).not.toContain('render()')
  })

  it('debounces, so a held-down key is one request', () => {
    expect(marketsBlock()).toContain('clearTimeout(previewTimer)')
  })

  it('sends the saved key, which is how the server knows which feed to price against', () => {
    expect(marketsBlock()).toContain('marketKey: marketDraft.marketKey')
  })

  it('declares schedulePreview nowhere — Task 10 owns the binding', () => {
    expect(marketsBlock().match(/(?:let|const|var)\s+schedulePreview\b/g)).toHaveLength(1)
  })

  it('shows the carrier policy the console could not previously see', () => {
    const block = marketsBlock()
    expect(block).toContain('c.rfqPriced')
    expect(block).toContain('c.offerCharged')
    expect(block).toContain('rfqDirections')
  })

  it('says the RFQ directions and the carrier are read-only until the live-policy slice', () => {
    // Not /restart|environment/: `m.restartNotice` already matches that before
    // this task adds anything, which is how this first went green for free.
    expect(marketsBlock()).toContain('needs a restart')
  })
})

/** Instances of StubNode so `h`'s two `instanceof Node` checks take the element path. */
class StubNode {
  className = ''
  attrs: Record<string, string> = {}
  listeners: Record<string, unknown> = {}
  childNodes: StubNode[] = []
  constructor(
    readonly tagName: string,
    readonly text = '',
  ) {}
  get firstChild(): StubNode | null {
    return this.childNodes[0] ?? null
  }
  appendChild(child: StubNode): StubNode {
    this.childNodes.push(child)
    return child
  }
  removeChild(child: StubNode): StubNode {
    this.childNodes.splice(this.childNodes.indexOf(child), 1)
    return child
  }
  setAttribute(key: string, value: string): void {
    this.attrs[key] = value
  }
  addEventListener(type: string, fn: unknown): void {
    this.listeners[type] = fn
  }
}

const stubDoc = () => ({
  createElement: (tag: string) => new StubNode(tag),
  createTextNode: (text: string) => new StubNode('#text', text),
  // Nothing is mounted here, so the in-place form repaint finds no live form; morph.test.ts runs that path.
  querySelector: () => null,
})

const textOf = (node: StubNode): string => [node.text, ...node.childNodes.map(textOf)].join(' ')

const helperBlock = (): string => {
  const start = appSource.indexOf('/* ---- tiny element helper')
  const end = appSource.indexOf('/* ---- api ---')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('the element helper moved out of the slice this guard reads')
  }
  return appSource.slice(start, end)
}

// Same new-Function + named-error pattern as marketRoutes.test.ts:33-46: run rather than grepped.
const previewHarness = (
  response: unknown,
  draft: Record<string, unknown> = {},
  { label, knobs = [] }: { label?: Record<string, unknown>; knobs?: unknown[] } = {},
) => {
  const pending: (() => void)[] = []
  const sent: (string | undefined)[] = []
  const params = [
    'document',
    'Node',
    'api',
    'shortId',
    'ago',
    'sats',
    'state',
    'render',
    'load',
    'fail',
    'setTimeout',
    'clearTimeout',
    ...Object.keys(simpleMarket),
  ]
  const body = `${helperBlock()}\n${marketsBlock()}
    marketDraft = { ...blankMarket(), marketKey: 'k', ...${JSON.stringify(draft)} }
    return { previewPanel, refreshPreview, schedulePreview, marketsView, draft: () => marketDraft, marketBody }`
  const args = [
    stubDoc(),
    StubNode,
    async (path: string, init?: { body?: string }) => {
      sent.push(init?.body ?? path)
      if (path.startsWith('/api/assets/')) {
        // A macrotask, so a retry loop fails this test instead of starving the event loop.
        await new Promise((resolve) => setImmediate(resolve))
        if (label) return { assetId: path.slice('/api/assets/'.length), ...label }
        throw new Error('500')
      }
      return response
    },
    (value: unknown) => String(value),
    () => '1m',
    (value: unknown) => Number(value).toLocaleString('en-US'),
    {
      data: {
        markets: { carrier: { sats: '330', rfqPriced: false, offerCharged: false }, markets: [] },
        settings: { knobs },
      },
    },
    () => {
      throw new Error('render() from the preview would eat the caret')
    },
    async () => {},
    () => {},
    (fn: () => void) => (pending.push(fn), pending.length),
    () => pending.pop(),
    ...Object.values(simpleMarket),
  ]
  try {
    const built = new Function(...params, body)(...args) as {
      previewPanel: () => StubNode
      refreshPreview: () => Promise<void>
      schedulePreview: () => void
      marketsView: () => StubNode
      draft: () => Record<string, unknown>
      marketBody: (draft: Record<string, unknown>) => Record<string, unknown>
    }
    return { ...built, pending, sent }
  } catch (error) {
    throw new Error('the preview moved out of the slice this guard reads', { cause: error })
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const findAll = (node: StubNode, match: (node: StubNode) => boolean): StubNode[] => [
  ...(match(node) ? [node] : []),
  ...node.childNodes.flatMap((child) => findAll(child, match)),
]

/** The control inside the `p.toolbar` carrying `label`, with both halves pinned before either is indexed. */
const control = (root: StubNode, label: string, tag: string): StubNode => {
  const bars = findAll(root, (node) => node.className.split(' ').includes('toolbar') && textOf(node).includes(label))
  expect(bars, label).toHaveLength(1)
  const found = findAll(bars[0]!, (node) => node.tagName === tag)
  expect(found.length, `${label} ${tag}`).toBeGreaterThan(0)
  return found[0]!
}

const fire = (node: StubNode, type: string, target: unknown): void =>
  (node.listeners[type] as (event: unknown) => void)({ target })

/** The one control carrying this aria-label. */
const labelled = (root: StubNode, label: string): StubNode => {
  const found = findAll(root, (node) => node.attrs['aria-label'] === label)
  expect(found, label).toHaveLength(1)
  return found[0]!
}

/** First node in the tree whose class list contains `className`, DOM-order (self before children). */
const findByClass = (node: StubNode, className: string): StubNode | null => {
  if (node.className.split(' ').includes(className)) return node
  for (const child of node.childNodes) {
    const found = findByClass(child, className)
    if (found) return found
  }
  return null
}

/** Names a grid child by its own shape, so an unexpected one fails as itself rather than as a wrong total. */
const gridChildShape = (node: StubNode): string => {
  const classes = node.className.split(' ').filter(Boolean)
  if (node.tagName === 'input' && classes.length === 0) return 'input'
  for (const known of ['label', 'hint', 'group', 'span2']) {
    if (node.tagName === 'span' && classes.includes(known)) return `span.${known}`
  }
  return `unexpected child: ${[node.tagName, ...classes].join('.')}`
}

/** The panel after one answer, with `amount` typed as what the client sends, in whole units. */
const painted = async (response: unknown, amount = ''): Promise<string> => {
  const panel = previewHarness(response)
  const node = panel.previewPanel()
  if (amount) fire(labelled(node, 'amount the client sends'), 'input', { value: amount })
  await panel.refreshPreview()
  expect(node.childNodes.length).toBeGreaterThan(0)
  return textOf(node)
}

const RESOLVED = {
  invalid: [],
  direction: 'sell_base',
  side: 'from',
  legs: { from: 'BTC', to: 'USDX', fromDecimals: 8, toDecimals: 6 },
  carrier: { sats: '330', charged: '330', returned: '0', priced: true },
  feed: { state: 'resolved', mantissa: '100000', scale: 0, readAt: 1_000 },
  samples: [
    {
      ok: true,
      amount: '100000000',
      fromAmount: '100000000',
      toAmount: '99500000000',
      midPayout: '100000000000',
      spreadFee: '500000000',
      flatFee: '0',
      carrierCharged: '330',
      carrierReturned: '0',
      marginBps: 50,
    },
  ],
  breakEven: { kind: 'none' },
  offerCeiling: null,
}

describe('the preview panel, run rather than grepped', () => {
  it('paints the amounts the server sent for the amount the operator typed', async () => {
    const text = await painted(RESOLVED, '1')
    expect(text).toContain('99,500')
    expect(text).toContain('50 bps')
    expect(text).toContain('330 sats, paid by the client')
  })

  it('asks for the typed amount in atomic units, and prompts rather than inventing one', async () => {
    const panel = previewHarness(RESOLVED)
    const node = panel.previewPanel()
    await panel.refreshPreview()
    expect(JSON.parse(String(panel.sent.at(-1)))).not.toHaveProperty('amount')
    expect(textOf(node)).toContain('Type what the client sends')
    fire(labelled(node, 'amount the client sends'), 'input', { value: '0.5' })
    await panel.refreshPreview()
    expect(JSON.parse(String(panel.sent.at(-1)))).toMatchObject({ direction: 'sell_base', amount: '50000000' })
  })

  it('names a refusal in words and states the limits it broke', async () => {
    const refused = { ...RESOLVED, samples: [{ amount: '100000000', ok: false, reason: 'amount_out_of_range' }] }
    const panel = previewHarness(refused, { quoteDecimals: '6', sellBaseMin: '1', sellBaseMax: '9' })
    const node = panel.previewPanel()
    fire(labelled(node, 'amount the client sends'), 'input', { value: '1' })
    await panel.refreshPreview()
    expect(textOf(node)).toContain('outside the limits for this direction')
    expect(textOf(node)).toContain('the client may receive 1–9 asset')
  })

  it('spends the amber only on a result under the break-even', async () => {
    const receives = async (amountSats: string) => {
      const panel = previewHarness({ ...RESOLVED, breakEven: { kind: 'at', amountSats } })
      const node = panel.previewPanel()
      fire(labelled(node, 'amount the client sends'), 'input', { value: '1' })
      await panel.refreshPreview()
      return findAll(node, (row) => row.tagName === 'tr' && textOf(row).includes('client receives'))[0]!
    }
    expect((await receives('200000000')).className).toContain('loss')
    expect((await receives('66000')).className).not.toContain('loss')
  })

  it('says feed-unresolved rather than showing a stale ladder', async () => {
    const text = await painted({ invalid: [], samples: [], feed: { state: 'unresolved', reason: 'save this market' } })
    expect(text).toMatch(/feed-unresolved|save this market/)
    expect(text).not.toContain('99,500')
  })

  it('paints a break-even at a size, and none at all when there is none', async () => {
    expect(await painted({ ...RESOLVED, breakEven: { kind: 'at', amountSats: '66000' } })).toContain('66,000')
    expect(await painted(RESOLVED)).not.toMatch(/breaks even|loses money/)
  })

  it('says "never breaks even" instead of dividing by a zero spread', async () => {
    expect(await painted({ ...RESOLVED, breakEven: { kind: 'never' } })).toContain('never breaks even')
  })

  it('names what it does NOT model, so a green ladder is not read as a promise to fill', async () => {
    const text = await painted(RESOLVED)
    expect(text).toContain('does not check')
    for (const omission of ['inventory', 'rate limit', 'repeated request id']) {
      expect(text.toLowerCase()).toContain(omission)
    }
  })

  it('says why a closed direction has nothing to price, instead of a blank table', async () => {
    const text = await painted({ ...RESOLVED, samples: [], samplesReason: 'this direction is closed' })
    expect(text).toContain('this direction is closed')
  })

  it('collapses a held-down key into one pending request', () => {
    const panel = previewHarness(RESOLVED)
    panel.previewPanel()
    panel.schedulePreview()
    panel.schedulePreview()
    expect(panel.pending).toHaveLength(1)
  })

  it('carries the carrier sentence in plain language', () => {
    expect(marketsBlock()).toContain('rides on a small amount of bitcoin called the carrier')
  })

  it('labels a BTC leg as BTC, not sats — the amount is already decimals-formatted', async () => {
    const text = await painted(RESOLVED, '1')
    expect(text).toMatch(/1\.00000000\s*BTC/)
    expect(text).not.toContain('1.00000000 sats')
  })
})

describe('asset labels in the form', () => {
  it('asks once for an asset whose lookup fails, rather than re-asking on every repaint', async () => {
    const panel = previewHarness(RESOLVED, { quote: 'ab'.repeat(34) })
    panel.marketsView()
    await settle()
    expect(textOf(panel.marketsView())).toContain('asset lookup failed')
    expect(panel.sent.filter((sent) => sent?.startsWith('/api/assets/'))).toHaveLength(1)
  })
})

const USDA = 'aa'.repeat(34)
const LABEL = { ticker: 'usda', name: 'A Dollar', decimals: 6 }

describe('a new market fills what the lookup and the config know', () => {
  const typed = async (options: Parameters<typeof previewHarness>[2], draft: Record<string, unknown> = {}) => {
    const panel = previewHarness(RESOLVED, { marketKey: null, ...draft }, options)
    fire(labelled(panel.marketsView(), 'asset id'), 'input', { value: USDA })
    await settle()
    return panel
  }

  it('takes the decimals and the ticker from the issuer', async () => {
    const panel = await typed({ label: LABEL })
    expect(panel.draft()).toMatchObject({ quote: USDA, quoteDecimals: '6', symbol: 'USDA' })
    expect(textOf(panel.marketsView())).toContain("the issuer's ticker")
  })

  it('prefers the symbol the ASSET_MARKETS knob gives the asset', async () => {
    const panel = await typed({ label: LABEL, knobs: [{ key: 'ASSET_MARKETS', value: `USDK:${USDA}` }] })
    expect(panel.draft().symbol).toBe('USDK')
  })

  it('asks for decimals when the issuer published none, and never fills a saved row', async () => {
    const bare = await typed({ label: {} })
    expect(bare.draft()).toMatchObject({ quoteDecimals: '', symbol: '' })
    expect(textOf(bare.marketsView())).toContain('the issuer published no metadata — enter its decimals')
    const saved = previewHarness(RESOLVED, { quote: USDA, quoteDecimals: '8', symbol: '' }, { label: LABEL })
    saved.marketsView()
    await settle()
    expect(saved.draft()).toMatchObject({ quoteDecimals: '8', symbol: '' })
    expect(textOf(saved.marketsView())).toContain('issuer says 6, this form says 8')
  })

  it('never overwrites a value the operator typed', async () => {
    const panel = await typed({ label: LABEL }, { quoteDecimals: '2', symbol: 'MINE' })
    expect(panel.draft()).toMatchObject({ quoteDecimals: '2', symbol: 'MINE' })
  })

  it('prefills both limits once the feed answers, at two significant figures', async () => {
    const panel = await typed({ label: LABEL })
    panel.previewPanel()
    await panel.refreshPreview()
    expect(panel.marketBody(panel.draft())).toMatchObject({
      sellBase: { min: '10000000', max: '1000000000' },
      buyBase: { min: '10000', max: '1000000' },
    })
  })

  it('leaves a prefilled limit the operator cleared empty on the next answer', async () => {
    const panel = await typed({ label: LABEL })
    panel.previewPanel()
    await panel.refreshPreview()
    fire(labelled(panel.marketsView(), 'BTC → USDA min'), 'input', { value: '' })
    await panel.refreshPreview()
    expect(panel.draft()).toMatchObject({ sellBaseMin: '', sellBaseMax: '1000' })
  })
})

describe('the simple form writes the columns the server reads', () => {
  const ASSET_BASE = { base: USDA, quote: 'BTC', baseDecimals: '6', quoteDecimals: '8', symbol: 'USDA' }

  it('writes limits typed in whole units to the leg the client receives', () => {
    const btcBase = previewHarness(RESOLVED, { quote: USDA, quoteDecimals: '6', symbol: 'USDA' })
    let view = btcBase.marketsView()
    fire(labelled(view, 'BTC → USDA min'), 'input', { value: '10' })
    fire(labelled(view, 'BTC → USDA max'), 'input', { value: '20' })
    fire(labelled(view, 'USDA → BTC min'), 'input', { value: '0.001' })
    fire(labelled(view, 'USDA → BTC max'), 'input', { value: '0.01' })
    expect(btcBase.marketBody(btcBase.draft())).toMatchObject({
      sellBase: { min: '10000000', max: '20000000' },
      buyBase: { min: '100000', max: '1000000' },
    })

    const assetBase = previewHarness(RESOLVED, ASSET_BASE)
    view = assetBase.marketsView()
    fire(labelled(view, 'BTC → USDA min'), 'input', { value: '10' })
    fire(labelled(view, 'BTC → USDA max'), 'input', { value: '20' })
    fire(labelled(view, 'USDA → BTC min'), 'input', { value: '0.001' })
    fire(labelled(view, 'USDA → BTC max'), 'input', { value: '0.01' })
    expect(assetBase.marketBody(assetBase.draft())).toMatchObject({
      buyBase: { min: '10000000', max: '20000000' },
      sellBase: { min: '100000', max: '1000000' },
    })
  })

  it('keeps typed whole units when the decimals are corrected, and scales the wire by the new ones', () => {
    const panel = previewHarness(RESOLVED, { quote: USDA, quoteDecimals: '8', symbol: 'USDA' })
    const view = panel.marketsView()
    fire(labelled(view, 'BTC → USDA min'), 'input', { value: '10' })
    fire(labelled(view, 'BTC → USDA max'), 'input', { value: '1000' })
    fire(labelled(view, 'USDA → BTC flat fee'), 'input', { value: '1' })
    fire(findAll(view, (node) => node.attrs['aria-label'] === 'USDA decimals')[0]!, 'input', { value: '6' })
    expect(panel.draft()).toMatchObject({ sellBaseMin: '10', sellBaseMax: '1000', buyBaseFeeFlat: '1' })
    expect(panel.marketBody(panel.draft())).toMatchObject({
      quoteDecimals: 6,
      sellBase: { min: '10000000', max: '1000000000' },
      buyBaseFeeFlat: '1000000',
    })
  })

  it('switches each direction through its own rfq flag', () => {
    const btcBase = previewHarness(RESOLVED, { quote: USDA, symbol: 'USDA' })
    fire(labelled(btcBase.marketsView(), 'BTC → USDA open'), 'input', { checked: false })
    expect(btcBase.draft()).toMatchObject({ rfqSellBase: false, rfqBuyBase: true })
    const assetBase = previewHarness(RESOLVED, ASSET_BASE)
    fire(labelled(assetBase.marketsView(), 'BTC → USDA open'), 'input', { checked: false })
    expect(assetBase.draft()).toMatchObject({ rfqSellBase: true, rfqBuyBase: false })
  })

  it('takes a flat fee in the units of the leg the client gives, and sends 0 for blank', () => {
    const panel = previewHarness(RESOLVED, { quote: USDA, quoteDecimals: '6', symbol: 'USDA' })
    const view = panel.marketsView()
    fire(labelled(view, 'BTC → USDA flat fee'), 'input', { value: '0.0000033' })
    fire(labelled(view, 'USDA → BTC flat fee'), 'input', { value: '' })
    expect(panel.marketBody(panel.draft())).toMatchObject({ sellBaseFeeFlat: '330', buyBaseFeeFlat: '0' })

    const assetBase = previewHarness(RESOLVED, ASSET_BASE)
    const reversed = assetBase.marketsView()
    fire(labelled(reversed, 'BTC → USDA flat fee'), 'input', { value: '0.0000033' })
    fire(labelled(reversed, 'USDA → BTC flat fee'), 'input', { value: '1.5' })
    expect(assetBase.marketBody(assetBase.draft())).toMatchObject({ buyBaseFeeFlat: '330', sellBaseFeeFlat: '1500000' })
  })

  it('says who pays the carrier without a break-even claim the per-direction fees would make wrong', () => {
    const covered = { quote: USDA, quoteDecimals: '6', symbol: 'USDA', carrierMode: 'off', feeBps: '0' }
    const text = textOf(previewHarness(RESOLVED, { ...covered, sellBaseFeeFlat: '0.0000033' }).marketsView())
    expect(text).toContain('We pay the 330 sats on every BTC → USDA swap.')
    expect(text).not.toContain('never breaks even')
  })

  it('writes priced or off from the carrier switch, and inherit only from Advanced', () => {
    const panel = previewHarness(RESOLVED)
    const view = panel.marketsView()
    fire(labelled(view, 'the client pays the carrier'), 'input', { checked: false })
    expect(panel.draft().carrierMode).toBe('off')
    fire(labelled(view, 'follow the deployment default'), 'input', { checked: true })
    expect(panel.draft().carrierMode).toBe('inherit')
    fire(labelled(view, 'the client pays the carrier'), 'input', { checked: true })
    expect(panel.draft().carrierMode).toBe('priced')
  })
})

describe('the JSON path row', () => {
  const BINANCE = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'
  const pathHidden = (view: StubNode) =>
    findAll(view, (node) => node.className.includes('span2')).find(
      (node) => findAll(node, (input) => input.attrs['aria-label'] === 'json path').length > 0,
    )!.attrs.hidden !== undefined

  it('stays on screen while its path is cleared under a URL the path derives from', () => {
    const panel = previewHarness(RESOLVED, { feedUrl: BINANCE, pricePath: '/price' })
    expect(pathHidden(panel.marketsView())).toBe(false)
    fire(labelled(panel.marketsView(), 'json path'), 'input', { value: '' })
    expect(pathHidden(panel.marketsView())).toBe(false)
  })

  it('does not latch open on the first characters of a URL typed one key at a time', () => {
    const panel = previewHarness(RESOLVED)
    fire(labelled(panel.marketsView(), 'price feed url'), 'input', { value: 'h' })
    expect(pathHidden(panel.marketsView())).toBe(false)
    fire(labelled(panel.marketsView(), 'price feed url'), 'input', { value: BINANCE })
    const view = panel.marketsView()
    expect(pathHidden(view)).toBe(true)
    expect(findAll(view, (node) => node.tagName === 'button' && textOf(node).includes('set a JSON path'))).toHaveLength(
      1,
    )
  })

  it('opens on request, for a path other than the one the URL derives', () => {
    const panel = previewHarness(RESOLVED, { feedUrl: BINANCE })
    const view = panel.marketsView()
    expect(pathHidden(view)).toBe(true)
    const link = findAll(view, (node) => node.tagName === 'button' && textOf(node).includes('set a JSON path'))
    expect(link).toHaveLength(1)
    fire(link[0]!, 'click', {})
    expect(pathHidden(panel.marketsView())).toBe(false)
  })
})

describe('the markets view mounts what it builds', () => {
  it('renders the form and the preview panel side by side, not the panel alone', () => {
    const panel = previewHarness(RESOLVED)
    const text = textOf(panel.marketsView())
    expect(text).toContain('Limits')
    expect(text).toContain('preview — what a client is quoted')
  })

  it('holds only the five known row shapes — a stray wrapper fails by name, not by a moved total', () => {
    const panel = previewHarness(RESOLVED)
    const grid = findByClass(panel.marketsView(), 'form-grid')
    expect(grid).not.toBeNull()
    const unexpected = grid!.childNodes.map(gridChildShape).filter((shape) => shape.startsWith('unexpected child:'))
    expect(unexpected).toEqual([])
  })
})

describe('a serving control repaints the preview it sits beside', () => {
  // These came from a branch with no preview and the merge parked them next to one.
  const cases = [
    { label: 'answer RFQ quotes', find: (view: StubNode) => control(view, 'answer RFQ quotes', 'input') },
    { label: 'BTC → asset open', find: (view: StubNode) => labelled(view, 'BTC → asset open') },
    { label: 'the carrier switch', find: (view: StubNode) => labelled(view, 'the client pays the carrier') },
  ] as const

  it.each(cases)('reschedules the preview when $label changes', ({ find }) => {
    const panel = previewHarness(RESOLVED)
    const view = panel.marketsView()
    const before = panel.pending[0]
    expect(before).toBeTypeOf('function')

    fire(find(view), 'input', { checked: false })

    expect(panel.pending).toHaveLength(1)
    expect(panel.pending[0]).toBeTypeOf('function')
    expect(panel.pending[0]).not.toBe(before)
  })

  it('reprices against the new carrier mode, which moves the margin and the break-even', async () => {
    const panel = previewHarness(RESOLVED)
    const view = panel.marketsView()
    fire(labelled(view, 'the client pays the carrier'), 'input', { checked: false })
    await panel.refreshPreview()
    const body = JSON.parse(String(panel.sent.at(-1))) as { market: { carrierMode: string; servesRfq: boolean } }
    expect(body.market.carrierMode).toBe('off')

    fire(control(view, 'answer RFQ quotes', 'input'), 'input', { checked: false })
    await panel.refreshPreview()
    expect((JSON.parse(String(panel.sent.at(-1))) as typeof body).market.servesRfq).toBe(false)
  })
})
