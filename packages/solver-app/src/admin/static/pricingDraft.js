import { applyPricing } from './pricingSave.js'

export class PricingDraft {
  markets = new Map()
  overrides = {}
  busy = false

  get size() {
    return this.markets.size + Object.keys(this.overrides).length
  }

  editable() {
    if (this.busy) throw new Error('Pricing changes are applying; wait for the result.')
  }

  stageMarket(key, body) {
    this.editable()
    this.markets.set(key, JSON.parse(JSON.stringify(body)))
  }

  stageOverride(key, value) {
    this.editable()
    this.overrides[key] = value
  }

  discard() {
    this.editable()
    this.markets.clear()
    this.overrides = {}
  }

  payload() {
    return JSON.parse(JSON.stringify({ markets: [...this.markets.values()], overrides: this.overrides }))
  }

  previewOverrides(knobs) {
    const values = Object.fromEntries(knobs.filter((k) => k.editable).map((k) => [k.key, String(k.value)]))
    for (const [key, value] of Object.entries(this.overrides)) {
      const knob = knobs.find((k) => k.key === key)
      if (value === null && knob?.envValue === undefined) {
        delete values[key]
        continue
      }
      values[key] = value === null ? String(knob.envValue) : value
    }
    return values
  }

  async apply(api) {
    this.editable()
    if (this.size === 0) return null
    const payload = this.payload()
    this.busy = true
    const reconcile = (answer) => {
      const refused = new Set((answer?.unapplied ?? []).map((item) => item.key))
      for (const key of answer?.applied ?? []) {
        if (refused.has(key)) continue
        this.markets.delete(key)
        delete this.overrides[key]
      }
    }
    try {
      const result = await applyPricing(api, payload)
      reconcile(result)
      return result
    } catch (error) {
      reconcile(error)
      throw error
    } finally {
      this.busy = false
    }
  }
}
