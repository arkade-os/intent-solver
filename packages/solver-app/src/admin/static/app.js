/**
 * Solver console client.
 *
 * No framework and no build step. `h()` below is ~20 lines and the whole page
 * re-renders on every change, which is the right trade for a dashboard whose
 * data arrives on a two-second SSE tick: there is no state to reconcile, no
 * diffing to get wrong, and nothing to vendor. A framework here would be more
 * bytes than the application.
 *
 * The one rule the styling encodes, restated because it drives the markup:
 * COLOUR IS RESERVED FOR RISK. `phase` is rendered as the primary chip and the
 * corridor's own `state` word sits beside it in muted text — never the other
 * way round. `claimed` is terminal success on the two send corridors and
 * money-still-out on the two receive corridors, so the word alone would show a
 * finished-looking row for a swap that is still at risk.
 */

/* ---- tiny element helper ------------------------------------------------ */

/** h('td.num', 'text') | h('div', {onclick}, child, child) */
const h = (spec, ...rest) => {
  const [tag, ...classes] = String(spec).split('.')
  const node = document.createElement(tag || 'div')
  if (classes.length) node.className = classes.join(' ')
  let children = rest
  const first = rest[0]
  if (first && typeof first === 'object' && !(first instanceof Node) && !Array.isArray(first)) {
    for (const [key, value] of Object.entries(first)) {
      if (value === undefined || value === null || value === false) continue
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
      else if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ')
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    children = rest.slice(1)
  }
  const append = (child) => {
    if (child === null || child === undefined || child === false) return
    if (Array.isArray(child)) return child.forEach(append)
    // Text is appended as a text node, never as innerHTML: every value here is
    // operator-supplied or backend-supplied and none of it is trusted markup.
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  children.forEach(append)
  return node
}

const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/* ---- api ---------------------------------------------------------------- */

/**
 * Every request funnels through here so a failure becomes a visible banner
 * rather than a console message nobody is looking at. An operator who cannot
 * see that a request failed will assume it succeeded.
 */
const api = async (path, options) => {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { 'content-type': 'application/json' } : undefined,
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `${response.status} ${response.statusText}`)
    error.body = body
    error.status = response.status
    throw error
  }
  return body
}

/* ---- formatting --------------------------------------------------------- */

const sats = (value) => (value === null || value === undefined ? '—' : `${Number(value).toLocaleString('en-US')}`)

const shortId = (value) => (typeof value === 'string' && value.length > 14 ? `${value.slice(0, 10)}…` : (value ?? '—'))

const ago = (unixSeconds) => {
  if (!unixSeconds) return '—'
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds)
  if (delta < 60) return `${delta}s`
  if (delta < 3600) return `${Math.floor(delta / 60)}m`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`
  return `${Math.floor(delta / 86400)}d`
}

const duration = (seconds) => {
  if (!seconds && seconds !== 0) return '—'
  const d = Math.floor(seconds / 86400)
  const hrs = Math.floor((seconds % 86400) / 3600)
  const min = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${hrs}h` : hrs > 0 ? `${hrs}h ${min}m` : `${min}m`
}

/**
 * The Arkade wallet's balance is an object whose keys vary by SDK version, so
 * it is rendered generically rather than destructured — but as labelled sat
 * figures, not `JSON.stringify`. The raw dump wrapped mid-token in the panel
 * and made a number an operator reads at a glance unreadable.
 */
const balanceRows = (balance) => {
  if (balance === null || typeof balance !== 'object') return h('span.muted', '—')
  const entries = Object.entries(balance).filter(([, v]) => typeof v === 'number')
  if (entries.length === 0) return h('span.muted', '—')
  return h(
    'span',
    entries.map(([key, value], index) =>
      h('span', index > 0 ? h('span.faint', ' · ') : null, h('span.muted', `${key} `), sats(value)),
    ),
  )
}

/* ---- assets (block owned by the asset work) ----------------------------- */

/**
 * An asset's identity: the id, with a ticker in front of it when one is known.
 *
 * THE ID IS THE IDENTITY. A ticker is metadata the issuer chose — optional, and
 * not unique — so two different assets may both call themselves the same thing.
 * Shown as the identity it would let an operator confirm they hold something
 * they do not. The full id is on the title so it can be read and copied without
 * spending a line of the panel on 64 characters of hex.
 */
const assetLabel = (asset) =>
  h(
    'span',
    asset.ticker ? h('span', asset.ticker, ' ') : null,
    h('span.faint', { title: asset.assetId }, asset.shortId),
  )

/**
 * What the solver holds in Arkade assets, and what it could pay out of RIGHT NOW.
 *
 * TWO NUMBERS, NOT ONE, whenever they differ. An offer fill is decided against
 * `availableAssets`; `assets` also counts holdings that are gated, intent-locked
 * or awaiting recovery. Showing only the total is how an operator concludes they
 * can cover a fill that would fail at submission after the maker was told yes.
 *
 * Amounts are BASE UNITS, matching what an offer names, and are strings because
 * an asset supply overflows a double. `decimals` rides alongside as a label
 * rather than being applied, so nothing here is a number an operator could
 * compare against a taker's request and be wrong by a power of ten.
 */
const assetRows = (balance) => {
  if (balance === null || typeof balance !== 'object') return null
  const held = Array.isArray(balance.assets) ? balance.assets : []
  if (held.length === 0) return null
  const available = new Map(
    (Array.isArray(balance.availableAssets) ? balance.availableAssets : []).map((a) => [a.assetId, a.amount]),
  )
  return h(
    'span',
    held.map((asset, index) => {
      const spendable = available.get(asset.assetId) ?? '0'
      return h(
        'span',
        index > 0 ? h('span.faint', ' · ') : null,
        assetLabel(asset),
        ' ',
        h('span', spendable),
        spendable === asset.amount ? null : h('span.muted', ` of ${asset.amount} held`),
        typeof asset.decimals === 'number' && asset.decimals > 0 ? h('span.faint', ` (${asset.decimals}dp)`) : null,
      )
    }),
  )
}

/**
 * The `assets` row of a `dl.kv`, or nothing at all when no asset is held.
 *
 * Returns the pair so the row disappears entirely for a sats-only solver rather
 * than showing an empty label — most operators never hold one, and a permanent
 * blank row is a question they have to re-answer on every glance.
 */
const assetRowsPair = (balance) => {
  const rows = assetRows(balance)
  return rows ? [h('dt', 'assets'), h('dd', rows)] : []
}

/* ---- end assets block --------------------------------------------------- */

/** Corridor label short enough for a table cell. */
const corridorLabel = (corridor) =>
  ({
    'arkade:BTC->lightning:BTC': 'ark→ln',
    'lightning:BTC->arkade:BTC': 'ln→ark',
    'arkade:BTC->onchain:BTC': 'ark→L1',
    'onchain:BTC->arkade:BTC': 'L1→ark',
  })[corridor] ?? corridor

/** The chip. Phase first, always. */
const phaseChip = (phase) => h(`span.phase.phase-${phase}`, phase)

/**
 * How a state READS to a human, next to the name the row actually carries.
 *
 * `paid` is the one that had to change. It means "payment id known, preimage
 * maybe not" — the backend accepted the payment and gave us something to poll —
 * and it says nothing about the payee having been paid. An operator reading
 * `paid -> stuck` sees a contradiction that is not there, and the reading that
 * follows ("we paid, so do not refund") is the opposite of what that row needs.
 *
 * The raw name stays visible: it is what the logs, the API and the database all
 * say, and an operator comparing against those must see the same token.
 */
const STATE_READS = {
  funded: 'lockup seen, nothing paid yet',
  paying: 'payment may be in flight — nothing known',
  paid: 'backend accepted it — outcome NOT known',
  // The first state that PROVES anything. The only way in is
  // `claimWithPreimage`, which refuses unless sha256(P) matches the payment
  // hash — and a valid P exists only if the payee revealed it. So this, not
  // `paid`, is where the payment settled.
  claiming: 'SETTLED — preimage proves it; collecting the lockup',
  claimed: 'done — settled and collected',
  stuck: 'needs a human',
  refused: 'never funded, nothing moved',
}

/**
 * The reading for a state, given what the ROW says happened.
 *
 * `stuck` is the one that has to look at the row: a swap whose refund was
 * pushed has nothing outstanding, and telling an operator it "needs a human"
 * sends them looking for work that is already done. New rows now close as
 * `refused` instead — but rows that reached `stuck` before that keep the state
 * they were written with, and those are exactly the ones being read today.
 */
const stateRead = (state, raw) =>
  state === 'stuck' && raw?.refundOutcome ? 'client refunded — parked, nothing outstanding' : STATE_READS[state]

const stateWord = (state, raw) => {
  const gloss = stateRead(state, raw)
  return h(`span.state${state === 'stuck' ? ' state-stuck' : ''}`, state, gloss ? h('span.faint', ` (${gloss})`) : null)
}

/**
 * What the last `read-payment` on THIS swap concluded, and what it licenses.
 *
 * The console has the answer already — `read-payment` returns a verdict naming
 * refund-versus-claim outright — and until now it printed it and left the
 * operator to match it against five equal-looking buttons. This turns the
 * verdict into which button is SUPPORTED, so the wrong one has to be overridden
 * rather than merely regretted.
 *
 * Null when no read has been made for this swap, which is treated the same as
 * an undecided one: nothing is supported, so both money actions ask.
 */
const readVerdict = (swapId) => {
  const r = state.result
  if (!r || r.name !== 'read-payment' || r.forSwap !== swapId) return null
  const v = r.result?.verdict
  if (typeof v !== 'string') return null
  // `never-submitted` only licenses a refund when the backend CONFIRMED it
  // holds nothing. With the probe unavailable it is a weaker claim than it
  // sounds, and the row may be one whose hash is registered with no commitment.
  const refundOk = v === 'not-paid-refund-is-safe' || (v === 'never-submitted' && r.result?.commitment === 'none')
  return { verdict: v, supports: { 'refund-now': refundOk, 'claim-now': v === 'paid-do-not-refund' } }
}

/* ---- application state -------------------------------------------------- */

const state = {
  view: 'overview',
  overview: null,
  banner: null,
  data: {},
  filters: { corridor: '', phase: '', q: '' },
  detail: null,
  dialog: null,
  /** The action currently in flight, or null. See `runAction`. */
  running: null,
  /** The last action's outcome, shown inline until dismissed or the view changes. */
  result: null,
}

const VIEWS = [
  ['overview', 'overview'],
  ['swaps', 'swaps'],
  ['quotes', 'quotes'],
  ['wallet', 'wallet'],
  ['backends', 'backends'],
  ['diagnostics', 'diagnostics'],
  ['discovery', 'discovery'],
  ['settings', 'settings'],
  ['markets', 'markets'],
  ['audit', 'audit'],
]

const fail = (error) => {
  state.banner = error instanceof Error ? error.message : String(error)
  render()
}

/* ---- status bar --------------------------------------------------------- */

