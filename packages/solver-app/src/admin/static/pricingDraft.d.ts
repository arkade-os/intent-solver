import type { ApiCall, ApplyAnswer, ApplyPayload } from './pricingSave.js'

export interface PricingKnob {
  key: string
  value: string | number | boolean
  envValue?: string | number | boolean
  editable: boolean
}

export declare class PricingDraft {
  markets: Map<string, Record<string, unknown>>
  overrides: Record<string, string | null>
  busy: boolean
  readonly size: number
  stageMarket(key: string, body: Record<string, unknown>): void
  stageOverride(key: string, value: string | null): void
  discard(): void
  payload(): ApplyPayload
  previewOverrides(knobs: PricingKnob[]): Record<string, string>
  apply(api: ApiCall): Promise<ApplyAnswer | null>
}
