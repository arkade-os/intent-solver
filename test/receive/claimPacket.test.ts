import { describe, it, expect } from 'vitest'
import { base64 } from '@scure/base'
import { appendArkadeScript, claimPacketShape } from '@arkade-os/swap'
import {
  claimPacketShape as solverClaimPacketShape,
  claimPacketStamp,
} from '@arkade-os/solver-corridors/receive/claimPacket.js'
import type { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import vector from './fixtures/delegateeReceiveTerms.json' with { type: 'json' }

/** `ephPub(33) || nonce(12) || AES-GCM of a 32-byte preimage (48)` — the shape `sealClaimPacket` emits. */
const sealedCiphertext = (): Uint8Array => Uint8Array.from({ length: 93 }, (_, i) => i & 0xff)

const tlv = (type: number, value: Uint8Array): Uint8Array =>
  Uint8Array.from([type, (value.length >> 8) & 0xff, value.length & 0xff, ...value])

const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]))

const ARKADE_SCRIPT = Uint8Array.from([0x51, 0x52])
const PUBKEY = Uint8Array.from([0x02, ...Array<number>(32).fill(0x11)])

const fullPacket = (): Uint8Array => concat(tlv(0x01, sealedCiphertext()), tlv(0x02, ARKADE_SCRIPT), tlv(0x03, PUBKEY))

describe('claimPacketShape', () => {
  it('keeps the solver-corridors claim-packet subpath importable', async () => {
    await expect(import('@arkade-os/solver-corridors/receive/claimPacket.js')).resolves.toMatchObject({
      claimPacketShape: expect.any(Function),
    })
  })

  it('keeps the old pubkey spelling on the solver-corridors subpath', async () => {
    const legacy = await import('@arkade-os/solver-corridors/receive/claimPacket.js')
    const shape = legacy.claimPacketShape(base64.encode(fullPacket()))
    expect(shape.kind).toBe('packet')
    if (shape.kind !== 'packet') return
    expect(shape.covclaimdPubKey).toEqual(PUBKEY)
  })

  it('reads a 93-byte blob as the sealed ciphertext', () => {
    expect(claimPacketShape(base64.encode(sealedCiphertext()))).toEqual({ kind: 'ciphertext' })
  })

  it('reads covclaimd’s TLV body as a packet, and recovers the covclaimd it names', () => {
    const shape = claimPacketShape(base64.encode(fullPacket()))
    expect(shape.kind).toBe('packet')
    if (shape.kind !== 'packet') return
    expect(shape.covclaimdPubkey).toEqual(PUBKEY)
  })

  it('never produces a packet as short as the ciphertext it wraps', () => {
    expect(fullPacket().length).toBeGreaterThan(93)
  })

  it('keeps a two-TLV shape with no pubkey on the legacy reveal path', () => {
    const twoTlv = concat(tlv(0x01, sealedCiphertext()), tlv(0x02, ARKADE_SCRIPT))
    expect(claimPacketShape(base64.encode(twoTlv))).toEqual({ kind: 'ciphertext' })
  })

  it('reads a ciphertext-and-pubkey body as a packet the solver must complete', () => {
    const shape = claimPacketShape(base64.encode(concat(tlv(0x01, sealedCiphertext()), tlv(0x03, PUBKEY))))
    expect(shape.kind).toBe('packet')
    if (shape.kind !== 'packet') return
    expect(shape.needsArkadeScript).toBe(true)
    expect(shape.covclaimdPubkey).toEqual(PUBKEY)
  })

  it('marks a body that already carries 0x02 as needing nothing', () => {
    const shape = claimPacketShape(base64.encode(fullPacket()))
    expect(shape.kind).toBe('packet')
    if (shape.kind !== 'packet') return
    expect(shape.needsArkadeScript).toBe(false)
  })

  it.each([
    ['a TLV body missing the ciphertext', base64.encode(tlv(0x02, ARKADE_SCRIPT))],
    [
      'a ciphertext that is not the sealed 93 bytes, even beside a valid pubkey',
      base64.encode(concat(tlv(0x01, ARKADE_SCRIPT), tlv(0x03, PUBKEY))),
    ],
    ['a truncated TLV header', base64.encode(Uint8Array.from([0x01, 0x00]))],
    ['a TLV length that overruns', base64.encode(Uint8Array.from([0x01, 0x00, 0x05, 0xaa]))],
    [
      'a 0x03 that is not 33 bytes',
      base64.encode(concat(tlv(0x01, sealedCiphertext()), tlv(0x02, ARKADE_SCRIPT), tlv(0x03, ARKADE_SCRIPT))),
    ],
    ['a value that is not base64 at all', 'not base64 !!'],
  ])('falls back to the ciphertext path for %s', (_name, input) => {
    expect(claimPacketShape(input)).toEqual({ kind: 'ciphertext' })
  })
})