const statusBar = () => {
  const o = state.overview
  if (!o) return h('div.status', h('span.muted', 'connecting…'))
  const exposed = o.exposure.exposedCount
  const pct = o.exposure.capSats ? Math.min(100, (o.exposure.committedSats / o.exposure.capSats) * 100) : 0
  return h(
    'div.status',
    h('span', h('b', o.mode), ' ', h('span.faint', o.network)),
    h('span', h('span.muted', 'up '), duration(o.uptimeSeconds)),
    h(
      'span',
      h('span.muted', 'committed '),
      sats(o.exposure.committedSats),
      h('span.faint', ' / '),
      sats(o.exposure.capSats),
      ' ',
      h('span.faint', `(${pct.toFixed(0)}%)`),
    ),
    // The number an operator is actually looking for, and the only coloured
    // thing in the bar.
    exposed > 0
      ? h('span.at-risk', `${exposed} exposed`)
      : h('span.muted', `${o.exposure.liveCount} live, none exposed`),
    // Rows waiting on a HUMAN, in the one place an operator always looks.
    //
    // `stuck` is terminal and excluded from every sweep, so nothing else will
    // ever raise its hand: not the exposed count (a stuck row is no longer
    // live), not a log line (it was printed once, days ago). One sat unnoticed
    // for four days holding 50,151 sats, and it was found by someone happening
    // to open the row.
    //
    // Rendered only when non-zero. A permanent "0 stuck" trains the eye to skip
    // the position, which is exactly where the number needs to be seen.
    o.attention?.stuckCount ? h('span.at-risk', `${o.attention.stuckCount} stuck — needs you`) : null,
  )
}

/* ---- theme -------------------------------------------------------------- */

/**
 * Follow the OS unless the operator said otherwise.
 *
 * A console gets opened on whichever machine is nearest, so the OS preference is
 * the right default. The override is for when that machine is wrong — a dark
 * laptop carried into a bright room — and it persists, because being asked twice
 * is the same as not being asked.
 */
const THEME_KEY = 'solver-console-theme'

const savedTheme = () => {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : null
  } catch {
    // Locked-down profiles and some private modes throw on localStorage. Falling
    // back to the OS is a fine answer; failing to render the console is not.
    return null
  }
}

const preferredTheme = () => savedTheme() ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

/**
 * Apply WITHOUT recording. Dark is `:root`, so the attribute is removed rather
 * than set to a value no rule matches.
 */
const setTheme = (theme) => {
  if (theme === 'light') document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme
}

/**
 * Apply AND record — only from an explicit toggle.
 *
 * Split from `setTheme` on purpose: writing the OS-derived value on first load
 * would freeze it, so a machine that later switched to light would stay dark
 * forever having never been asked.
 */
const chooseTheme = (theme) => {
  setTheme(theme)
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // See savedTheme: the console still works, the choice just will not survive.
  }
}

const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

// Before the first paint, so the console never flashes the wrong ground.
setTheme(preferredTheme())

const nav = () =>
  h(
    'nav',
    VIEWS.map(([id, label]) =>
      h('button', { 'aria-current': String(state.view === id), onclick: () => go(id) }, label),
    ),
    h('span.spacer'),
    h(
      'button.theme',
      {
        title: `Switch to ${currentTheme() === 'light' ? 'dark' : 'light'} mode. Follows your system until you pick one.`,
        onclick: () => (chooseTheme(currentTheme() === 'light' ? 'dark' : 'light'), render()),
      },
      currentTheme() === 'light' ? 'dark mode' : 'light mode',
    ),
  )

/* ---- views -------------------------------------------------------------- */

/**
 * The rows waiting on a human, at the top of the page they land on.
 *
 * Clickable through to the row, because "3 stuck" without a way to reach them
 * is a nag rather than a tool — and the thing an operator needs next is
 * `read payment`, which lives on the detail dialog.
 *
 * Absent entirely when there are none. A permanently-rendered empty panel is
 * how a page teaches you to stop reading that part of it.
 */
const attentionPanel = (o) => {
  const stuck = o.attention?.stuck ?? []
  if (stuck.length === 0) return null
  // A plain panel, deliberately. `.at-risk` is `--exposed` on `--ground`, and
  // a panel is `--raised` — a pair the contrast test has not declared, and
  // `test/admin/contrast.test.ts` is explicit that adding one is a statement
  // that the combination now renders. The coloured alarm already lives in the
  // status bar, on a pair that IS proven; this panel only has to say WHICH.
  return h(
    'section.panel',
    h('h2', `${stuck.length} swap${stuck.length === 1 ? '' : 's'} need you`),
    h(
      'p.muted',
      'Terminal, and excluded from every sweep — these will wait indefinitely. ' +
        'Open one and use read payment before pushing anything.',
    ),
    h(
      'table',
      h(
        'tbody',
        ...stuck.map((row) =>
          h(
            'tr',
            // `openDetail` takes the row and reads `corridor`/`id` off it —
            // both of which the attention projection already carries.
            { onclick: () => openDetail(row), style: 'cursor:pointer' },
            h('td.muted', ago(row.updatedAt)),
            h('td', corridorLabel(row.corridor)),
            h('td', sats(row.amountSats)),
            h('td.faint', row.failureReason ?? ''),
          ),
        ),
      ),
    ),
  )
}

const overviewView = () => {
  const o = state.overview
  if (!o) return h('p.muted', 'loading…')
  return h(
    'div',
    attentionPanel(o),
    h(
      'div.panels',
      ...o.corridors.map((c) =>
        h(
          'section.panel',
          h('h2', corridorLabel(c.corridor)),
          h(
            'dl.kv',
            h('dt', 'serving'),
            h('dd', c.enabled ? 'yes' : h('span.muted', 'no')),
            h('dt', 'fee'),
            h('dd', `${c.fee.bps} bps + ${sats(c.fee.flatSats)} sat`),
            h('dt', 'range'),
            h('dd', `${sats(c.limits.minSats)} – ${sats(c.limits.maxSats)}`),
            h('dt', 'live'),
            h('dd', String(c.liveCount)),
            h('dt', 'exposed'),
            h('dd', c.exposedCount > 0 ? h('span.at-risk', String(c.exposedCount)) : '0'),
          ),
        ),
      ),
      h(
        'section.panel',
        h('h2', 'exposure'),
        h(
          'div.bar' + (o.exposure.exposedCount > 0 ? '.at-risk' : ''),
          h('span', {
            style: `width:${o.exposure.capSats ? Math.min(100, (o.exposure.committedSats / o.exposure.capSats) * 100) : 0}%`,
          }),
        ),
        h('p.muted', `${sats(o.exposure.committedSats)} of ${sats(o.exposure.capSats)} sat cap`),
      ),
      h(
        'section.panel',
        h('h2', 'balances'),
        h(
          'dl.kv',
          h('dt', 'lightning'),
          h(
            'dd',
            o.balances.lightningError ? h('span.muted', o.balances.lightningError) : sats(o.balances.lightningSats),
          ),
          h('dt', 'arkade'),
          h('dd', o.balances.arkadeError ? h('span.muted', o.balances.arkadeError) : balanceRows(o.balances.arkade)),
          /* assets: begin */
          ...(o.balances.arkadeError ? [] : assetRowsPair(o.balances.arkade)),
          /* assets: end */
          h('dt', 'pubkey'),
          h('dd.faint', shortId(o.providerPubkey)),
        ),
      ),
    ),
  )
}

const swapsView = () => {
  const rows = state.data.swaps?.swaps ?? []
  return h(
    'div',
    h(
      'div.toolbar',
      h(
        'select',
        {
          onchange: (e) => {
            state.filters.corridor = e.target.value
            load('swaps')
          },
        },
        h('option', { value: '', selected: state.filters.corridor === '' }, 'all corridors'),
        ...[
          'arkade:BTC->lightning:BTC',
          'lightning:BTC->arkade:BTC',
          'arkade:BTC->onchain:BTC',
          'onchain:BTC->arkade:BTC',
        ].map((c) => h('option', { value: c, selected: state.filters.corridor === c }, corridorLabel(c))),
      ),
      h(
        'select',
        {
          onchange: (e) => {
            state.filters.phase = e.target.value
            load('swaps')
          },
        },
        h('option', { value: '', selected: state.filters.phase === '' }, 'any phase'),
        ...['open', 'exposed', 'done', 'failed'].map((p) =>
          h('option', { value: p, selected: state.filters.phase === p }, p),
        ),
      ),
      h('input.search', {
        type: 'search',
        value: state.filters.q,
        placeholder: 'find: id, payment hash, invoice, address, txid, rfq id',
        title: `Substring match across every identifier the row carries. At least ${MIN_SEARCH} characters.`,
        // `input`, not `change`: an operator pasting a txid expects the table to
        // answer, not to have to press enter. Debounced because every keystroke
        // is a query across four stores.
        oninput: (e) => {
          state.filters.q = e.target.value
          clearTimeout(searchTimer)
          searchTimer = setTimeout(() => load('swaps'), SEARCH_DEBOUNCE_MS)
        },
      }),
      state.filters.q.trim().length > 0 && state.filters.q.trim().length < MIN_SEARCH
        ? h('span.faint', `${MIN_SEARCH - state.filters.q.trim().length} more character(s) to search`)
        : null,
      h('span.spacer'),
      h('span.muted', `${rows.length} rows`),
    ),
    rows.length === 0
      ? h('p.muted', 'no swaps match')
      : h(
          'table',
          h(
            'thead',
            h(
              'tr',
              h('th', 'phase'),
              h('th', 'state'),
              h('th', 'corridor'),
              h('th', 'id'),
              h('th.right', 'amount'),
              h('th.right', 'payout'),
              h('th', 'age'),
              h('th', 'updated'),
            ),
          ),
          h(
            'tbody',
            rows.map((row) =>
              h(
                'tr.clickable',
                { onclick: () => openDetail(row) },
                // Phase first and state second, deliberately: see the module header.
                h('td', phaseChip(row.phase)),
                h('td', stateWord(row.state)),
                h('td.muted', corridorLabel(row.corridor)),
                h('td.faint', shortId(row.id)),
                h('td.num', sats(row.amountSats)),
                h('td.num.muted', sats(row.payoutSats)),
                h('td.muted', ago(row.createdAt)),
                h('td.muted', ago(row.updatedAt)),
              ),
            ),
          ),
        ),
  )
}

