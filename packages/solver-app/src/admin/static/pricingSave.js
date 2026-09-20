/** The console's one write to pricing: `POST /api/pricing/apply`. Its own module for the reason `charts.js` is —
 *  `app.js` has no exports, so its contents can only be READ by a test, and this claim has to be RUN. */

export const APPLY_PATH = '/api/pricing/apply'

const sentence = (entry) => `${entry.key}: ${entry.reason}`

/** The route answers 200 whether or not anything landed, so `api()`'s throw-on-non-2xx never fires and a caller
 *  that forgets `unapplied` reports a refused save as saved. `applied` rides the message: a save can land one half. */
export const applyPricing = async (api, payload) => {
  const result = await api(APPLY_PATH, { method: 'POST', body: JSON.stringify(payload) })
  const unapplied = result?.unapplied ?? []
  const applied = result?.applied ?? []
  if (unapplied.length === 0) return result
  const suffix = applied.length === 0 ? '' : ` — applied: ${applied.join(', ')}`
  const error = new Error(`${unapplied.map(sentence).join('; ')}${suffix}`)
  error.applied = applied
  error.unapplied = unapplied
  error.revision = result?.revision ?? null
  throw error
}
