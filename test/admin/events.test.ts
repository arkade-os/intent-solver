import { describe, it, expect, vi } from 'vitest'
import { createChangeFeed } from '@arkade-os/solver-app/admin/events.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'

const row = (id: string, state: string) => ({
  id,
  state,
  createdAt: 1,
  updatedAt: 1,
  amountSats: 1_000,
  payoutSats: 990,
  paymentHash: id,
  failureReason: null,
})

/** A store whose live set can be changed between polls. */
const store = (initial: ReturnType<typeof row>[] = []) => {
  let rows = initial
  return {
    findRecoverable: vi.fn(async () => rows),
    set: (next: ReturnType<typeof row>[]) => {
      rows = next
    },
  }
}

const servicesWith = (send: ReturnType<typeof store>) =>
  ({
    store: send,
    receiveStore: store(),
    onchainStore: store(),
    onchainReceiveStore: store(),
  }) as unknown as Services

describe('the change feed', () => {
  it('announces nothing on the first poll — an operator opening the console is not a change', async () => {
    const send = store([row('a', 'quoted'), row('b', 'paying')])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()
    expect(seen).not.toHaveBeenCalled()
  })

  it('emits exactly one event when a swap changes state', async () => {
    const send = store([row('a', 'quoted')])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()

    send.set([row('a', 'funded')])
    await feed.poll()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0]![0]).toEqual([
      { corridor: 'arkade:BTC->lightning:BTC', id: 'a', from: 'quoted', to: 'funded', phase: 'open' },
    ])
  })

  it('emits nothing when nothing moved', async () => {
    const send = store([row('a', 'quoted')])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()
    await feed.poll()
    await feed.poll()
    expect(seen).not.toHaveBeenCalled()
  })

  it('reports a newly quoted swap with a null previous state', async () => {
    const send = store([])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()

    send.set([row('new', 'quoted')])
    await feed.poll()
    expect(seen.mock.calls[0]![0]).toMatchObject([{ id: 'new', from: null, to: 'quoted' }])
  })

  it('announces a swap leaving the live set — that is how it leaves the attention list', async () => {
    const send = store([row('a', 'claiming')])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()

    send.set([])
    await feed.poll()
    expect(seen.mock.calls[0]![0]).toMatchObject([{ id: 'a', from: 'claiming', to: 'terminal' }])
  })

  it('survives a store that throws, and keeps working on the next poll', async () => {
    const send = store([row('a', 'quoted')])
    const onError = vi.fn()
    const feed = createChangeFeed(servicesWith(send), { onError })
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()

    send.findRecoverable.mockRejectedValueOnce(new Error('database is locked'))
    await feed.poll()
    expect(onError).toHaveBeenCalledOnce()
    expect(seen).not.toHaveBeenCalled()

    // A transient lock must not end live updates for the life of the process.
    send.set([row('a', 'funded')])
    await feed.poll()
    expect(seen).toHaveBeenCalledOnce()
  })

  it('does not let one broken subscriber deny the others their update', async () => {
    const send = store([row('a', 'quoted')])
    const onError = vi.fn()
    const feed = createChangeFeed(servicesWith(send), { onError })
    const good = vi.fn()
    feed.subscribe(() => {
      throw new Error('listener blew up')
    })
    feed.subscribe(good)
    await feed.poll()

    send.set([row('a', 'funded')])
    await feed.poll()
    expect(good).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('stops delivering after unsubscribe', async () => {
    const send = store([row('a', 'quoted')])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    const off = feed.subscribe(seen)
    await feed.poll()
    off()

    send.set([row('a', 'funded')])
    await feed.poll()
    expect(seen).not.toHaveBeenCalled()
  })

  it('collapses intermediate states rather than inventing events it did not observe', async () => {
    const send = store([row('a', 'quoted')])
    const feed = createChangeFeed(servicesWith(send))
    const seen = vi.fn()
    feed.subscribe(seen)
    await feed.poll()

    // paying and paid both happened between polls; the feed only ever saw the end.
    send.set([row('a', 'claiming')])
    await feed.poll()
    expect(seen.mock.calls[0]![0]).toMatchObject([{ from: 'quoted', to: 'claiming' }])
  })
})