const quotesView = () => {
  const d = state.data.quotes
  if (!d) return h('p.muted', 'loading…')
  return h(
    'div',
    h('h2.sans', 'open quotes'),
    // Said plainly, for the same reason the bid notice below is: an empty list
    // here means "nothing is WAITING", not "nothing has been quoted". A quote
    // is a swap in `quoted` state — `insertQuote` writes the row, there is no
    // separate quote store — so a funded one leaves this list within seconds
    // and lives under swaps, and an expired or refused one goes terminal and
    // drops off entirely. Reading "no quotes" as "no demand" is exactly the
    // wrong conclusion, and it is the one an operator actually drew.
    h('p.notice', 'Quotes still awaiting funding. Once funded they move to swaps; expired or refused ones drop off.'),
    d.quoted.length === 0
      ? h('p.muted', 'nothing awaiting funding right now — funded and refused quotes are under swaps')
      : h(
          'table',
          h('thead', h('tr', h('th', 'corridor'), h('th', 'id'), h('th.right', 'amount'), h('th', 'age'))),
          h(
            'tbody',
            d.quoted.map((row) =>
              h(
                'tr.clickable',
                { onclick: () => openDetail(row) },
                h('td.muted', corridorLabel(row.corridor)),
                h('td.faint', shortId(row.id)),
                h('td.num', sats(row.amountSats)),
                h('td.muted', ago(row.createdAt)),
              ),
            ),
          ),
        ),
    h('h2.sans', 'recent open-RFQ bids'),
    // Said plainly, because an empty list here means "nothing since boot", not
    // "this solver has made no bids" — and reading the second from the first
    // would be exactly the wrong conclusion about a quiet market.
    h('p.notice', `Held in memory only and cleared on restart (keeps the last ${d.bids.capacity}).`),
    d.bids.entries.length === 0
      ? h('p.muted', 'no bids recorded since this process started')
      : h(
          'table',
          h('thead', h('tr', h('th', 'pair'), h('th.right', 'amount'), h('th.right', 'bps'), h('th', 'age'))),
          h(
            'tbody',
            d.bids.entries.map((bid) =>
              h(
                'tr',
                h('td.muted', bid.pair),
                h('td.num', sats(bid.amountSats)),
                h('td.num', String(bid.feeBps)),
                h('td.muted', ago(bid.at)),
              ),
            ),
          ),
        ),
  )
}

/* ---- fund sources: BEGIN ------------------------------------------------- */
/* Self-contained: this block plus one `fundsPanel()` call inside `walletView`. */

/**
 * A quantity in a source's own base units, grouped only when that is safe.
 *
 * The seam carries amounts as STRINGS because an ERC20 quantity is 256-bit and
 * routinely past what a JS number holds exactly. Grouping goes through `Number`,
 * so it is applied only where the value round-trips: a grouped-but-wrong figure
 * is worse than an ungrouped right one on a screen someone funds a wallet from.
 */
const fundAmount = (raw) => {
  if (raw === null || raw === undefined) return '—'
  const n = Number(raw)
  return Number.isSafeInteger(n) && String(n) === String(raw) ? n.toLocaleString('en-US') : String(raw)
}

/**
 * Run one of the fund actions and keep its answer next to the source it is about.
 *
 * Its OWN slice rather than the shared `state.result`, because two of these
 * answers are strings an operator copies — a deposit address above all — and the
 * result banner truncates at 160 characters. A silently shortened address is a
 * send to nowhere, which is the one failure this panel exists to avoid.
 *
 * `state.data.funds*` survives every reload: `load()` only writes keys named
 * after a view, and there is no `funds` view.
 *
 * A refusal is kept IN the panel rather than raised as a page banner. Most of
 * them are policy answers, not faults — "this source has no way to pay an
 * arbitrary destination", "no BTC rail on this deployment" — and the red banner
 * would read as a broken console.
 */
const fundAction = async (name, source) => {
  if (state.running) return
  state.running = { name, forSwap: null }
  render()
  try {
    const response = await api(`/api/actions/${name}`, { method: 'POST', body: JSON.stringify({ source }) })
    state.banner = null
    state.data.fundRead = { source, name, result: response.result, error: null }
  } catch (error) {
    state.data.fundRead = { source, name, result: null, error: error instanceof Error ? error.message : String(error) }
  } finally {
    state.running = null
    render()
  }
}

/**
 * Which sources this deployment has, and what each holds.
 *
 * Two round trips because they answer different questions and fail
 * independently: the catalogue decides which panels and buttons exist at all,
 * while a balance is a backend read that can be down without taking the panel
 * with it.
 */
const loadFunds = async () => {
  try {
    const catalogue = await api('/api/actions/fund-sources', { method: 'POST', body: JSON.stringify({}) })
    const sources = catalogue.result?.sources ?? []
    const balances = {}
    for (const source of sources) {
      try {
        const read = await api('/api/actions/fund-balance', {
          method: 'POST',
          body: JSON.stringify({ source: source.id }),
        })
        balances[source.id] = { balance: read.result, error: null }
      } catch (error) {
        // Per source, so one unreachable backend leaves the others readable —
        // and so "this one is down" reads as itself rather than as the whole
        // page failing.
        balances[source.id] = { balance: null, error: error instanceof Error ? error.message : String(error) }
      }
    }
    state.data.funds = { sources, balances, error: null }
  } catch (error) {
    state.data.funds = { sources: [], balances: {}, error: error instanceof Error ? error.message : String(error) }
  }
  render()
}

/**
 * Collect a destination and an amount, then hand both to the ordinary armed
 * dialog.
 *
 * `window.prompt` for the same reason `editKnob` uses it: the whole page
 * re-renders on a two-second stream tick, so a form field living in the tree
 * would be rebuilt out from under whoever is typing into it.
 *
 * The `override` argument is the second gate. It renders the source, amount and
 * destination back as a banner with a checkbox that must be ticked before the
 * confirm box does anything — so the operator sees what they are about to send
 * spelled out, and then has to type the address itself. The server checks that
 * address independently; this is the part that stops a reflex.
 */
const fundWithdraw = (source) => {
  const typed = window.prompt(
    `Withdraw from ${source.label} to which address?\n\nThis leaves the solver and cannot be undone.`,
  )
  if (typed === null) return
  const address = typed.trim()
  if (!address) return
  const raw = window.prompt(`How much (${source.unit}) to ${address}?`)
  if (raw === null) return
  const amount = String(raw).trim()
  if (!amount) return
  return armDialog(
    'fund-withdraw',
    { source: source.id, address, amount },
    `About to send ${fundAmount(amount)} ${source.unit} from ${source.label} to ${address}. It is irreversible, ` +
      'and each attempt is a separate payment.',
  )
}

/**
 * The figure rows, FLAT — a `dt` and a `dd` per figure, never a wrapper.
 *
 * `.kv` is a two-column grid and its grid items are its direct children, so
 * pairing each label with its value inside one element collapses the whole list
 * into a single stacked column. `h()` flattens nested arrays when appending,
 * which is what makes the flat pairs work without a fragment.
 *
 * A figure that could not be read carries the reason INSTEAD of a number, never
 * a zero beside it: unreachable and empty must not look the same on the screen
 * where someone decides whether to send more money.
 */
const fundFigureRows = (balance) =>
  balance.figures.flatMap((f) => [
    h('dt', f.label),
    h(
      'dd',
      f.amount === null ? h('span.sans', f.note ?? '—') : `${fundAmount(f.amount)} ${balance.unit}`,
      f.amount !== null && f.note ? h('span.faint', ` ${f.note}`) : null,
    ),
  ])

/**
 * ONE way into a source, rendered so the choice between them is legible.
 *
 * The options are not interchangeable and the differences are the whole reason
 * more than one is offered: an Arkade address is float on arrival while its
 * boarding address needs a settlement first, and a Lightning invoice is instant
 * but stops working. An operator picking between them needs the speed, the
 * chore and the deadline in front of them, which a `JSON.stringify` dump — what
 * this used to be — technically contains and nobody reads.
 *
 * EXPIRY IS A BANNER, not a faint note, once it has passed. A paid-too-late
 * invoice fails at the payer's node with an error that names none of this, so
 * the console has to be the thing that says the string is dead.
 *
 * It recomputes on every render, which is necessary and NOT sufficient: the
 * stream's `swaps` event is the only other thing that renders, and that is an
 * activity signal rather than a clock. `armExpiryTick` is what makes the banner
 * actually arrive on an idle deployment — see its comment for why a page that
 * rebuilds itself on a timer needs three guards to be safe.
 */
const fundDepositOption = (option) => {
  const left = option.expiresAt === undefined ? null : option.expiresAt - Math.floor(Date.now() / 1000)
  return h(
    'div',
    h(
      'p.sans',
      h('strong', option.addressKind),
      // Absent means "any amount". Rendered only when the option is BOUND to
      // one, because a payer node refuses a different amount and the number has
      // to travel with the string rather than be assumed.
      option.amountSats === undefined ? null : h('span.faint', ` · ${sats(option.amountSats)} sats`),
      left === null || left <= 0 ? null : h('span.faint', ` · expires in ${left < 60 ? '<1m' : duration(left)}`),
    ),
    left !== null && left <= 0
      ? h('p.banner', 'Expired — this will be refused. Press the button again for a fresh one.')
      : null,
    // Untruncated and selectable: an address is copied by hand as often as by
    // button, and a shortened one is a send to nowhere.
    h('pre.faint', option.address),
    h(
      'p.muted.sans',
      option.settleRequired
        ? 'Not spendable until it is settled. '
        : 'Spendable on arrival — nothing to run afterwards. ',
      option.note ?? '',
    ),
  )
}

/**
 * The answer to `fund-deposit-address`, or whatever else a fund action returned.
 *
 * Shape-checked rather than switched on the action name, because only one of
 * these answers has a render and the rest are small enough to read as JSON. An
 * empty list is a case the server distinguishes and so does this: a source that
 * declared the capability and produced nothing is a fault, and rendering it as
 * blank space would leave an operator clicking a button that appears to do
 * nothing.
 */
const fundResult = (read) => {
  if (read.error) return h('pre.faint', read.error)
  const options = read.result?.options
  if (!Array.isArray(options)) return h('pre.faint', JSON.stringify(read.result, null, 2))
  if (options.length === 0)
    return h('p.banner', 'This source offered no way to deposit. That is a fault, not a policy.')
  return h('div', options.map(fundDepositOption))
}

/**
 * One source: what it holds, and only the buttons it can honour.
 *
 * The buttons come from `can`, which the server derives from which optional
 * methods the source implements. Drawing one the source cannot perform would put
 * a click in front of an operator that is guaranteed to fail — and on this
 * screen "cannot" and "is broken" must not look the same.
 */
const fundSourcePanel = (source, slot) => {
  const read = state.data.fundRead?.source === source.id ? state.data.fundRead : null
  return h(
    'section.panel',
    h('h2', source.label),
    slot?.error ? h('p.banner', slot.error) : slot?.balance ? h('dl.kv', fundFigureRows(slot.balance)) : null,
    read ? fundResult(read) : null,
    h(
      'div.toolbar',
      source.can.deposit
        ? actButton(
            'button.act',
            { 'data-action': 'fund-deposit-address', onclick: () => fundAction('fund-deposit-address', source.id) },
            // PLURAL, because every source that has one has more than one and
            // the singular label read as "here is the address" — which sent an
            // operator holding VTXOs out to L1 to wait for a settlement.
            'deposit options',
          )
        : null,
      source.can.settle
        ? actButton(
            'button.act',
            { 'data-action': 'fund-settle-deposits', onclick: () => fundAction('fund-settle-deposits', source.id) },
            'settle deposits',
          )
        : null,
      source.can.withdraw
        ? actButton(
            'button.act.armed',
            { 'data-action': 'fund-withdraw', onclick: () => fundWithdraw(source) },
            'withdraw…',
          )
        : null,
    ),
  )
}

