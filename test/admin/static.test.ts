/**
 * Path containment above all.
 *
 * This port has no authentication by deployment decision, so a traversal bug
 * would hand anything that can reach it the contents of the filesystem — the
 * `.env` holding the mnemonic included. These cases are the reason
 * `resolveWithin` tests the RESOLVED path rather than filtering for `..`.
 */

import { describe, it, expect } from 'vitest'
import { resolveWithin, contentTypeFor, readStaticFile, staticRoot } from '@arkade-os/solver-app/admin/static.js'
import { ACTIONS } from '@arkade-os/solver-app/admin/routes/actions.js'
import { buildAdminApp } from '@arkade-os/solver-app/admin/server.js'

const root = staticRoot()

describe('resolveWithin', () => {
  it('resolves an ordinary asset inside the root', () => {
    expect(resolveWithin(root, '/app.js')).toContain('app.js')
  })

  it('refuses a plain traversal', () => {
    expect(resolveWithin(root, '/../../package.json')).toBeNull()
  })

  it('refuses a traversal that only escapes after normalisation', () => {
    expect(resolveWithin(root, '/assets/../../../package.json')).toBeNull()
  })

  it('refuses a deeply nested escape', () => {
    expect(resolveWithin(root, '/../'.repeat(20) + 'etc/passwd')).toBeNull()
  })

  it('refuses a NUL byte, which can truncate a path in a lower layer', () => {
    expect(resolveWithin(root, '/app.js\0.png')).toBeNull()
  })

  it('refuses a malformed percent escape rather than guessing', () => {
    expect(resolveWithin(root, '/%E0%A4%A')).toBeNull()
  })

  it('keeps a path that merely CONTAINS dots', () => {
    expect(resolveWithin(root, '/vendor/some.min.js')).not.toBeNull()
  })

  it('refuses an absolute path smuggled in', () => {
    // Leading slashes are stripped and the result joined to root, so this can
    // only ever land inside it.
    const resolved = resolveWithin(root, '//etc/passwd')
    expect(resolved === null || resolved.startsWith(root)).toBe(true)
  })
})

describe('contentTypeFor', () => {
  it('serves JavaScript as JavaScript, or the module never loads', () => {
    expect(contentTypeFor('/app.js')).toContain('text/javascript')
  })

  it('labels html and css correctly', () => {
    expect(contentTypeFor('/index.html')).toContain('text/html')
    expect(contentTypeFor('/styles.css')).toContain('text/css')
  })

  it('falls back to a non-executable type for anything unknown', () => {
    expect(contentTypeFor('/thing.weird')).toBe('application/octet-stream')
  })
})

describe('readStaticFile', () => {
  it('serves the shipped index', async () => {
    const file = await readStaticFile('/')
    expect(file?.contentType).toContain('text/html')
    expect(file?.body.toString()).toContain('<div id="root">')
  })

  it('serves the stylesheet and the app', async () => {
    expect((await readStaticFile('/styles.css'))?.body.toString()).toContain('--exposed')
    expect((await readStaticFile('/app.js'))?.body.toString()).toContain('phaseChip')
  })

  it('falls back to index.html for a client route, so the client owns its own routing', async () => {
    const file = await readStaticFile('/swaps')
    expect(file?.contentType).toContain('text/html')
  })

  it('returns null for a missing asset rather than throwing', async () => {
    expect(await readStaticFile('/nope.css')).toBeNull()
  })
})

