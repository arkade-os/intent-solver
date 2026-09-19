/** Types for `pricingSave.js`, present for the reason `charts.d.ts` is: the module is IMPORTED BY A
 *  TEST, and an untyped import is invisible to `pnpm build` and an error to `pnpm typecheck`. */

export interface ApplyRefusal {
  key: string
  reason: string
}

export interface ApplyAnswer {
  revision: string
  applied: string[]
  unapplied: ApplyRefusal[]
}

export interface ApplyPayload {
  markets?: unknown[]
  overrides?: Record<string, string | null>
}

export type ApiCall = (path: string, options?: { method?: string; body?: string }) => Promise<unknown>

export interface ApplyError extends Error {
  applied: string[]
  unapplied: ApplyRefusal[]
  revision: string | null
}

export declare const APPLY_PATH: string

export declare const applyPricing: (api: ApiCall, payload: ApplyPayload) => Promise<ApplyAnswer>