/**
 * Every place this solver holds its own money, and how to move it.
 *
 * Lazily loaded rather than folded into the wallet view's own fetch: this is two
 * round trips per source and the wallet page reloads on every stream tick, so
 * hanging it off that cadence would re-read every backend every two seconds.
 */
const fundsPanel = () => {
  const f = state.data.funds
  if (f === undefined) {
    // Marked before the fetch so the re-render this triggers does not fire a
    // second one.
    state.data.funds = { sources: [], balances: {}, error: null, loading: true }
    void loadFunds()
    return h('section.panel', h('h2', 'funding'), h('p.muted', 'loading…'))
  }
  return h(
    'div',
    h('h2.sans', 'funding'),
    // The honest headline, and the reason no button here is called "fund
    // lightning". Neither the Lightning port nor the onchain one has a channel
    // primitive, so a deposit lands in a wallet and becomes channel liquidity
    // only if someone opens a channel with it at the node.
    h(
      'p.notice',
      'Deposits and withdrawals move a source’s own wallet. Nothing here opens Lightning channels, so inbound and ' +
        'outbound capacity still change only at the node itself.',
    ),
    f.error ? h('p.banner', f.error) : null,
    h(
      'div.panels',
      f.sources.map((source) => fundSourcePanel(source, f.balances[source.id])),
    ),
    h(
      'div.toolbar',
      actButton('button.act', { 'data-action': 'fund-balance', onclick: () => loadFunds() }, 're-read balances'),
    ),
  )
}

/* ---- fund sources: END --------------------------------------------------- */

const walletView = () => {
  const w = state.data.wallet
  if (!w) return h('p.muted', 'loading…')
  const pool = w.arkade.pool
  return h(
    'div',
    h(
      'div.panels',
      h(
        'section.panel',
        h('h2', 'arkade'),
        h(
          'dl.kv',
          h('dt', 'address'),
          h('dd.faint', w.arkade.addressError ? h('span.muted', w.arkade.addressError) : (w.arkade.address ?? '—')),
          h('dt', 'balance'),
          h('dd', w.arkade.balanceError ? h('span.muted', w.arkade.balanceError) : balanceRows(w.arkade.balance)),
          /* assets: begin */
          ...(w.arkade.balanceError ? [] : assetRowsPair(w.arkade.balance)),
          /* assets: end */
        ),
      ),
      h(
        'section.panel',
        h('h2', 'lightning'),
        h(
          'dl.kv',
          h('dt', 'available'),
          h('dd', w.lightning.error ? h('span.muted', w.lightning.error) : sats(w.lightning.balance?.availableSats)),
          h('dt', 'incoming'),
          h('dd', w.lightning.error ? h('span.muted', '—') : sats(w.lightning.balance?.incomingSats)),
        ),
      ),
      h(
        'section.panel',
        h('h2', 'onchain'),
        h(
          'dl.kv',
          h('dt', 'fee rate'),
          h('dd', w.onchain.error ? h('span.muted', w.onchain.error) : `${w.onchain.feeRate} sat/vB`),
        ),
      ),
    ),
    /* fund sources: the one call into the block above. */
    fundsPanel(),
    h('h2.sans', 'vtxo pool'),
    // The number that actually constrains throughput: funding pins the coins it
    // spends, so one fat coin funds one swap and refuses the next however large.
    h('p.notice', 'How many swaps this float can fund AT ONCE — not how many sats it holds.'),
    w.arkade.poolError
      ? h('p.banner', w.arkade.poolError)
      : pool
        ? h(
            'div',
            h('p', `${pool.pieces.length} piece(s): `, h('span.faint', pool.pieces.slice(0, 16).map(sats).join('  '))),
            h('p.muted', pool.plan.reason),
            /* assets: begin — why the pieces above add up to less than the balance */
            pool.assetEncumberedSats
              ? h(
                  'p.muted',
                  `${sats(pool.assetEncumberedSats)} sat across ${pool.assetBearingPieces} piece(s) cannot fund a swap: ` +
                    'those sats are carrying an asset, and an asset has to ride on sats.',
                )
              : null,
            /* assets: end */
            h(
              'div.toolbar',
              actButton(
                'button.act',
                { 'data-action': 'pool-plan', onclick: () => runAction('pool-plan', {}) },
                're-plan (read-only)',
              ),
              actButton(
                'button.act.armed',
                { 'data-action': 'pool-mint', onclick: () => armDialog('pool-mint', {}) },
                'mint pieces…',
              ),
            ),
          )
        : h('p.muted', '—'),
  )
}

const backendsView = () => {
  const b = state.data.backends
  if (!b) return h('p.muted', 'loading…')
  return h(
    'table',
    h('thead', h('tr', h('th', ''), h('th', 'backend'), h('th', 'detail'), h('th', 'target'))),
    h(
      'tbody',
      b.backends.map((backend) =>
        h(
          'tr',
          h('td', h(`span.dot${backend.ok ? '' : '.down'}`)),
          h('td', backend.name),
          h('td', backend.ok ? h('span.muted', backend.detail) : h('span', { class: 'sans' }, backend.error)),
          h('td.faint', backend.target ?? '—'),
        ),
      ),
    ),
  )
}

const settingsView = () => {
  const s = state.data.settings
  if (!s) return h('p.muted', 'loading…')
  return h(
    'div',
    // The honest headline. Nothing here applies to a running solver, and the
    // API says so on every response rather than letting the UI imply otherwise.
    h('p.notice', s.restartNotice),
    h(
      'table',
      h('thead', h('tr', h('th', 'knob'), h('th', 'value'), h('th', 'source'), h('th', ''))),
      h(
        'tbody',
        s.knobs.map((knob) =>
          h(
            'tr',
            h('td', knob.key),
            h('td', String(knob.value)),
            h('td', knob.source === 'override' ? h('span.phase.phase-exposed', 'override') : h('span.muted', 'env')),
            h(
              'td',
              knob.editable
                ? h(
                    'span',
                    h('button.act', { onclick: () => editKnob(knob) }, 'edit'),
                    ' ',
                    knob.source === 'override'
                      ? h('button.act', { onclick: () => patchSetting(knob.key, null) }, 'clear')
                      : null,
                  )
                : h('span.faint', 'read-only'),
            ),
          ),
        ),
      ),
    ),
  )
}

/* ==== asset markets — BEGIN =============================================== *
 *
 * CRUD for the asset pairs this solver trades: which asset against which, off
 * which feed, at what spread and inside what bounds.
 *
 * Its own screen rather than rows on `settings`, for the reason
 * `admin/routes/markets.ts` gives: that page edits a compiled-in list of
 * scalars, and a market is a record an operator ADDS and DROPS.
 *
 * The draft lives here rather than on `state` so that typing into the form does
 * not re-render the console — the same trick the confirm dialog uses, and for
 * the same reason: a rebuild hands back a new input with no focus and a caret
 * at zero, so the field looks fine and silently stops accepting input.
 * ========================================================================== */

/** The market being edited, or null when the form is closed. */
let marketDraft = null

/** `null` is the BTC leg everywhere below the wire; `BTC` is what an operator types. */
const legLabel = (leg) => (leg === null ? 'BTC' : shortId(leg))

const blankMarket = () => ({
  base: 'BTC',
  quote: '',
  baseDecimals: '8',
  quoteDecimals: '6',
  feedUrl: '',
  pricePath: '',
  toleranceBps: '10',
  feeBps: '0',
  sellBaseMin: '',
  sellBaseMax: '',
  buyBaseMin: '',
  buyBaseMax: '',
  enabled: true,
})

const draftFrom = (market) => ({
  base: market.base ?? 'BTC',
  quote: market.quote ?? 'BTC',
  baseDecimals: String(market.baseDecimals),
  quoteDecimals: String(market.quoteDecimals),
  feedUrl: market.feedUrl,
  pricePath: market.pricePath,
  toleranceBps: String(market.toleranceBps),
  feeBps: String(market.feeBps),
  sellBaseMin: market.sellBase?.min ?? '',
  sellBaseMax: market.sellBase?.max ?? '',
  buyBaseMin: market.buyBase?.min ?? '',
  buyBaseMax: market.buyBase?.max ?? '',
  enabled: market.enabled,
})

/**
 * A bound is sent only when BOTH halves are filled, because the server rejects
 * a half-stated one — one alone reads as a bound and is not one. Empty on both
 * means the direction inherits the deployment-wide pair.
 */
const draftBounds = (min, max) => (min.trim() === '' && max.trim() === '' ? null : { min: min.trim(), max: max.trim() })

/**
 * Decimals and bps go as JSON NUMBERS because they are small and the server
 * demands integers; the amount bounds go as STRINGS because they are atomic
 * units and a bigint does not survive JSON.parse.
 */
const marketBody = (d) => ({
  base: d.base,
  quote: d.quote,
  baseDecimals: Number(d.baseDecimals),
  quoteDecimals: Number(d.quoteDecimals),
  feedUrl: d.feedUrl,
  pricePath: d.pricePath,
  toleranceBps: Number(d.toleranceBps),
  feeBps: Number(d.feeBps),
  sellBase: draftBounds(d.sellBaseMin, d.sellBaseMax),
  buyBase: draftBounds(d.buyBaseMin, d.buyBaseMax),
  enabled: d.enabled,
})

const field = (label, key, hint) =>
  h(
    'p.toolbar',
    h('span.muted', label),
    h('input', {
      value: String(marketDraft[key] ?? ''),
      size: 44,
      // No re-render: see the block header.
      oninput: (e) => (marketDraft[key] = e.target.value),
    }),
    hint ? h('span.faint', hint) : null,
  )

const saveMarket = async () => {
  try {
    await api('/api/markets', { method: 'PUT', body: JSON.stringify(marketBody(marketDraft)) })
    marketDraft = null
    state.banner = null
    await load('markets')
  } catch (error) {
    // Left OPEN on failure, deliberately. Every refusal here names one field,
    // and closing the form would make the operator retype ten others to fix it.
    fail(error)
  }
}

const deleteMarket = async (key) => {
  try {
    await api(`/api/markets/${encodeURIComponent(key)}`, { method: 'DELETE' })
    state.banner = null
    await load('markets')
  } catch (error) {
    fail(error)
  }
}

const marketForm = () =>
  h(
    'section.panel',
    h('h2', 'market'),
    // The key is derived from the legs, so re-submitting a pair edits it. Said
    // out loud because there is no id field to make that obvious.
    h('p.faint', 'A pair may be configured once. Submitting one that exists edits it.'),
    field('base', 'base', 'BTC, or a 68-character asset id'),
    field('quote', 'quote', 'BTC, or a 68-character asset id'),
    field('base decimals', 'baseDecimals'),
    field('quote decimals', 'quoteDecimals'),
    field('feed url', 'feedUrl', 'fetched and checked before this is stored'),
    field('price path', 'pricePath', 'RFC 6901 pointer; blank derives it where the provider is known'),
    field('tolerance bps', 'toleranceBps', 'deviation from the feed accepted; below 10000'),
    field('fee bps', 'feeBps', 'margin folded against the maker; below 10000'),
    field('sell-base min', 'sellBaseMin', 'atomic units of the want leg; blank inherits'),
    field('sell-base max', 'sellBaseMax', '0 closes this direction'),
    field('buy-base min', 'buyBaseMin'),
    field('buy-base max', 'buyBaseMax'),
    h(
      'p.toolbar',
      h('span.muted', 'enabled'),
      h('input', {
        type: 'checkbox',
        ...(marketDraft.enabled ? { checked: true } : {}),
        oninput: (e) => (marketDraft.enabled = e.target.checked),
      }),
      h('span.faint', 'a disabled market is served by neither direction'),
    ),
    h(
      'p.toolbar',
      h('button.act', { onclick: saveMarket }, 'save'),
      h('button.act', { onclick: () => ((marketDraft = null), render()) }, 'cancel'),
    ),
  )

