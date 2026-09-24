/**
 * The four-method adapter, assembled where the read half already is.
 *
 * The declared return type is the whole {@link ReceiveCarrierQuotes}, so the
 * compiler — not the orchestrator's runtime gate — is what proves this one is
 * complete. The gate still stands behind it for anything else handed in.
 */

import { ArkAddress, type Identity, type IndexerProvider, type IWallet } from '@arkade-os/sdk'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { ReceiveCarrierQuotes } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import { taxiClientCache, type CarrierCoin, type CarrierOutpoint, type CarrierPinLedger } from './assetRfqTaxi.js'
import {
  carrierFillSigner,
  createTaxiReceiveCarrierSettler,
  type CarrierAttemptStore,
  type CarrierTaxi,
} from './assetRfqTaxiSettle.js'
import { createTaxiReceiveCarrierObserver, type CarrierProofStore } from './assetRfqTaxiProof.js'
import { createCarrierFillRebuilder } from './assetRfqTaxiRebuild.js'
import { normalizeTaxiUrl, type TaxiUrlPolicy } from './taxiUrlGuard.js'

export interface TaxiCarrierFillComposition {
  /** Only a row naming no Taxi of its own needs it (G4). */
  taxiUrl?: string
  policy: TaxiUrlPolicy
  fetch?: typeof fetch
  store: CarrierAttemptStore & CarrierProofStore
  chain: Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>
  pins: CarrierPinLedger
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
  wallet: IWallet
  identity: Identity
  arkServerUrl: string
  dustSats: bigint
  offerHex: (row: AssetRfqSwapRow) => string
  /** Where a fill pays this solver back — its own address, never the quote's. */
  proceedsAddress: string
  solverKeys: readonly string[]
  serverKey: () => Uint8Array
  now: () => number
}

export class CarrierTaxiRefusedError extends Error {
  constructor(rowId: string, url: string, cause: unknown) {
    super(`carrier fill ${rowId} names Taxi ${url}, which this solver's URL policy refuses: ${messageOf(cause)}`, {
      cause,
    })
    this.name = 'CarrierTaxiRefusedError'
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Keyed on the row's MODE, never on URL equality: a named Taxi spelling `TAXI_URL` is still a payer's input (G3). */
export const carrierTaxiFor = (
  deps: Pick<TaxiCarrierFillComposition, 'taxiUrl' | 'policy' | 'fetch'>,
): ((row: AssetRfqSwapRow) => CarrierTaxi) => {
  const configured = deps.taxiUrl?.trim() || undefined
  const clientFor = taxiClientCache({ configuredUrl: configured, policy: deps.policy, fetch: deps.fetch })
  return (row) => {
    const terms = row.carrierTerms
    if (terms?.mode === 'recycle_receiver') {
      let provider: string
      try {
        provider = normalizeTaxiUrl(terms.taxiUrl ?? '', deps.policy)
      } catch (cause) {
        throw new CarrierTaxiRefusedError(row.id, String(terms.taxiUrl), cause)
      }
      return { provider, providerKey: terms.taxiKey, swapFills: clientFor(provider) }
    }
    // Throws first when no Taxi is configured, so `configured` is set below.
    const swapFills = clientFor(undefined)
    return { provider: configured!, swapFills }
  }
}

export const completeTaxiReceiveCarrier = (
  reader: Pick<ReceiveCarrierQuotes, 'resolve' | 'available'>,
  deps: TaxiCarrierFillComposition,
): ReceiveCarrierQuotes => {
  const proceedsScript = ArkAddress.decode(deps.proceedsAddress).pkScript
  return {
    ...reader,
    ...createTaxiReceiveCarrierSettler({
      store: deps.store,
      taxiFor: carrierTaxiFor(deps),
      resolve: reader.resolve,
      coins: deps.coins,
      reserved: deps.reserved,
      reserve: deps.reserve,
      pins: deps.pins,
      dustSats: deps.dustSats,
      offerHex: deps.offerHex,
      proceedsScript,
      solverKeys: deps.solverKeys,
      serverKey: deps.serverKey,
      fill: {
        rebuild: createCarrierFillRebuilder({ wallet: deps.wallet, arkServerUrl: deps.arkServerUrl }),
        sign: carrierFillSigner(deps.identity),
      },
      now: deps.now,
    }),
    ...createTaxiReceiveCarrierObserver({ store: deps.store, chain: deps.chain, pins: deps.pins }),
  }
}
