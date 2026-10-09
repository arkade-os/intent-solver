/**
 * The one paging loop behind every indexer read here. Advancing on the page
 * the server REPORTS lets a server that ignores `pageIndex` pin the loop; that
 * and the page ceiling both throw, because stopping quietly would hand a caller
 * deciding what to spend a truncated view of a script's outputs.
 */
import type { IndexerProvider, PageResponse, VirtualCoin } from '@arkade-os/sdk'

export class IndexerPagingError extends Error {}

type VtxoQuery = NonNullable<Parameters<IndexerProvider['getVtxos']>[0]>

/** The ceiling `arkd`'s own indexer client uses; it clamps a vtxo page to 100 rows. */
const MAX_PAGES = 1000

const PAGE_SIZE = 500

/** `arkd`'s own `maxPageSizeVirtualTxs`, spent as the REQUEST size too: these txids
 * ride in the URL path, so an unbounded list is a request a proxy rejects outright. */
const VIRTUAL_TX_PAGE_SIZE = 100

/** ONE-based on the wire: `arkd` clamps a requested 0 up to 1, so `current >= total` is the last page. */
async function* pages<T>(
  fetch: (pageIndex: number) => Promise<{ items: T[]; page?: PageResponse }>,
): AsyncGenerator<T[]> {
  let pageIndex = 0
  for (let requests = 1; ; requests++) {
    const { items, page } = await fetch(pageIndex)
    yield items
    if (items.length === 0 || !page || page.current >= page.total) return
    if (requests >= MAX_PAGES) throw new IndexerPagingError(`indexer served more than ${MAX_PAGES} pages`)
    if (!Number.isInteger(page.next) || page.next <= pageIndex) {
      throw new IndexerPagingError(
        `indexer did not advance past page ${pageIndex}: reported current ${page.current}, next ${page.next}`,
      )
    }
    pageIndex = page.next
  }
}

export function vtxoPages(indexer: Pick<IndexerProvider, 'getVtxos'>, query: VtxoQuery): AsyncGenerator<VirtualCoin[]> {
  return pages(async (pageIndex) => {
    const { vtxos, page } = await indexer.getVtxos({ ...query, pageIndex, pageSize: PAGE_SIZE })
    return { items: vtxos ?? [], page }
  })
}

export async function* virtualTxPages(
  indexer: Pick<IndexerProvider, 'getVirtualTxs'>,
  txids: readonly string[],
): AsyncGenerator<string[]> {
  for (let from = 0; from < txids.length; from += VIRTUAL_TX_PAGE_SIZE) {
    const chunk = txids.slice(from, from + VIRTUAL_TX_PAGE_SIZE)
    yield* pages(async (pageIndex) => {
      const { txs, page } = await indexer.getVirtualTxs(chunk, { pageIndex, pageSize: VIRTUAL_TX_PAGE_SIZE })
      return { items: txs ?? [], page }
    })
  }
}