const marketsView = () => {
  const m = state.data.markets
  if (!m) return h('p.muted', 'loading…')
  const active = new Set(m.active)
  return h(
    'div',
    // The same honesty the settings page carries, and it matters more here: a
    // market added now is invisible to this process, so an operator watching
    // for fills against it would be watching for something that cannot happen.
    h('p.notice', m.restartNotice),
    h('p.toolbar', h('button.act', { onclick: () => ((marketDraft = blankMarket()), render()) }, 'add market')),
    marketDraft ? marketForm() : null,
    m.markets.length === 0
      ? h('p.muted', 'no markets configured — this solver trades no asset pairs and refuses every offer')
      : h(
          'table',
          h(
            'thead',
            h(
              'tr',
              h('th', 'pair'),
              h('th', 'feed'),
              h('th', 'tolerance'),
              h('th', 'fee'),
              h('th', 'state'),
              h('th', ''),
            ),
          ),
          h(
            'tbody',
            m.markets.map((market) =>
              h(
                'tr',
                h('td', { title: market.marketKey }, `${legLabel(market.base)} / ${legLabel(market.quote)}`),
                h('td.faint', { title: `${market.feedUrl} ${market.pricePath}` }, shortId(market.feedUrl)),
                h('td.num', `${market.toleranceBps} bps`),
                h('td.num', `${market.feeBps} bps`),
                h(
                  'td',
                  // Three states, not two, and the middle one is the point of
                  // this column: stored-and-enabled is NOT the same as being
                  // traded by the process answering this request.
                  !market.enabled
                    ? h('span.muted', 'disabled')
                    : active.has(market.marketKey)
                      ? h('span.muted', 'trading')
                      : h('span.phase.phase-exposed', 'pending restart'),
                ),
                h(
                  'td',
                  h('button.act', { onclick: () => ((marketDraft = draftFrom(market)), render()) }, 'edit'),
                  ' ',
                  h('button.act', { onclick: () => deleteMarket(market.marketKey) }, 'delete'),
                ),
              ),
            ),
          ),
        ),
  )
}

/* ==== asset markets — END ================================================= */

const auditView = () => {
  const a = state.data.audit
  if (!a) return h('p.muted', 'loading…')
  return a.actions.length === 0
    ? h('p.muted', 'no actions recorded')
    : h(
        'table',
        h(
          'thead',
          h('tr', h('th', 'when'), h('th', 'action'), h('th', 'target'), h('th', 'outcome'), h('th', 'detail')),
        ),
        h(
          'tbody',
          a.actions.map((row) =>
            h(
              'tr',
              h('td.muted', ago(row.at)),
              h('td', row.action),
              h('td.faint', shortId(row.target)),
              h('td', row.outcome === 'ok' ? h('span.muted', 'ok') : h('span.phase.phase-failed', 'error')),
              h('td.faint', row.detail ?? ''),
            ),
          ),
        ),
      )
}

/* ---- swap detail -------------------------------------------------------- */

/**
 * Discovery: the registry card an operator copies, and the state of the Nostr
 * ad the solver publishes.
 *
 * Both on one page because an operator asking "am I discoverable?" does not
 * care that discovery has two mechanisms — a git-reviewed card in
 * solver-registry and a kind-38859 ad on a relay. They care whether each one
 * is current.
 */
const discoveryView = () => {
  const d = state.data.discovery
  if (!d) return h('p.muted', 'loading…')
  const cardJson = d.card ? JSON.stringify(d.card, null, 2) : null
  const publish = d.publish ?? { mode: 'off', lastPublishedAt: null, lastError: null }
  return h(
    'div.panels',
    h(
      'section.panel',
      h('h2', 'registry card'),
      // Whatever the card did: an unnameable corridor otherwise reads as unserved.
      (d.cardOmitted ?? []).map((note) => h('p.muted', note)),
      d.cardError
        ? h('p.muted', d.cardError)
        : h(
            'div',
            // Pre-formatted and selectable, not a one-line field: this is JSON
            // a human pastes into a pull request, so it has to be readable and
            // copyable even when the clipboard API is unavailable (no HTTPS,
            // older browser). The button is the convenience, not the only way.
            h('pre.faint', cardJson ?? '—'),
            h(
              'p.toolbar',
              h(
                'button.act',
                {
                  onclick: async () => {
                    try {
                      await navigator.clipboard.writeText(cardJson ?? '')
                      state.result = { name: 'copy card', result: 'copied to clipboard' }
                    } catch (error) {
                      // Clipboard access is denied outside a secure context. The
                      // JSON is already on screen and selectable, so say that
                      // rather than pretending the copy worked.
                      state.result = {
                        name: 'copy card',
                        result: `clipboard unavailable (${error instanceof Error ? error.message : String(error)}) — select the JSON above`,
                      }
                    }
                    render()
                  },
                  disabled: cardJson ? undefined : true,
                },
                'copy card JSON',
              ),
            ),
          ),
    ),
    h(
      'section.panel',
      h('h2', 'nostr advertisement'),
      h(
        'dl.kv',
        h('dt', 'mode'),
        h('dd', publish.mode),
        h('dt', 'last published'),
        h('dd.faint', publish.lastPublishedAt ? ago(publish.lastPublishedAt) : 'never'),
        h('dt', 'last error'),
        h('dd', publish.lastError ? h('span.sans', publish.lastError) : h('span.muted', '—')),
        // What WOULD be published, so an operator can check the terms before
        // posting rather than after. `adError` is reported rather than left
        // blank: an ad that cannot be built is a different fact from a solver
        // with nothing to advertise, and only one of them needs acting on.
        h('dt', 'payload'),
        h(
          'dd',
          d.adError
            ? h('span.sans', d.adError)
            : d.ad
              ? h('pre.faint', JSON.stringify(d.ad, null, 2))
              : h('span.muted', '—'),
        ),
      ),
      h(
        'p.toolbar',
        h(
          'button.act',
          {
            onclick: postAd,
            // Two different reasons this cannot post, and the operator needs to
            // tell them apart: `off` is a decision they made, `!publisher` is
            // that nothing is constructed to publish with. The server refuses
            // both independently — disabling here only spares a click that
            // would come back 409.
            disabled: publish.mode === 'off' || !publish.publisher ? true : undefined,
          },
          'post now',
        ),
        publish.mode === 'off'
          ? h('span.muted', ' NOSTR_AD_PUBLISH is off')
          : !publish.publisher
            ? h('span.muted', ' nothing is wired to publish yet')
            : null,
      ),
    ),
  )
}

/**
 * Publish the ad on demand.
 *
 * Not `runAction`: a 409 here is a POLICY answer, not a fault. Refusing because
 * the operator set `off`, or because this mode has no relay, is the setting
 * working correctly, and rendering it in the red failure banner would read as
 * a broken console.
 */
const postAd = async () => {
  try {
    const result = await api('/api/actions/post-ad', { method: 'POST', body: JSON.stringify({}) })
    state.banner = null
    state.result = { name: 'post-ad', result: result.publish }
    await load('discovery')
  } catch (error) {
    if (error.status === 409) {
      state.result = { name: 'post-ad', result: error.body?.detail ?? error.message }
      // Reload even though this is a refusal. All three refusals share a status
      // code, and one of them — a publish that reached the relay and failed —
      // DID move server state: `lastError` is now set. Skipping the reload
      // leaves the notice saying "relay down" directly above a panel row still
      // reading `last error —`, which reads as the console contradicting
      // itself. For `off` and `no_publisher` nothing moved and the reload is
      // merely redundant.
      await load('discovery')
      return
    }
    fail(error)
  }
}

/** "Is this solver healthy right now?" — probes, rails and headroom in one read. */
const diagnosticsView = () => {
  const d = state.data.diagnostics
  if (!d) return h('p.muted', 'loading…')
  return h(
    'div',
    d.overridesError ? h('p.banner', d.overridesError) : null,
    h(
      'table',
      h('thead', h('tr', h('th', ''), h('th', 'backend'), h('th', 'detail'), h('th', 'checked'))),
      h(
        'tbody',
        d.backends.map((backend) =>
          h(
            'tr',
            h('td', h(`span.dot${backend.ok ? '' : '.down'}`)),
            h('td', backend.name),
            h('td', backend.ok ? h('span.muted', backend.detail) : h('span.sans', backend.error)),
            // The timestamp is the point: without it a frozen probe and a fresh
            // one look identical.
            h('td.faint', ago(backend.lastCheckedAt)),
          ),
        ),
      ),
    ),
    h(
      'table',
      h('thead', h('tr', h('th', ''), h('th', 'corridor'), h('th', 'rail'), h('th', 'available'), h('th', 'max'))),
      h(
        'tbody',
        d.corridors.map((row) =>
          h(
            'tr',
            h('td', h(`span.dot${row.canHonourMax ? '' : '.down'}`)),
            h('td', corridorLabel(row.corridor)),
            h('td.faint', row.payoutRail),
            h('td', row.balanceError ? h('span.sans', row.balanceError) : sats(row.availableSats)),
            h('td.faint', sats(row.advertisedMaxSats)),
          ),
        ),
      ),
    ),
    // Advertising state belongs on the health page, not only on discovery: "am
    // I publishing?" is part of "is this solver healthy", and `heartbeatSeconds`
    // is produced here specifically so the page can say when the next
    // republish falls due.
    d.publish
      ? h(
          'p.muted',
          `ads ${d.publish.mode}`,
          d.publish.publisher ? '' : ' (nothing wired to publish)',
          ` · last ${d.publish.lastPublishedAt ? ago(d.publish.lastPublishedAt) : 'never'}`,
          d.publish.heartbeatSeconds ? ` · heartbeat ${duration(d.publish.heartbeatSeconds)}` : '',
          d.publish.lastError ? h('span.sans', ` · ${d.publish.lastError}`) : null,
        )
      : null,
    h(
      'p.muted',
      `uptime ${duration(d.uptimeSeconds)} · mode ${d.mode}`,
      d.relay ? ` · relay ${d.relay.connected ? 'connected' : 'down'}` : '',
    ),
  )
}

