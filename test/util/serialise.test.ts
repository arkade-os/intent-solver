// The primitive three call sites use to keep a live serve-list swap from
// landing between a quote's market lookup and its price.

import { describe, it, expect } from 'vitest'
import { createSerialiser } from '@arkade-os/solver-core/util/serialise.js'

const deferred = () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return { gate, release }
}

describe('createSerialiser', () => {
  it('runs jobs one at a time, in call order', async () => {
    const serialise = createSerialiser()
    const events: string[] = []
    const first = deferred()
    const a = serialise(async () => {
      events.push('a:start')
      await first.gate
      events.push('a:end')
    })
    const b = serialise(async () => {
      events.push('b:start')
    })
    first.release()
    await Promise.all([a, b])
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('does not poison the queue when a job rejects', async () => {
    const serialise = createSerialiser()
    await expect(serialise(async () => Promise.reject(new Error('feed down')))).rejects.toThrow('feed down')
    await expect(serialise(async () => 'served')).resolves.toBe('served')
  })

  it('gives each instance its own queue', async () => {
    const one = createSerialiser()
    const two = createSerialiser()
    const held = deferred()
    const blocked = one(() => held.gate)
    await expect(two(async () => 'through')).resolves.toBe('through')
    held.release()
    await blocked
  })
})
