import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createNotifier, type NotifySink } from '@arkade-os/solver-app/ops/notify.js'

const recordingSink = (name = 'telegram'): NotifySink & { sent: string[] } => {
  const sent: string[] = []
  return { name, sent, send: async (text: string) => void sent.push(text) }
}

const failingSink = (failures: number, name = 'slack') => {
  let calls = 0
  return {
    name,
    calls: () => calls,
    send: async () => {
      calls += 1
      if (calls <= failures) throw new Error('429 rate limited')
    },
  }
}

const noSleep = async () => {}

describe('createNotifier', () => {
  it('is a no-op with no sinks — an unconfigured deployment makes no calls', async () => {
    const notifier = createNotifier({ sinks: [], sleep: noSleep })
    notifier.post('anything')
    await notifier.flush()
    expect(notifier.stats()).toMatchObject({ sent: 0, dropped: 0, failed: 0 })
  })

  it('delivers to every configured sink', async () => {
    const a = recordingSink('telegram')
    const b = recordingSink('slack')
    const notifier = createNotifier({ sinks: [a, b], sleep: noSleep })
    notifier.post('a swap was fulfilled')
    await notifier.flush()
    expect(a.sent).toEqual(['a swap was fulfilled'])
    expect(b.sent).toEqual(['a swap was fulfilled'])
  })

  // The constraint the feature is written against: a hung sink must not stall
  // the caller.
  it('RETURNS BEFORE the sink is called, so a hung webhook cannot block a swap', () => {
    let touched = false
    const hung: NotifySink = { name: 'telegram', send: () => new Promise(() => void (touched = true)) }
    const notifier = createNotifier({ sinks: [hung], sleep: noSleep })
    notifier.post('x')
    expect(touched).toBe(false)
  })

  it('never throws out of post, whatever the sink does', () => {
    const explode: NotifySink = {
      name: 'telegram',
      send: () => {
        throw new Error('synchronous boom')
      },
    }
    const notifier = createNotifier({ sinks: [explode], sleep: noSleep })
    expect(() => notifier.post('x')).not.toThrow()
  })

  it('retries a failing sink up to the bound, then gives up and counts it', async () => {
    const flaky = failingSink(2)
    const notifier = createNotifier({ sinks: [flaky], attempts: 3, sleep: noSleep })
    notifier.post('x')
    await notifier.flush()
    expect(flaky.calls()).toBe(3)
    expect(notifier.stats().sent).toBe(1)

    const dead = failingSink(99)
    const second = createNotifier({ sinks: [dead], attempts: 3, sleep: noSleep })
    second.post('y')
    await second.flush()
    expect(dead.calls()).toBe(3)
    expect(second.stats()).toMatchObject({ sent: 0, failed: 1 })
  })

  it('drops the OLDEST message when the queue is full, and counts the drop', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sink: NotifySink & { sent: string[] } = {
      name: 'telegram',
      sent: [],
      send: async (text) => {
        await gate
        sink.sent.push(text)
      },
    }
    const notifier = createNotifier({ sinks: [sink], maxQueue: 2, sleep: noSleep })
    notifier.post('first')
    notifier.post('second')
    notifier.post('third')
    notifier.post('fourth')
    release()
    await notifier.flush()
    expect(notifier.stats().dropped).toBeGreaterThan(0)
    // Whatever survived, the newest did.
    expect(sink.sent).toContain('fourth')
    expect(sink.sent).not.toContain('second')
  })

  it('keeps counting across many messages', async () => {
    const sink = recordingSink()
    const notifier = createNotifier({ sinks: [sink], sleep: noSleep })
    for (let i = 0; i < 5; i++) notifier.post(`m${i}`)
    await notifier.flush()
    expect(notifier.stats().sent).toBe(5)
    expect(sink.sent).toHaveLength(5)
  })

  it('one sink failing does not stop the other being delivered to', async () => {
    const good = recordingSink('telegram')
    const bad = failingSink(99, 'slack')
    const notifier = createNotifier({ sinks: [bad, good], attempts: 1, sleep: noSleep })
    notifier.post('x')
    await notifier.flush()
    expect(good.sent).toEqual(['x'])
  })

  it('backs off between attempts through the injected sleep', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const dead = failingSink(99)
    const notifier = createNotifier({ sinks: [dead], attempts: 3, sleep })
    notifier.post('x')
    await notifier.flush()
    expect(sleep).toHaveBeenCalled()
  })
})

// Queued messages are lost at exit, and nothing at run time shows it.
describe('the notifier is FLUSHED before shutdown tears anything down', () => {
  const servicesSource = readFileSync(
    fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
    'utf8',
  )

  it('close() flushes it', () => {
    expect(servicesSource).toContain("['notifier', () => notifier.flush()]")
  })

  it('flushes BEFORE the first resource close, not after', () => {
    const flush = servicesSource.indexOf("['notifier', () => notifier.flush()]")
    const firstClose = servicesSource.indexOf("['store', () => store.close()]")
    expect(flush).toBeGreaterThan(-1)
    expect(flush).toBeLessThan(firstClose)
  })
})