describe('the app serving static files', () => {
  const app = () => buildAdminApp({ services: {} as never, startedAt: 1, mode: 'relay' })

  it('serves the console at /', async () => {
    const response = await app().fetch(new Request('http://admin/'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('does NOT serve a file outside the static root', async () => {
    const response = await app().fetch(new Request('http://admin/../../package.json'))
    expect(response.status).toBe(404)
  })

  it('keeps /api 404s as JSON rather than falling through to the client', async () => {
    const response = await app().fetch(new Request('http://admin/api/nothing-here'))
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

/**
 * The client is untyped browser code and the registry is TypeScript, so nothing
 * connects the two: a mistyped action name in `app.js` compiles, ships, renders
 * a button, and 404s the first time an operator presses it — which for these
 * actions is the middle of an incident.
 */
describe('the console client and the action registry agree', () => {
  it('references only actions the server actually defines', async () => {
    const source = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    const referenced = [...source.matchAll(/(?:runAction|armDialog)\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1])

    expect(referenced.length).toBeGreaterThan(0)
    for (const name of referenced) expect(Object.keys(ACTIONS), name).toContain(name)
  })

  it('offers both halves of the stuck-send decision, not just the refund', async () => {
    // Shipping `refund-now` without the read that vets it, or without the claim
    // it vets FOR, is the shape that makes a double payout a single click.
    const source = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    expect(source).toContain('read-payment')
    expect(source).toContain('claim-now')
  })
})

/**
 * The console builds explorer URLs in untyped browser code, from bases the
 * server sends. These pin the parts that a typo makes silently wrong: a link to
 * the wrong chain answers "not found" and reads like lost funds.
 */
describe('the console explorer links', () => {
  const source = async () => (await readStaticFile('/app.js'))?.body.toString() ?? ''

  it('reads its bases from the server payload, never a local table', async () => {
    const js = await source()
    expect(js).toContain('state.overview?.explorers')
    // A second copy of the network table in the client is the copy that
    // eventually points a mainnet swap at a signet explorer.
    for (const base of ['arkade.space', 'mempool.arkade.sh', 'explorer.signet', 'localhost:7080']) {
      expect(js, base).not.toContain(base)
    }
  })

  it('sends L1 fields to the onchain explorer and Arkade fields to the Arkade one', async () => {
    const js = await source()
    // Links now hang off the timeline step they belong to, so the pairing lives
    // in `stepLinks` rather than a flat field list.
    for (const pair of [
      "['lockupTxid', 'arkade'",
      "['onchainLockupTxid', 'onchain'",
      "['fundingTxid', 'onchain'",
      "['onchainClaimTxid', 'onchain'",
    ]) {
      expect(js, pair).toContain(pair)
    }
  })

  it('isolates the opener, since this console has no authentication', async () => {
    expect(await source()).toContain('noreferrer noopener')
  })

  it('encodes the identifier rather than concatenating it raw', async () => {
    expect(await source()).toContain('encodeURIComponent')
  })
})

/**
 * The console must tell an operator which action the evidence supports.
 *
 * Five equal-looking buttons, three of which move real money, produced exactly
 * the behaviour you would predict: pressing them in turn to see what happens.
 * On this screen that is how a double payout starts.
 */
describe('the console guides the operator', () => {
  const source = async () => (await readStaticFile('/app.js'))?.body.toString() ?? ''

  it('does not let `paid` read as settled', async () => {
    // `paid` means "payment id known, preimage maybe not". Read as "we paid",
    // it argues against the refund that a terminally-failed row actually needs.
    const js = await source()
    expect(js).toContain("paid: 'backend accepted it")
    expect(js).toMatch(/paid: '[^']*NOT known/)
  })

  it('derives which money action is supported from the last read-payment', async () => {
    const js = await source()
    expect(js).toContain('readVerdict')
    expect(js).toContain('paid-do-not-refund')
    expect(js).toContain('not-paid-refund-is-safe')
  })

  it('treats never-submitted as refundable ONLY when the backend confirmed it holds nothing', async () => {
    // With the probe unavailable, `never-submitted` is a weaker claim than it
    // sounds — the row may be one whose hash is registered with no commitment.
    expect(await source()).toContain("r.result?.commitment === 'none'")
  })

  it('treats "no read yet" the same as an unsupported verdict', async () => {
    // The dangerous default is assuming the operator checked.
    expect(await source()).toContain('const contrary = money && !read?.supports[name]')
  })

  it('keeps a contrary action clickable, behind an override', async () => {
    const js = await source()
    // Gated, not removed: a verdict can be unavailable and an operator can know
    // better, so the path must exist rather than dead-end.
    expect(js).toContain('overridden')
    expect(js).toContain('want to proceed anyway')
  })

  it('requires BOTH the typed confirmation and the override tick', async () => {
    expect(await source()).toContain('d.typed === d.expects && (!d.override || d.overridden)')
  })

  it('names what the read said rather than asking a generic are-you-sure', async () => {
    // The generic question is the one people answer without reading.
    expect(await source()).toContain('The last read-payment on this swap said')
  })
})

describe('the console timeline shows notes, not just transitions', () => {
  it('renders a note distinctly from a state change', async () => {
    const js = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    // A refund appearing with no timeline entry is what made an operator ask
    // where it had come from; rendering it as `x → x` would be worse.
    expect(js).toContain('step.detail')
  })
})

describe('the console says where a payment actually settles', () => {
  it('marks `claiming` as the settlement state, not `paid`', async () => {
    // `claiming` is the only state that proves anything: the only way in is
    // `claimWithPreimage`, which refuses a preimage that does not hash to the
    // payment hash. `paid` merely means the backend took the request.
    const js = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    expect(js).toContain('SETTLED — preimage proves it')
    expect(js).toContain('outcome NOT known')
  })
})

describe('the console stops hiding what it knows', () => {
  const source = async () => (await readStaticFile('/app.js'))?.body.toString() ?? ''

  it('says the client is whole when a stuck row was refunded', async () => {
    // `stuck` beside a pushed refund reads as an unresolved loss. It is not:
    // `stuck` says an operator should look at WHY the payment died, and the
    // client is told `refunded`, never `stuck`.
    expect(await source()).toContain('The client has been refunded')
  })

  it('glosses states in the TIMELINE, not only on the chip', async () => {
    // The timeline row is where `paid` was read as "we paid".
    // Via `stateRead`, which also reads the row: a `stuck` swap whose refund
    // was pushed must not be glossed "needs a human".
    expect(await source()).toContain('stateRead(step.to, d.raw)')
  })

  it('puts the evidence on the step it belongs to', async () => {
    const js = await source()
    expect(js).toContain('stepLinks')
    // A separate list made the reader hold a txid in their head while working
    // out which line it came from.
    expect(js).not.toContain('explorerLinks(d.raw)')
  })

  it('leads with what to do next, before offering buttons', async () => {
    expect(await source()).toContain('nextStep(d)')
  })
})

describe('history notes carry their own transaction links', () => {
  it('linkifies the ids a note names, rather than a list elsewhere', async () => {
    const js = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    expect(js).toContain('noteLinks')
    expect(js).toContain('shortenIds')
  })

  it('contains no control characters, which an escape can leak into a regex', async () => {
    // A literal backspace once landed in the id-matching pattern. The notes
    // still rendered, the links silently did not, and neither `node --check`
    // nor any test could see it — the character is invisible in a diff.
    //
    // Numeric codes, no escapes: writing this guard with escape sequences is
    // how the bug got in.
    const js = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    const TAB = 9
    const LF = 10
    const CR = 13
    const control = [...js]
      .map((c) => c.charCodeAt(0))
      .filter((code) => code < 32 && code !== TAB && code !== LF && code !== CR)

    expect(control).toEqual([])
  })
})

describe('a stuck row that was already refunded', () => {
  it('is not glossed as needing a human', async () => {
    // #182 makes NEW rows close as `refused`. Rows that reached `stuck` before
    // that keep it forever, and those are the ones on screen today — so the
    // reading has to come from the row, not from the state alone.
    const js = (await readStaticFile('/app.js'))?.body.toString() ?? ''
    expect(js).toContain("raw?.refundOutcome ? 'client refunded")
  })
})
