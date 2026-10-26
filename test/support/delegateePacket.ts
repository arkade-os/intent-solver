import { Buffer } from 'node:buffer'

export const delegateePacket = (): Uint8Array => {
  const tlv = (tag: number, value: number[]) => [tag, value.length >> 8, value.length & 0xff, ...value]
  return Uint8Array.from([
    ...tlv(127, [...Buffer.from('delegatee-secrets/v1')]),
    ...tlv(
      1,
      Array.from({ length: 300 }, (_, i) => i & 0xff),
    ),
    ...tlv(3, [2, ...Array<number>(32).fill(17)]),
  ])
}