const openDetail = async (row) => {
  try {
    // A result belonging to a DIFFERENT swap is dropped rather than carried
    // over. Left in place it would neither render here (the modal keys on the
    // swap id) nor be readable there (the page banner sits behind the scrim) —
    // an answer about another row, hidden, next to buttons that move money.
    if (state.result && state.result.forSwap && state.result.forSwap !== row.id) state.result = null
    state.detail = await api(`/api/swaps/${encodeURIComponent(row.corridor)}/${encodeURIComponent(row.id)}`)
    render()
  } catch (error) {
    fail(error)
  }
}

/**
 * One explanation block, or nothing when the server had none.
 *
 * Server-resolved rather than a lookup table here: the prose has one home in
 * `src/core/refusalReasons.ts`, so it cannot drift from the codes it explains
 * and anything else reading the admin API gets it too.
 */
const explain = (title, explanation) =>
  explanation
    ? h(
        'div.explain',
        h('p.explain-title', title),
        h('p', explanation.meaning),
        h('p.muted', h('strong', 'what to do: '), explanation.whatToDo),
      )
    : null

/** Shorten an id for display; the link carries the whole thing. */
const short = (value) => (value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value)

/**
 * One explorer link, or null when there is nothing to link to.
 *
 * Bases come from the SERVER (`/api/overview`), never a table duplicated here:
 * a second copy in untyped browser code is the copy that eventually points a
 * mainnet swap at a signet explorer.
 */
const explorerLink = (raw, field, chain, label) => {
  const bases = state.overview?.explorers
  const value = raw?.[field]
  if (!bases || typeof value !== 'string' || value.trim().length === 0) return null
  const base = bases[chain]
  if (!base) return null
  const path = field.toLowerCase().includes('address') ? 'address' : 'tx'
  return h(
    'a',
    {
      href: `${base}/${path}/${encodeURIComponent(value.trim())}`,
      target: '_blank',
      // Opener isolation: the console has no authentication, so a tab it opens
      // must not be able to reach back into it.
      rel: 'noreferrer noopener',
      title: value,
    },
    `${label} ${short(value)}`,
  )
}

/**
 * The evidence that belongs on a given timeline step.
 *
 * On the STEP rather than in a section of its own, because the timeline is the
 * narrative and these are what each entry actually did. A separate list made a
 * reader hold a txid in their head while working out which line it came from.
 *
 * Each field against the chain it lives on — Arkade ids to the Arkade explorer,
 * L1 ids to the mempool instance. Crossing them answers "not found", which
 * reads like lost funds. An EXPLICIT list, so a field nobody classified renders
 * as plain text rather than a confident link to the wrong chain.
 */
/**
 * Which identifiers become links, on which step, and on whose explorer.
 *
 * Listed per step rather than per corridor: `explorerLink` yields nothing for a
 * field the row does not carry, so a step may name every corridor's spelling of
 * the same event and each row renders only its own. That is what keeps this
 * table one thing to maintain instead of four.
 *
 * The spellings differ more than they look. `arkade:BTC->lightning:BTC` records
 * its lockup as `lockupTxid`; `lightning:BTC->arkade:BTC` records the very same
 * fact as `arkadeLockupTxid`. This table was written against the first and not
 * revisited, so the receive corridor rendered `armed -> funded` with no link
 * while the txid sat in the row — reported from mainnet on swap 28043f5d.
 * `test/admin/timelineLinks.test.ts` now reads the field names out of the four
 * row types and fails when one of them is unlinked.
 *
 * Chain matters as much as presence. An L1 txid on the Arkade explorer answers
 * "not found", which reads exactly like the money is gone — so anything named
 * `onchain*`, plus `fundingTxid`, goes to mempool and everything else to Arkade.
 */
const STEP_LINKS = {
  quoted: [
    ['lockupAddress', 'arkade', 'lockup address'],
    // Where the client's funds are headed. Known at quote time on both receive
    // corridors, and the first thing looked up when a payout is disputed.
    ['payoutAddress', 'arkade', 'payout address'],
    ['onchainAddress', 'onchain', 'L1 payout address'],
  ],
  funded: [
    ['lockupTxid', 'arkade', 'lockup tx'],
    // The receive corridor's name for the same transaction. Its absence here is
    // the bug this table was fixed for.
    ['arkadeLockupTxid', 'arkade', 'lockup tx'],
    ['onchainLockupTxid', 'onchain', 'L1 lockup tx'],
    ['fundingTxid', 'onchain', 'L1 funding tx'],
    ['arkadeFundTxid', 'arkade', 'arkade fund tx'],
  ],
  claimed: [
    ['claimArkTxid', 'arkade', 'claim tx'],
    ['arkadeClaimTxid', 'arkade', 'arkade claim tx'],
    ['onchainClaimTxid', 'onchain', 'L1 claim tx'],
  ],
  // The unwind, which had no entry at all — so the one transaction an operator
  // most needs to confirm after a refund was the one they could not open.
  refunded: [
    ['refundArkTxid', 'arkade', 'refund tx'],
    ['arkadeRefundTxid', 'arkade', 'arkade refund tx'],
    ['onchainRefundTxid', 'onchain', 'L1 refund tx'],
  ],
}
const stepLinks = (raw, step) =>
  // Notes are excluded: they name their own transaction in the text, and
  // `noteLinks` reads it from there rather than guessing at a row field.
  (step.detail ? [] : (STEP_LINKS[step.to] ?? [])).map(([f, c, l]) => explorerLink(raw, f, c, l)).filter(Boolean)

/**
 * The one sentence an operator needs before touching anything.
 *
 * A row of equally-weighted buttons asks "which of these?" and gets answered by
 * pressing them in turn. This answers it first, and changes as evidence lands.
 */
const nextStep = (d) => {
  const read = readVerdict(d.swap.id)
  if (!read) {
    return d.swap.state === 'stuck' || d.swap.phase === 'exposed'
      ? 'Start with READ PAYMENT. It asks the backend what became of this payment and decides refund vs claim. Nothing below moves money until you do.'
      : 'Start with RECHECK. It drives the swap one step, which resolves most rows on its own.'
  }
  const says = {
    'paid-do-not-refund': 'READ SAYS: the solver PAID. Claim the lockup — refunding would pay the client twice.',
    'self-payment-do-not-refund': 'READ SAYS: our own node may still collect. Do NOT refund; read the node by hand.',
    'not-paid-refund-is-safe': 'READ SAYS: the payment did not settle. Refunding the client is the correct resolution.',
    'never-submitted': 'READ SAYS: nothing was submitted. Refunding is safe IF the backend confirmed it holds nothing.',
    'undecided-push-nothing': 'READ SAYS: undecided. Push NOTHING. Re-read, or read the wallet by hand.',
  }
  return says[read.verdict] ?? `READ SAYS: ${read.verdict}.`
}

/** One armed button, marked by whether the last read supports it. */
const armedButton = (name, d) => {
  const read = readVerdict(d.swap.id)
  const money = name === 'refund-now' || name === 'claim-now'
  const contrary = money && !read?.supports[name]
  const because = !money
    ? null
    : read
      ? `The last read-payment on this swap said: ${read.verdict}.`
      : 'No read-payment has been run on this swap yet, so nothing has been checked.'
  return actButton(
    'button.act.armed',
    {
      'data-action': name,
      class: contrary ? 'contrary' : money ? 'supported' : '',
      title: because ?? undefined,
      onclick: () => {
        if (name !== 'park-swap') return armDialog(name, { id: d.swap.id }, contrary ? because : null)
        const why = window.prompt('Why is this swap being parked? Recorded on the row.')
        if (!why || !why.trim()) return
        // `corridor` because park-swap is offered on EVERY row and now dispatches
        // through the registry: a swap id is unique only within its own store.
        return armDialog(name, { id: d.swap.id, corridor: d.swap.corridor, reason: why.trim() })
      },
    },
    name,
    contrary ? h('span.faint', ' ⚠ not what the read supports') : null,
  )
}

/** One labelled group, so the action row stops reading as a menu of equals. */
const actionGroup = (label, hint, ...buttons) => {
  const live = buttons.filter(Boolean)
  return live.length === 0
    ? null
    : h('div.actgroup', h('div.actlabel', h('b', label), h('span.faint', ` ${hint}`)), h('div.row', ...live))
}

/**
 * Explorer links for the transactions a history note names.
 *
 * Notes are written by the store as prose that happens to contain ids —
 * `funding <txid>:<vout> — N sats`, `refund pushed <txid>`. Rather than a
 * parallel structure the store would have to keep in step, the ids are read
 * back out of the text.
 *
 * Chain by CORRIDOR: this store's lockup is an Arkade script, so its fundings
 * and covenant refunds are Arkade transactions. An onchain-corridor note would
 * need its own mapping and gets no link rather than a wrong one.
 */
const shortenIds = (text) => String(text).replace(/[0-9a-f]{64}/gi, (id) => short(id))

/** The corridors that move on Arkade and nowhere else. See {@link noteLinks}. */
const ARKADE_ONLY_CORRIDORS = ['arkade:BTC->lightning:BTC', 'lightning:BTC->arkade:BTC']

const noteLinks = (corridor, detail) => {
  const bases = state.overview?.explorers
  // Both PURE-ARKADE corridors, not just the send one. A note reads
  // `refund pushed <txid>`, and on either of these the transaction it names can
  // only be an Arkade one — so the txid is unambiguous and the link is safe.
  //
  // The onchain corridors stay out, and that is the reason for an allowlist
  // rather than a check for `bases.arkade`: those move on two chains, and 64 hex
  // characters in a note do not say which. Guessing sends an operator to an
  // explorer that answers "not found" about the wrong chain, which is the one
  // outcome worse than no link.
  if (!bases?.arkade || !ARKADE_ONLY_CORRIDORS.includes(corridor)) return []
  const ids = [...new Set(String(detail).match(/[0-9a-f]{64}/gi) ?? [])]
  return ids.map((id) =>
    h(
      'div.steplink',
      h(
        'a',
        {
          href: `${bases.arkade}/tx/${encodeURIComponent(id)}`,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: id,
        },
        'open tx',
      ),
    ),
  )
}

/**
 * An action button that knows the console is busy.
 *
 * While ANY action is in flight every one of them is disabled — not just the
 * one pressed — because the hazard is two writes racing the same row, not two
 * clicks on the same button. The one actually running says so, so the operator
 * can see which request they are waiting on rather than a row of dead buttons.
 */
const actButton = (spec, attrs, ...label) => {
  const busy = Boolean(state.running)
  const mine = state.running?.name === attrs['data-action']
  return h(
    spec,
    {
      ...attrs,
      disabled: busy || attrs.disabled === true,
      class: [attrs.class, mine ? 'running' : ''].filter(Boolean).join(' '),
    },
    mine ? h('span.spinner') : null,
    ...label,
  )
}

