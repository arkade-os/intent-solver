/**
 * The one paging loop behind every `getVtxos` read here. Advancing on the page
 * the server REPORTS lets a server that ignores `pageIndex` pin the loop; that
 * and the page ceiling both throw, because stopping quietly would hand a caller
 * deciding what to spend a truncated view of a script's outputs.
 */
import type { IndexerProvider, VirtualCoin } from '@arkade-os/sdk'

export class IndexerPagingError extends Error {}

type VtxoQuery = NonNullable<Parameters<IndexerProvider['getVtxos']>[0]>

/** The ceiling `arkd`'s own indexer client uses; it clamps a vtxo page to 100 rows. */
const MAX_PAGES = 1000

const PAGE_SIZE = 500

/** ONE-based on the wire: `arkd` clamps a requested 0 up to 1, so `current >= total` is the last page. */
export async function* vtxoPages(
  indexer: Pick<IndexerProvider, 'getVtxos'>,
  query: VtxoQuery,
): AsyncGenerator<VirtualCoin[]> {
  let pageIndex = 0
  for (let requests = 1; ; requests++) {
    const { vtxos, page } = await indexer.getVtxos({ ...query, pageIndex, pageSize: PAGE_SIZE })
    const batch = vtxos ?? []
    yield batch
    if (batch.length === 0 || !page || page.current >= page.total) return
    if (requests >= MAX_PAGES) throw new IndexerPagingError(`indexer served more than ${MAX_PAGES} pages`)
    if (!Number.isInteger(page.next) || page.next <= pageIndex) {
      throw new IndexerPagingError(
        `indexer did not advance past page ${pageIndex}: reported current ${page.current}, next ${page.next}`,
      )
    }
    pageIndex = page.next
  }
}
