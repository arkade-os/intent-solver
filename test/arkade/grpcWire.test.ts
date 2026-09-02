/**
 * The wire codec for arkd's filtered subscription. Hand-rolled, so every claim
 * it makes is pinned here — a mis-skipped field silently returns the wrong
 * string rather than failing.
 */
import { describe, it, expect } from 'vitest'
import {
  encodeSubscriptionRequest,
  grpcFrame,
  decodeSubscriptionResponse,
  readFrames,
} from '@arkade-os/solver-arkade/arkade/grpcWire.js'

const utf8 = new TextEncoder()
/** field<<3 | 2, length, bytes — the shape the decoder must read. */
const lenField = (field: number, payload: Uint8Array): number[] => [field * 8 + 2, payload.length, ...payload]

describe('encodeSubscriptionRequest', () => {
  it('nests the expression under filter, leaving subscription_id absent', () => {
    // subscription_id present is precisely when arkd IGNORES the filter, so its
    // absence is the contract, not a saving.
    const bytes = encodeSubscriptionRequest(['has(tx.extension)'])
    expect(bytes[0]).toBe(0x12) // field 2 (filter), wire type 2
    expect(bytes[2]).toBe(0x0a) // inner field 1 (expressions), wire type 2
    expect(new TextDecoder().decode(bytes.subarray(4))).toBe('has(tx.extension)')
  })

  it('carries several expressions, which arkd ORs', () => {
    const bytes = encodeSubscriptionRequest(['a', 'bb'])
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('a')
    expect(text).toContain('bb')
  })

  it('length-prefixes a long expression correctly', () => {
    const long = 'x'.repeat(200)
    const bytes = encodeSubscriptionRequest([long])
    // 200 needs a two-byte varint, so a naive single-byte length would truncate.
    expect(new TextDecoder().decode(bytes).includes(long)).toBe(true)
  })
})

describe('grpcFrame', () => {
  it('prefixes an uncompressed flag and a big-endian length', () => {
    const framed = grpcFrame(Uint8Array.from([1, 2, 3]))
    expect([...framed.subarray(0, 5)]).toEqual([0, 0, 0, 0, 3])
    expect([...framed.subarray(5)]).toEqual([1, 2, 3])
  })
})

describe('decodeSubscriptionResponse', () => {
  const event = (fields: number[]) => Uint8Array.from(lenField(2, Uint8Array.from(fields)))

  it('reads txid and tx off an event', () => {
    const inner = [...lenField(1, utf8.encode('deadbeef')), ...lenField(5, utf8.encode('cHNidP8='))]
    expect(decodeSubscriptionResponse(event(inner))).toEqual({ txid: 'deadbeef', tx: 'cHNidP8=' })
  })

  it('refuses a varint past the exact integer range rather than rounding it', () => {
    // Eight continuation bytes reach shift 49, where one byte contributes up to
    // 2^56 — past the 2^53 a JS number holds exactly. Rounding here is not a
    // wrong number in isolation: a length read too small or too large frames
    // every following field at the wrong offset, and the decoder would return a
    // confidently wrong txid instead of failing.
    const past2p53 = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])
    expect(() => decodeSubscriptionResponse(past2p53)).toThrow(/exact integer range/)
  })

  it('answers null for a heartbeat, which is normal traffic', () => {
    expect(decodeSubscriptionResponse(Uint8Array.from(lenField(1, Uint8Array.from([]))))).toBeNull()
  })

  it('answers null for subscription_started', () => {
    expect(decodeSubscriptionResponse(Uint8Array.from(lenField(3, utf8.encode('sub-1'))))).toBeNull()
  })

  it('SKIPS unknown fields by wire type rather than misreading them', () => {
    // arkd may add fields. A decoder that mis-skips one misaligns every field
    // after it and returns a wrong string with no error.
    const inner = [
      ...lenField(1, utf8.encode('txid-1')),
      8 * 8 + 0, // field 8, varint
      0x96,
      0x01, // 150
      9 * 8 + 5, // field 9, fixed32
      1,
      2,
      3,
      4,
      10 * 8 + 1, // field 10, fixed64
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      ...lenField(5, utf8.encode('the-tx')),
    ]
    expect(decodeSubscriptionResponse(event(inner))).toEqual({ txid: 'txid-1', tx: 'the-tx' })
  })

  it('refuses a length that overruns the message', () => {
    // Truncation must fail loudly; a clamped read would hand back half a tx.
    expect(() => decodeSubscriptionResponse(Uint8Array.from([0x12, 0x40, 0x01]))).toThrow(/overruns/)
  })

  it('refuses an unsupported wire type rather than guessing', () => {
    expect(() => decodeSubscriptionResponse(Uint8Array.from([2 * 8 + 3]))).toThrow(/wire type/)
  })
})

describe('readFrames', () => {
  it('splits several frames out of one buffer', () => {
    const buffer = new Uint8Array([...grpcFrame(Uint8Array.from([1])), ...grpcFrame(Uint8Array.from([2, 3]))])
    const { messages, rest } = readFrames(buffer)
    expect(messages.map((m) => [...m])).toEqual([[1], [2, 3]])
    expect(rest.length).toBe(0)
  })

  it('KEEPS a partial frame for the next chunk', () => {
    // Frames do not align with chunk boundaries. Dropping the tail here loses
    // the end of every large event.
    const whole = grpcFrame(Uint8Array.from([1, 2, 3, 4]))
    const { messages, rest } = readFrames(whole.subarray(0, 7))
    expect(messages).toHaveLength(0)
    expect(rest.length).toBe(7)
  })

  it('keeps a header shorter than the 5-byte prefix', () => {
    const { messages, rest } = readFrames(Uint8Array.from([0, 0]))
    expect(messages).toHaveLength(0)
    expect(rest.length).toBe(2)
  })
})
