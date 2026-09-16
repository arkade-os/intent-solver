/**
 * The console's charts. No library, no build step — SVG built by hand, exactly
 * as `app.js` builds HTML by hand, and for the same reason: an ops box should
 * not need a CDN, and a charting library would be more bytes than the whole
 * application.
 *
 * THE PALETTE RULE FROM `styles.css` HOLDS HERE, and it is what makes these
 * charts readable rather than decorative: COLOUR IS RESERVED FOR RISK. A
 * profit line is drawn in `--text`, gridlines in `--line`, labels in
 * `--text-dim`. Only two things are ever coloured — a loss, in `--failed`, and
 * sats at risk, in `--exposed`. A chart where the good news is also coloured
 * is one where the bad news has to compete for the eye.
 *
 * Every mark carries a `<title>`, so the exact figure behind a pixel is one
 * hover away. A chart an operator cannot read a number off is a picture.
 *
 * Nothing here formats a number into prose — `app.js` owns that vocabulary and
 * a second copy would drift from it.
 */

const NS = 'http://www.w3.org/2000/svg'

/** The SVG twin of `app.js`'s `h()`: `s('path.c-line', { d })`. */
const s = (spec, attributes = {}, ...children) => {
  const [tag, ...classes] = String(spec).split('.')
  const node = document.createElementNS(NS, tag || 'g')
  if (classes.length) node.setAttribute('class', classes.join(' '))
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue
    node.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

/** A `<title>` child, which is what makes an SVG mark hoverable. */
const titled = (node, text) => {
  node.appendChild(s('title', {}, text))
  return node
}

const PAD = { top: 12, right: 14, bottom: 26, left: 62 }

/**
 * A linear scale with a GUARDED domain.
 *
 * The guard is the whole reason this is a function. A single data point, or a
 * flat series, gives `max === min` — and dividing by that span yields NaN,
 * which SVG renders as nothing at all. A flat line at zero profit is a real and
 * common state of a solver's book, so it has to draw.
 */
const scale = (min, max, from, to) => {
  const span = max - min || 1
  return (value) => from + ((value - min) / span) * (to - from)
}

/**
 * Nice round tick values across a domain.
 *
 * Rounded to a 1/2/5 step rather than dividing the range evenly: an axis
 * labelled 0 / 3,247 / 6,494 is one an operator has to read rather than
 * glance at.
 */
const ticks = (min, max, count = 4) => {
  const span = max - min || Math.abs(max) || 1
  const rough = span / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? magnitude * 10
  const out = []
  for (let value = Math.floor(min / step) * step; value <= max + step / 2; value += step) out.push(value)
  return out
}

const compact = (value) => {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  return String(Math.round(value))
}

const clockLabel = (unixSeconds) => {
  const date = new Date(unixSeconds * 1_000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const frame = (width, height, label) =>
  s('svg.c-chart', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    // The chart is a picture to a screen reader; the table beneath each one is
    // the readable form. Named rather than left anonymous so the reader at
    // least knows what it is skipping.
    'aria-label': label,
  })

/**
 * Horizontal gridlines plus their labels, and the ZERO line drawn stronger.
 *
 * Zero earns the emphasis: on a P&L chart it is the only value that means
 * something on its own, and without it a chart of pure losses looks exactly
 * like a chart of pure profit.
 */
const gridlines = (values, y, width, format) =>
  s(
    'g',
    {},
    ...values.flatMap((value) => [
      s('line', {
        x1: PAD.left,
        x2: width - PAD.right,
        y1: y(value),
        y2: y(value),
        class: value === 0 ? 'c-grid c-zero' : 'c-grid',
      }),
      s('text.c-axis', { x: PAD.left - 6, y: y(value) + 3.5, 'text-anchor': 'end' }, format(value)),
    ]),
  )

/**
 * Cumulative profit over time, with the area under the line filled.
 *
 * The area is split at zero rather than filled in one colour: the part of the
 * curve below the line is drawn in `--failed`, so a book that went underwater
 * and came back says so even at a glance. A single fill would render the two
 * halves identically.
 */
export const cumulativeChart = (points, { width = 720, height = 190, value = (p) => p.cumulativeGrossSats } = {}) => {
  const svg = frame(width, height, 'Cumulative gross profit over the window')
  if (points.length === 0) return svg

  const values = points.map(value)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const x = scale(points[0].at, points[points.length - 1].at, PAD.left, width - PAD.right)
  const y = scale(min, max, height - PAD.bottom, PAD.top)
  const zero = y(0)

  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.at)},${y(value(point))}`).join(' ')
  const area = `${path} L${x(points[points.length - 1].at)},${zero} L${x(points[0].at)},${zero} Z`

  svg.appendChild(gridlines(ticks(min, max), y, width, compact))
  // Clipped to either side of zero, so one path can serve both halves. Two
  // separate paths would have to be split at the exact crossing point, which
  // is arithmetic this does not need to get right to be correct.
  const id = `zero-${Math.random().toString(36).slice(2, 8)}`
  svg.appendChild(
    s(
      'defs',
      {},
      s('clipPath', { id: `${id}-up` }, s('rect', { x: 0, y: 0, width, height: Math.max(0, zero) })),
      s('clipPath', { id: `${id}-down` }, s('rect', { x: 0, y: zero, width, height: Math.max(0, height - zero) })),
    ),
  )
  svg.appendChild(s('path.c-area', { d: area, 'clip-path': `url(#${id}-up)` }))
  svg.appendChild(s('path.c-area.c-loss', { d: area, 'clip-path': `url(#${id}-down)` }))
  svg.appendChild(s('path.c-line', { d: path }))

  for (const point of points) {
    if (point.count === 0) continue
    svg.appendChild(
      titled(
        s('circle.c-dot', { cx: x(point.at), cy: y(value(point)), r: 2.5 }),
        `${clockLabel(point.at)} · ${point.count} swap${point.count === 1 ? '' : 's'} · ` +
          `${point.grossSats >= 0 ? '+' : ''}${point.grossSats.toLocaleString('en-US')} sats this bucket · ` +
          `${value(point).toLocaleString('en-US')} cumulative`,
      ),
    )
  }
  svg.appendChild(s('text.c-axis', { x: PAD.left, y: height - 8 }, clockLabel(points[0].at)))
  svg.appendChild(
    s(
      'text.c-axis',
      { x: width - PAD.right, y: height - 8, 'text-anchor': 'end' },
      clockLabel(points[points.length - 1].at),
    ),
  )
  return svg
}

/**
 * Per-bucket profit as bars, with at-risk sats overlaid.
 *
 * The overlay rather than a second chart: an operator asking "did we make money
 * on Tuesday" and an operator asking "did we lose a swap on Tuesday" are the
 * same operator, and two charts means comparing two x-axes by eye.
 */
export const barsChart = (points, { width = 720, height = 150 } = {}) => {
  const svg = frame(width, height, 'Gross profit and sats at risk, per bucket')
  if (points.length === 0) return svg

  const values = points.flatMap((point) => [point.grossSats, -point.atRiskSats])
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const y = scale(min, max, height - PAD.bottom, PAD.top)
  const span = (width - PAD.left - PAD.right) / points.length
  const bar = Math.max(1, Math.min(18, span - 2))

  svg.appendChild(gridlines(ticks(min, max), y, width, compact))
  points.forEach((point, index) => {
    const centre = PAD.left + span * (index + 0.5)
    const draw = (amount, className, label) => {
      if (amount === 0) return
      const top = Math.min(y(0), y(amount))
      svg.appendChild(
        titled(
          s('rect', {
            x: centre - bar / 2,
            y: top,
            width: bar,
            height: Math.max(1, Math.abs(y(amount) - y(0))),
            class: className,
          }),
          label,
        ),
      )
    }
    draw(
      point.grossSats,
      point.grossSats < 0 ? 'c-bar c-loss' : 'c-bar',
      `${clockLabel(point.at)} · ${point.grossSats.toLocaleString('en-US')} sats gross`,
    )
    // Downward, and in the risk colour. A loss is not a smaller profit.
    draw(
      -point.atRiskSats,
      'c-bar c-risk',
      `${clockLabel(point.at)} · ${point.atRiskSats.toLocaleString('en-US')} sats at risk`,
    )
  })
  return svg
}

/**
 * A horizontal bar per category — corridors, and duration bands.
 *
 * Horizontal because the labels are corridor pairs: `arkade:BTC->lightning:BTC`
 * does not fit under a vertical bar at any width this console has.
 */
export const categoryChart = (rows, { width = 720, rowHeight = 22, label, value, note } = {}) => {
  const height = Math.max(1, rows.length) * rowHeight + 10
  const svg = frame(width, height, 'Gross profit by category')
  if (rows.length === 0) return svg

  const amounts = rows.map(value)
  const min = Math.min(0, ...amounts)
  const max = Math.max(0, ...amounts)
  const left = 210
  const x = scale(min, max, left, width - 70)
  const zero = x(0)

  rows.forEach((row, index) => {
    const y = index * rowHeight + 6
    const amount = value(row)
    svg.appendChild(titled(s('text.c-cat', { x: 0, y: y + rowHeight / 2 }, label(row)), note ? note(row) : label(row)))
    svg.appendChild(
      titled(
        s('rect', {
          x: Math.min(zero, x(amount)),
          y: y + 3,
          width: Math.max(1, Math.abs(x(amount) - zero)),
          height: rowHeight - 10,
          class: amount < 0 ? 'c-bar c-loss' : 'c-bar',
        }),
        note ? note(row) : `${amount.toLocaleString('en-US')} sats`,
      ),
    )
    svg.appendChild(
      s(
        'text.c-axis',
        { x: width - 66, y: y + rowHeight / 2, 'text-anchor': 'start' },
        `${amount >= 0 ? '+' : ''}${compact(amount)}`,
      ),
    )
  })
  svg.appendChild(s('line.c-grid.c-zero', { x1: zero, x2: zero, y1: 2, y2: height - 4 }))
  return svg
}

/**
 * How long a fill took against how far its rate sat from its peers — the FX
 * decay chart.
 *
 * X IS LOGARITHMIC, and it has to be: fills cluster in the first seconds and
 * the interesting ones are hours out, so a linear axis stacks every ordinary
 * trade into one column at the origin and spends the whole width on the
 * outliers. `log10(1 + seconds)` keeps zero on the axis rather than at minus
 * infinity.
 *
 * Y is drift in basis points, signed so that ABOVE the line is in the solver's
 * favour. Points below it are fills that came in worse than their peers, and
 * the shape worth looking for is those points drifting rightward — a book
 * whose margin erodes with time-to-fill.
 */
export const decayChart = (points, { width = 720, height = 210 } = {}) => {
  const svg = frame(width, height, 'Rate drift against time to fill')
  if (points.length === 0) return svg

  const logged = (seconds) => Math.log10(1 + Math.max(0, seconds))
  const drifts = points.map((point) => point.driftBps ?? 0)
  const spread = Math.max(10, ...drifts.map(Math.abs))
  const x = scale(
    0,
    Math.max(logged(3_600), ...points.map((p) => logged(p.durationSeconds))),
    PAD.left,
    width - PAD.right,
  )
  const y = scale(-spread, spread, height - PAD.bottom, PAD.top)

  svg.appendChild(gridlines(ticks(-spread, spread), y, width, (value) => `${Math.round(value)}bp`))
  for (const seconds of [1, 60, 3_600, 86_400]) {
    const at = x(logged(seconds))
    if (at > width - PAD.right) continue
    svg.appendChild(s('line.c-grid', { x1: at, x2: at, y1: PAD.top, y2: height - PAD.bottom }))
    svg.appendChild(
      s(
        'text.c-axis',
        { x: at, y: height - 8, 'text-anchor': 'middle' },
        seconds < 60
          ? `${seconds}s`
          : seconds < 3_600
            ? `${seconds / 60}m`
            : seconds < 86_400
              ? `${seconds / 3600}h`
              : '1d',
      ),
    )
  }

  for (const point of points) {
    const drift = point.driftBps ?? 0
    svg.appendChild(
      titled(
        s('circle.c-dot', {
          cx: x(logged(point.durationSeconds)),
          cy: y(drift),
          r: 3,
          // Coloured only when the fill came in WORSE than its peers, which is
          // the only thing on this chart anybody needs to act on.
          class: drift < 0 ? 'c-dot c-loss' : 'c-dot',
        }),
        `${point.id} · ${point.durationSeconds}s to fill · ${drift >= 0 ? '+' : ''}${drift}bp against the window mean`,
      ),
    )
  }
  return svg
}