const detailDialog = () => {
  const d = state.detail
  if (!d) return null
  // Not on a DELIVERED swap. Every action below unwinds a lockup, and `done`
  // means the corridor's own terminal success — the solver claimed the client's
  // lockup after paying, so there is nothing at the script to unwind and never
  // will be. `refundNow` already returns `NOTHING_AT_SCRIPT` for exactly this,
  // so offering it costs no money; what it costs is an armed-tier confirmation
  // that can only ever no-op, which is how operators learn to click through the
  // dialogs that DO move funds.
  //
  // Only `done` is withheld. `failed` keeps them all: a `refused` or `stuck`
  // row may hold a funded lockup, and unwinding that is precisely what these
  // are for. `refunded` deliberately lands in `failed` rather than `done`
  // (see DELIVERED in src/admin/projection.ts), so it keeps them too.
  const delivered = d.swap.phase === 'done'
  const armed = delivered
    ? []
    : [
        d.swap.corridor === 'arkade:BTC->lightning:BTC' ? 'refund-now' : null,
        // Beside refund-now on purpose: on a stuck send these are the two
        // answers to the SAME question, and `read payment` is what picks.
        d.swap.corridor === 'arkade:BTC->lightning:BTC' ? 'claim-now' : null,
        d.swap.corridor === 'arkade:BTC->onchain:BTC' ? 'onchain-refund-now' : null,
        d.swap.corridor === 'arkade:BTC->onchain:BTC' ? 'reclaim-l1-htlc' : null,
        // Every corridor: a row that cannot progress is not a Lightning-only
        // problem, and this is the only thing that stops the sweep re-driving it.
        'park-swap',
      ].filter(Boolean)
  return h(
    'div.scrim',
    { onclick: (e) => e.target.classList.contains('scrim') && ((state.detail = null), render()) },
    h(
      'div.dialog.detail',
      h('h2', `${corridorLabel(d.swap.corridor)} · ${d.swap.id}`),
      h('p', phaseChip(d.swap.phase), ' ', stateWord(d.swap.state, d.raw)),
      d.swap.failureReason ? h('p.banner', d.swap.failureReason) : null,
      // `stuck` beside a pushed refund reads as an unresolved loss. It is not:
      // the two facts are about different people. `stuck` says an operator
      // should look at WHY the payment died; `refund_outcome` says the client's
      // sats already went back — and the client is told `refunded`, never
      // `stuck` (see `rfqStateFromRow`). The console showed only the frightening
      // half of that.
      d.raw?.refundOutcome
        ? h(
            'p.settled',
            h('b', 'The client has been refunded'),
            d.raw.refundOutcome === 'external' ? ' (by someone else). ' : '. ',
            'Nothing is outstanding for them. This row is parked so a human can see WHY the payment failed.',
          )
        : null,
      // The raw reason above stays: it is the exact string the row carries, and
      // an operator comparing against logs needs it verbatim. What follows is
      // what it MEANS, resolved server-side (src/core/refusalReasons.ts).
      explain('what this state means', d.swap.stateNote),
      explain('why it stopped here', d.swap.failureExplanation),
      h('h2', 'timeline'),
      h(
        'table',
        h(
          'tbody',
          d.history.map((step) => {
            const links = stepLinks(d.raw, step).map((link) => h('div.steplink', link))
            // A NOTE, not a step: something happened to the swap without moving
            // it through the lifecycle. A refund is the only one today, and it
            // is exactly the entry whose absence made one appear from nowhere.
            return step.detail
              ? h(
                  'tr.note',
                  h('td.muted', ago(step.at)),
                  h('td.faint', ''),
                  // A note names its own transaction, so the id is shortened in
                  // the text and the link beside it carries the whole thing —
                  // the id an operator wants to open is the one they are
                  // already reading, not one in a list further down the page.
                  h('td', h('b', shortenIds(step.detail)), ...noteLinks(d.swap.corridor, step.detail)),
                )
              : h(
                  'tr',
                  h('td.muted', ago(step.at)),
                  h('td.faint', step.from ?? '(start)'),
                  h(
                    'td',
                    `→ ${step.to}`,
                    // Glossed HERE too, not only on the chip at the top. This
                    // row is where `paid` was read as "we paid" and the whole
                    // timeline stopped making sense.
                    stateRead(step.to, d.raw) ? h('span.faint', `  ${stateRead(step.to, d.raw)}`) : null,
                    ...links,
                  ),
                )
          }),
        ),
      ),
      // The answer to whatever was last pressed, HERE and in full.
      //
      // Above the buttons rather than below them: an operator who has just read
      // `paid-do-not-refund` is about to decide whether to press `refund now`,
      // and the verdict has to be between them and that button, not underneath
      // it where the dialog may already have scrolled past.
      state.result && state.result.forSwap === d.swap.id
        ? h(
            'div',
            h('h2', `${state.result.name} result`),
            h(
              'pre.faint',
              { style: 'overflow:auto;max-height:16rem' },
              typeof state.result.result === 'string'
                ? state.result.result
                : JSON.stringify(state.result.result, null, 2),
            ),
            h('div.row', h('button.act', { onclick: () => ((state.result = null), render()) }, 'dismiss result')),
          )
        : null,
      // What to do, before which button. The row used to answer "which of
      // these?" with six equal options; this answers it in words first.
      h('p.nextstep', nextStep(d)),
      actionGroup(
        '1 · look',
        'safe — moves nothing',
        actButton(
          'button.act',
          {
            'data-action': 'tick',
            title: 'Re-poll the backend and drive this swap one step. Exactly what the sweep does on its own cadence.',
            onclick: () => runAction('tick', { id: d.swap.id, corridor: d.swap.corridor }),
          },
          'recheck',
        ),
        d.swap.corridor === 'arkade:BTC->lightning:BTC'
          ? actButton(
              'button.act',
              {
                'data-action': 'read-payment',
                title: 'Ask the Lightning backend what became of this payment. Read-only. Decides refund vs claim.',
                onclick: () => runAction('read-payment', { id: d.swap.id, corridor: d.swap.corridor }),
              },
              'read payment',
            )
          : null,
        // On EVERY row, with no corridor gate and no `corridor` in the body:
        // the action iterates the registry to find whichever corridor holds the
        // id, so gating it here would re-close what that opened. The answer it
        // gives — which leaf the solver can spend without the Arkade Service,
        // and how long its CSV runs — is the same question on every corridor.
        actButton(
          'button.act',
          {
            'data-action': 'unilateral-exit-plan',
            title:
              'Which covenant leaf the solver can spend WITHOUT the Arkade Service, and how long its CSV runs. ' +
              'Read-only. Performing the exit is `cli unilateral-exit <id> --go`.',
            onclick: () => runAction('unilateral-exit-plan', { id: d.swap.id }),
          },
          'exit plan',
        ),
      ),
      actionGroup(
        '2 · resolve',
        'moves money — pick the one the read supports',
        ...armed.filter((n) => n !== 'park-swap').map((name) => armedButton(name, d)),
      ),
      actionGroup('3 · give up', 'stops the sweep driving it; moves nothing', armedButton('park-swap', d)),
      h('div.row', h('span.spacer'), h('button.act', { onclick: () => ((state.detail = null), render()) }, 'close')),
      // The raw row last: reference material, not the point of the screen.
      h('h2', 'row'),
      h('pre.faint', { style: 'overflow:auto;max-height:14rem' }, JSON.stringify(d.raw, null, 2)),
    ),
  )
}

/* ---- actions ------------------------------------------------------------ */

const runAction = async (name, body) => {
  // One at a time, across the WHOLE console. An action is a request to a
  // backend that can take seconds, and until now every button stayed live
  // throughout: a second click on `refund now` was a second refund, and a
  // click on a DIFFERENT button while one was in flight raced two writes
  // against the same row. Neither is something to leave to how fast an
  // operator's hand is.
  //
  // Guarded here rather than on each button, because the rule is about the
  // console having an action outstanding, not about which one was pressed.
  if (state.running) return
  state.running = { name, forSwap: state.detail?.swap.id ?? null }
  render()
  try {
    const result = await api(`/api/actions/${name}`, { method: 'POST', body: JSON.stringify(body) })
    state.banner = null
    state.dialog = null
    // WHERE the action was pressed decides where its answer goes. An action run
    // from the detail modal is a question about the row the operator is already
    // looking at — `read payment`'s verdict most of all, which is the thing they
    // then act on — so the answer belongs in that modal, in full. Rendered
    // behind the scrim as a page banner it was both hidden and cut to 160
    // characters, which is enough to show `{` and lose the verdict.
    state.result = { name, result: result.result, forSwap: state.detail?.swap.id ?? null }
    await load(state.view)
  } catch (error) {
    // A failure belongs INSIDE the dialog that caused it. The page banner
    // renders behind the scrim, so an operator would have to dismiss the
    // dialog — losing the value they typed — just to read why their refund
    // failed. Keeping it armed also means they can retry without re-arming.
    if (state.dialog) {
      state.dialog.error = error instanceof Error ? error.message : String(error)
      return
    }
    fail(error)
  } finally {
    // Cleared on BOTH paths. A failed action that left the console latched
    // would be worse than the double-click it prevents: nothing would move
    // again until a reload, on the screen where an operator is already stuck.
    //
    // The early `return` above lands here too — that is the point of `finally`
    // over a line at the end — and the render it used to do is now this one.
    state.running = null
    render()
  }
}

/**
 * The arm-to-confirm step.
 *
 * A convenience only — the server checks the same value independently, before
 * running anything, so bypassing this dialog with a bare fetch gets refused.
 * The warning text comes from the API rather than being duplicated here.
 */
const armDialog = async (name, body, override = null) => {
  const catalogue = state.data.actions ?? (await api('/api/actions'))
  state.data.actions = catalogue
  const definition = catalogue.actions.find((a) => a.name === name)
  state.dialog = {
    name,
    body,
    /**
     * Set when the last read-payment does not support this action, or when
     * none has been run. Renders as a second, louder gate that must be ticked
     * before the confirm box does anything — friction, deliberately, on the
     * client, since the SERVER's own confirm is the boundary and this is the
     * step that stops a reflex.
     */
    override,
    overridden: false,
    warning: definition?.warning ?? null,
    // Parsed from the KIND, never matched against one action's name. The server
    // used to hardcode `name === 'pool-mint'` here too, and this line was its
    // mirror: a new armed action with a different literal fell through to
    // `body.id`, which is undefined for anything wallet-level. The operator then
    // types the right word, the comparison never matches, and the button stays
    // disabled - an action unusable through the console while correct on the
    // server. @see ActionDefinition in admin/routes/actions.ts
    // `destination-address` first: the confirmation is the request's OWN
    // destination, so it differs per withdrawal and cannot become the muscle
    // memory a fixed literal becomes. The server compares the same field.
    expects:
      definition?.confirmKind === 'destination-address'
        ? body.address
        : definition?.confirmKind?.startsWith('literal:')
          ? definition.confirmKind.slice('literal:'.length)
          : body.id,
    typed: '',
  }
  render()
}

