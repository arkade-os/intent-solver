import type { Asset } from './asset.js'
import type { ValueOf } from './brand.js'

export const Rail = {
  Arkade: 'arkade',
  Lightning: 'lightning',
  Onchain: 'onchain',
  Evm: 'evm',
} as const

export type Rail = ValueOf<typeof Rail>

/** Where value sits: one asset on one rail. */
export class Endpoint {
  private constructor(
    readonly rail: Rail,
    readonly asset: Asset,
  ) {}

  static of(rail: Rail, asset: Asset): Endpoint {
    return new Endpoint(rail, asset)
  }

  get key(): string {
    return `${this.rail}:${this.asset}`
  }

  equals(other: Endpoint): boolean {
    return this.rail === other.rail && this.asset === other.asset
  }
}