describe('extended sealed-terms claim packets', () => {
  const body = base64.decode(vector.packet)
  const ciphertext = body.subarray(3, 3 + ((body[1]! << 8) | body[2]!))
  const key = body.subarray(body.length - 33)
  const tree = Uint8Array.of(1, 2, 3)
  const script = { nonInteractiveClaimArkadeScript: ARKADE_SCRIPT, encode: () => tree } as CovenantSwapScript

  it('stamps the SDK binary terms vector without changing the opaque body', () => {
    expect(solverClaimPacketShape(vector.packet)).toEqual({
      kind: 'packet',
      body,
      covclaimdPubKey: key,
      needsArkadeScript: true,
    })
    expect(claimPacketStamp(vector.packet, script)).toEqual({
      packet: appendArkadeScript(body, ARKADE_SCRIPT),
      tapTree: tree,
    })
    expect(claimPacketStamp(base64.encode(appendArkadeScript(body, ARKADE_SCRIPT)), script)).toEqual({
      packet: appendArkadeScript(body, ARKADE_SCRIPT),
      tapTree: tree,
    })
    expect(solverClaimPacketShape(base64.encode(ciphertext))).toEqual({ kind: 'ciphertext' })
  })

  it.each([94, 256, 65535])('accepts a complete %i-byte ciphertext TLV', (length) => {
    const packet = concat(tlv(1, new Uint8Array(length)), tlv(3, PUBKEY))
    expect(solverClaimPacketShape(base64.encode(packet))).toMatchObject({ kind: 'packet', needsArkadeScript: true })
  })

  it.each([
    ['short ciphertext', concat(tlv(1, new Uint8Array(92)), tlv(3, PUBKEY))],
    ['missing key', tlv(1, ciphertext)],
    ['short key', concat(tlv(1, ciphertext), tlv(3, PUBKEY.subarray(1)))],
    ['bad duplicate key followed by valid key', concat(tlv(1, ciphertext), tlv(3, Uint8Array.of(2)), tlv(3, PUBKEY))],
    ['truncated header', concat(body, Uint8Array.of(2, 0))],
    ['truncated value', concat(body, Uint8Array.of(2, 0, 2, 0))],
    ['last ciphertext is short', concat(body, tlv(1, Uint8Array.of(1)))],
  ])('preserves ciphertext fallback for %s', (_name, packet) => {
    expect(solverClaimPacketShape(base64.encode(packet))).toEqual({ kind: 'ciphertext' })
    expect(claimPacketStamp(base64.encode(packet), script)).toBeUndefined()
  })

  it('keeps the final ciphertext/key and existing script semantics', () => {
    const packet = concat(tlv(1, Uint8Array.of(1)), body, tlv(3, PUBKEY), tlv(2, new Uint8Array()))
    expect(solverClaimPacketShape(base64.encode(packet))).toEqual({
      kind: 'packet',
      body: packet,
      covclaimdPubKey: PUBKEY,
      needsArkadeScript: false,
    })
    const legacyLast = concat(body, tlv(1, sealedCiphertext()))
    expect(solverClaimPacketShape(base64.encode(legacyLast))).toEqual({
      kind: 'packet',
      body: legacyLast,
      covclaimdPubKey: key,
      needsArkadeScript: true,
    })
  })
})
