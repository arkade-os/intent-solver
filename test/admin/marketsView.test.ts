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
    expect(appSource).toContain("['markets', 'markets']")
    expect(appSource).toContain("markets: () => '/api/markets'")
    expect(appSource).toContain('markets: marketsView')
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
    expect(block).toContain('toleranceBps: Number(d.toleranceBps)')
    expect(block).toContain('sellBase: draftBounds(d.sellBaseMin, d.sellBaseMax)')
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
      'Our margin, taken out of what the customer receives',
      'Bounds on what we pay out in this direction',
      'Our margin when the customer hands us the base asset',
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
    const block = marketsBlock()
    expect(block).toContain("'sellBaseFeeBps'")
    expect(block).toContain("'buyBaseFeeBps'")
  })

  it('carries the saved key on the draft, and keeps it off the wire body', () => {
    const block = marketsBlock()
    expect(block).toContain('marketKey: market.marketKey')
    const body = block.slice(block.indexOf('const marketBody'), block.indexOf('const field'))
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

  it('spends the amber only on a row under the break-even', () => {
    const block = marketsBlock()
    expect(block).toContain("loss ? '.loss' : ''")
    expect(block).toContain('const belowBreakEven =')
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
const previewHarness = (response: unknown) => {
  const pending: (() => void)[] = []
  const params = [
    'document',
    'Node',
    'api',
    'shortId',
    'ago',
    'state',
    'render',
    'load',
    'fail',
    'setTimeout',
    'clearTimeout',
  ]
  const body = `${helperBlock()}\n${marketsBlock()}
    marketDraft = { ...blankMarket(), marketKey: 'k' }
    return { previewPanel, refreshPreview, schedulePreview, marketsView }`
  const args = [
    stubDoc(),
    StubNode,
    async () => response,
    (value: unknown) => String(value),
    () => '1m',
    { data: { markets: { carrier: { sats: '330', rfqPriced: false, offerCharged: false }, markets: [] } } },
    () => {
      throw new Error('render() from the preview would eat the caret')
    },
    async () => {},
    () => {},
    (fn: () => void) => (pending.push(fn), pending.length),
    () => pending.pop(),
  ]
  try {
    const built = new Function(...params, body)(...args) as {
      previewPanel: () => StubNode
      refreshPreview: () => Promise<void>
      schedulePreview: () => void
      marketsView: () => StubNode
    }
    return { ...built, pending }
  } catch (error) {
    throw new Error('the preview moved out of the slice this guard reads', { cause: error })
  }
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

const painted = async (response: unknown): Promise<string> => {
  const panel = previewHarness(response)
  const node = panel.previewPanel()
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
      spreadFee: '500000000',
      marginBps: 50,
    },
  ],
  breakEven: { kind: 'none' },
  offerCeiling: null,
}

describe('the preview panel, run rather than grepped', () => {
  it('paints the amounts the server sent', async () => {
    const text = await painted(RESOLVED)
    expect(text).toContain('99,500')
    expect(text).toContain('50 bps')
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
    const text = await painted(RESOLVED)
    expect(text).toContain('1.00000000 BTC')
    expect(text).not.toContain('1.00000000 sats')
  })
})

describe('the markets view mounts what it builds', () => {
  it('renders the form and the preview panel side by side, not the panel alone', () => {
    const panel = previewHarness(RESOLVED)
    const text = textOf(panel.marketsView())
    expect(text).toContain('A pair may be configured once. Submitting one that exists edits it.')
    expect(text).toContain('preview — what a customer is quoted')
  })

  it('keeps the grid to exactly its declared rows — a stray wrapper silently breaks alignment', () => {
    const panel = previewHarness(RESOLVED)
    const grid = findByClass(panel.marketsView(), 'form-grid')
    expect(grid).not.toBeNull()
    // 16 field() rows x 3 + 3 two-child rows spanning 2/4 + 5 groups spanning 1/4.
    expect(grid!.childNodes.length).toBe(59)
  })
})
