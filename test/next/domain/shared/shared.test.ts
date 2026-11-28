import { describe, expect, it } from 'vitest'
import { Amount } from '@arkade-os/solver-next/domain/shared/amount.js'
import { Asset } from '@arkade-os/solver-next/domain/shared/asset.js'
import { checkBps } from '@arkade-os/solver-next/domain/shared/bps.js'
import { Endpoint, Rail } from '@arkade-os/solver-next/domain/shared/endpoint.js'
import { DomainError, ErrorCode, InvalidValue } from '@arkade-os/solver-next/domain/shared/error.js'
import { RfqId, RouteId, SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'

const BTC = Asset.of('BTC')
const USDT = Asset.of('usdt')
const sats = (units: bigint) => Amount.of(BTC, units)

describe('Amount', () => {
  it('adds, subtracts and compares within one asset', () => {
    expect(sats(5n).plus(sats(7n)).units).toBe(12n)
    expect(sats(7n).minus(sats(5n)).units).toBe(2n)
    expect(sats(7n).minus(sats(7n)).isZero).toBe(true)
    expect([sats(7n).gt(sats(7n)), sats(7n).gte(sats(7n)), sats(8n).gt(sats(7n))]).toEqual([false, true, true])
    expect(sats(7n).equals(sats(7n))).toBe(true)
    expect(Amount.zero(BTC).equals(sats(0n))).toBe(true)
  })

  it('is never negative, by construction or by subtraction', () => {
    expect(() => sats(-1n)).toThrow(InvalidValue)
    expect(() => sats(5n).minus(sats(6n))).toThrow(InvalidValue)
  })

  it('refuses to combine two assets, and does not call them equal', () => {
    const other = Amount.of(USDT, 5n)
    for (const combine of [() => sats(5n).plus(other), () => sats(5n).minus(other), () => sats(5n).gte(other)]) {
      expect(combine).toThrow('cannot combine BTC with usdt')
    }
    expect(sats(5n).equals(other)).toBe(false)
  })

  it('holds amounts a number would round', () => {
    const big = 123456789012345678901234567890n
    expect(Amount.of(USDT, big).plus(Amount.of(USDT, 1n)).units).toBe(big + 1n)
  })
})

describe('Asset and ids', () => {
  it('refuse an empty string and keep the spelling they were given', () => {
    for (const make of [Asset.of, SwapId.of, RfqId.of, RouteId.of]) expect(() => make('')).toThrow(InvalidValue)
    expect(Asset.of('BTC')).not.toBe(Asset.of('btc'))
  })
})

describe('Endpoint', () => {
  it('is one asset on one rail, named rail:asset', () => {
    const arkade = Endpoint.of(Rail.Arkade, BTC)
    expect(arkade.key).toBe('arkade:BTC')
    expect(arkade.equals(Endpoint.of(Rail.Arkade, BTC))).toBe(true)
    expect(arkade.equals(Endpoint.of(Rail.Lightning, BTC))).toBe(false)
    expect(arkade.equals(Endpoint.of(Rail.Arkade, USDT))).toBe(false)
  })
})

describe('checkBps', () => {
  it('takes whole basis points from 0 to 9999, never the whole amount', () => {
    expect([checkBps('fee', 0), checkBps('fee', 9_999)]).toEqual([0, 9_999])
    for (const bad of [-1, 1.5, 10_000, Number.NaN])
      expect(() => checkBps('fee', bad)).toThrow('fee must be 0..9999 bps')
  })
})

describe('UnixSeconds', () => {
  it('is a whole, non-negative, safe number of seconds', () => {
    expect(UnixSeconds.of(1_800_000_000)).toBe(1_800_000_000)
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => UnixSeconds.of(bad)).toThrow(InvalidValue)
    }
  })
})

describe('DomainError', () => {
  it('is caught by class and carries a code and its own name', () => {
    const error = (() => {
      try {
        sats(-1n)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: ErrorCode.Invalid, name: 'InvalidValue' })
  })
})