const confirmDialog = () => {
  const d = state.dialog
  if (!d) return null
  const ok = d.typed === d.expects && (!d.override || d.overridden)
  return h(
    'div.scrim',
    { onclick: (e) => e.target.classList.contains('scrim') && ((state.dialog = null), render()) },
    h(
      'div.dialog',
      h('h2', d.name),
      d.warning ? h('p.warning', d.warning) : null,
      // The override gate, above the warning an operator has already learned to
      // scroll past. It names what the read actually said rather than asking a
      // generic "are you sure", because the generic one is the question people
      // answer without reading.
      d.override
        ? h(
            'div.banner',
            h('p', h('b', 'This is not the action the last check supports.')),
            h('p', d.override),
            h(
              'label.row',
              h('input', {
                type: 'checkbox',
                onchange: (e) => {
                  d.overridden = e.target.checked
                  const run = e.target.closest('.dialog').querySelector('button.armed')
                  if (run) run.disabled = !(d.overridden && d.typed === d.expects)
                },
              }),
              ' I have read this and want to proceed anyway',
            ),
          )
        : null,
      // The action was attempted and failed. It stays here rather than in the
      // page banner, which the scrim covers.
      d.error ? h('p.banner', d.error) : null,
      h('p.sans', 'Type ', h('b', d.expects), ' to confirm. This is checked by the server too.'),
      h(
        'div.row',
        h('input', {
          value: d.typed,
          autofocus: true,
          oninput: (e) => {
            d.typed = e.target.value
            // Re-render only the button state; a full render would steal focus.
            e.target.parentElement.querySelector('button.armed').disabled =
              e.target.value !== d.expects || (d.override && !d.overridden)
          },
        }),
        actButton(
          'button.act.armed',
          {
            'data-action': d.name,
            // The one button that actually moves money. `runAction` refuses a
            // second call on its own, but a live button during a multi-second
            // refund invites the click that produces the confusing log line.
            disabled: !ok,
            onclick: () => runAction(d.name, { ...d.body, confirm: d.typed }),
          },
          'run it',
        ),
        h('button.act', { onclick: () => ((state.dialog = null), render()) }, 'cancel'),
      ),
    ),
  )
}

const editKnob = (knob) => {
  const next = window.prompt(`${knob.key}\n\nCurrent: ${knob.value}\nTakes effect on restart.`, String(knob.value))
  if (next === null) return
  patchSetting(knob.key, next)
}

const patchSetting = async (key, value) => {
  try {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ key, value }) })
    state.banner = null
    await load('settings')
  } catch (error) {
    fail(error)
  }
}

/**
 * Shortest term the server will run, mirrored here so the console can say why
 * it is waiting instead of showing a 400. Kept equal to `MIN_SEARCH_LENGTH` in
 * `src/db/page.ts`; a test pins the two together.
 */
const MIN_SEARCH = 3

/** One query per pause in typing, not one per keystroke across four stores. */
const SEARCH_DEBOUNCE_MS = 250
let searchTimer = null

/* ---- loading and rendering ---------------------------------------------- */

const ENDPOINTS = {
  swaps: () => {
    const params = new URLSearchParams()
    if (state.filters.corridor) params.set('corridor', state.filters.corridor)
    if (state.filters.phase) params.set('phase', state.filters.phase)
    // Below the server's minimum the request is a 400, so a half-typed term
    // would replace the table with an error banner while someone is still
    // typing. Held back until it can succeed.
    if (state.filters.q.trim().length >= MIN_SEARCH) params.set('q', state.filters.q.trim())
    return `/api/swaps?${params}`
  },
  quotes: () => '/api/quotes',
  wallet: () => '/api/wallet',
  backends: () => '/api/backends',
  diagnostics: () => '/api/diagnostics',
  discovery: () => '/api/card',
  settings: () => '/api/settings',
  markets: () => '/api/markets',
  audit: () => '/api/audit',
}

const load = async (view) => {
  try {
    state.overview = await api('/api/overview')
    if (ENDPOINTS[view]) state.data[view] = await api(ENDPOINTS[view]())
    state.banner = null
  } catch (error) {
    state.banner = error instanceof Error ? error.message : String(error)
  }
  render()
}

const viewFromHash = () => {
  const view = (location.hash || '#overview').slice(1)
  return BODIES[view] ? view : 'overview'
}

const go = (view) => {
  state.view = view
  // A result belongs to the view it happened on; carrying it across would have
  // an operator reading a refund's outcome on the settings page.
  state.result = null
  // pushState, not replaceState: an operator who drills into swaps and hits
  // back expects to land where they were. replaceState made the browser's back
  // button leave the console entirely.
  if (location.hash !== `#${view}`) history.pushState(null, '', `#${view}`)
  load(view)
}

const BODIES = {
  overview: overviewView,
  swaps: swapsView,
  quotes: quotesView,
  wallet: walletView,
  backends: backendsView,
  diagnostics: diagnosticsView,
  discovery: discoveryView,
  settings: settingsView,
  markets: marketsView,
  audit: auditView,
}

const render = () => {
  const root = document.getElementById('root')
  // `render` rebuilds the whole tree, so the detail modal that comes back is a
  // NEW node scrolled to the top. Every action now re-renders on the way in to
  // show its spinner, and the actions sit below a timeline long enough to
  // scroll — so without this, clicking one throws the operator to the top and
  // hides the very thing the click was meant to show. The same rebuild already
  // did this at the END of every action, and on every `swaps` event from the
  // stream, which skips a reload for the confirm dialog but not for this one.
  const detailScroll = root.querySelector('.dialog.detail')?.scrollTop ?? 0

  // The search box re-renders on a debounce while the operator is still typing,
  // and the rebuild hands back a NEW input with no focus and a caret at zero.
  // The text survives — it lives in `state.filters.q` — so the field looks fine
  // and simply stops accepting input, which is worse than losing it. Same fault
  // as the modal scroll above, same fix: read it now, put it back after.
  const active = document.activeElement
  const typing =
    active && active.tagName === 'INPUT' && active.classList.contains('search')
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null

  clear(root)
  root.appendChild(statusBar())
  root.appendChild(nav())
  const main = h('main')
  if (state.banner) main.appendChild(h('p.banner', state.banner))
  // An action's result, inline. This used to be window.alert(), which blocks
  // the whole tab and cannot be read alongside the table it just changed —
  // the wrong shape for a console an operator is scanning.
  // Skipped when the result belongs to an open detail modal — that modal
  // renders it itself, in full. Still shown when the modal has since been
  // closed, so an answer is never lost by dismissing the dialog.
  if (state.result && !(state.result.forSwap && state.detail?.swap.id === state.result.forSwap)) {
    main.appendChild(
      h(
        'p.notice',
        h('b', state.result.name),
        ' → ',
        // Capped: `tick` returns a whole swap row, and an unbounded dump pushes
        // the table an operator is watching off the screen. The full result is
        // on the audit row either way.
        (() => {
          // A string result is already the message — stringifying it wraps a
          // refusal reason in escaped quotes and makes it read like a value
          // rather than a sentence.
          const r = state.result.result
          const text = typeof r === 'string' ? r : JSON.stringify(r)
          return text.length > 160 ? `${text.slice(0, 160)}…` : text
        })(),
        ' ',
        h('button.act', { onclick: () => ((state.result = null), render()) }, 'dismiss'),
      ),
    )
  }
  main.appendChild((BODIES[state.view] ?? overviewView)())
  root.appendChild(main)
  const detail = detailDialog()
  if (detail) {
    root.appendChild(detail)
    // The scrim is not the scroller; the pane inside it is. Assigning to the
    // scrim is silently a no-op, which is how this read as fixed while the
    // modal still jumped to the top.
    const pane = detail.querySelector('.dialog.detail')
    if (pane) pane.scrollTop = detailScroll
  }
  const dialog = confirmDialog()
  if (dialog) root.appendChild(dialog)

  // After everything is in the document: focusing a detached node does nothing,
  // which is how the modal scroll fix was wrong the first time.
  if (typing) {
    const box = root.querySelector('input.search')
    if (box) {
      box.focus()
      // The caret, not just the field. Editing the middle of a pasted hash
      // otherwise jumps to the end on every debounce.
      box.setSelectionRange(typing.start, typing.end)
    }
  }
  armExpiryTick()
}

/* ---- live updates ------------------------------------------------------- */

/**
 * Keep a deposit countdown honest on a solver where nothing is happening.
 *
 * `fundDepositOption` recomputes the time remaining on every render, and the
 * ONLY automatic render is the `swaps` stream event below. That is a swap-
 * activity signal, not a clock: on an idle deployment — which is exactly the one
 * an operator is topping up — nothing re-renders, so a countdown minted at
 * button-press freezes and an expired invoice keeps advertising itself as live.
 * The banner that is supposed to replace it never arrives.
 *
 * Armed from `render` rather than started once, so it exists only while there is
 * something to count down. Three guards, each removing a way a periodic
 * whole-tree rebuild does harm:
 *
 *  - only on the view that shows deposit options, and only when one of them
 *    actually carries an expiry — an address never expires and must not put a
 *    timer on the page;
 *  - never while a dialog is open, the same guard the `swaps` listener uses;
 *  - never while a field has focus. `render` restores the caret for `.search`
 *    alone, so a rebuild under any other input would eat what is being typed —
 *    and an operator pasting a withdrawal address is the case that must not be
 *    disturbed by a countdown.
 *
 * 15 seconds, not one: the display is minute-granular apart from `<1m`, so a
 * faster tick would rebuild the tree sixty times to change nothing.
 */
let expiryTick = null

const countingDown = () =>
  state.view === 'wallet' &&
  !state.dialog &&
  (state.data.fundRead?.result?.options ?? []).some(
    // STILL IN THE FUTURE, not merely present. An option that has already lapsed
    // has nothing left to count: its banner is final, and every later tick
    // rebuilds the tree to render the identical sentence. Without this the timer
    // never stops — an operator who leaves the wallet page open goes on
    // rebuilding the DOM every 15s until they navigate away or close the tab.
    //
    // The banner still arrives, because `armExpiryTick` runs at the END of
    // `render`: the tick that observes the expiry renders it and only then
    // disarms.
    (option) => option.expiresAt !== undefined && option.expiresAt > Math.floor(Date.now() / 1000),
  )

const armExpiryTick = () => {
  if (countingDown()) {
    if (expiryTick === null) {
      expiryTick = setInterval(() => {
        const active = document.activeElement
        const tag = active?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        render()
      }, 15_000)
    }
    return
  }
  if (expiryTick !== null) {
    clearInterval(expiryTick)
    expiryTick = null
  }
}

const listen = () => {
  const source = new EventSource('/api/events')
  source.addEventListener('swaps', () => {
    // Reload rather than patching in place: the payload says WHICH swaps moved,
    // and re-asking is both simpler and guaranteed consistent with what the
    // other panels show.
    // `markets` joins `settings` here: neither is derived from swap state, so a
    // reload buys nothing — and it would rebuild an open market form, handing
    // back an input with no focus and a caret at zero while someone is typing a
    // 68-character asset id into it.
    if (state.view !== 'settings' && state.view !== 'markets' && !state.dialog) load(state.view)
  })
  // EventSource reconnects on its own; nothing to do but not treat it as fatal.
  source.addEventListener('error', () => {})
}

// Back/forward and pasted deep links are same-document navigations, so the
// module never re-runs and the view has to be re-read here. Without this,
// `#swaps` in the address bar rendered the overview.
window.addEventListener('hashchange', () => {
  const view = viewFromHash()
  if (view === state.view) return
  state.view = view
  load(view)
})

state.view = viewFromHash()
render()
load(state.view)
listen()
