import { describe, it, expect } from 'vitest'
import { adoptFunding, providerKeyCurrent, uncollected } from '@arkade-os/solver-corridors/legs/arkadeLockup.js'

const out = (txid: string, value: number, spent = false) => ({ txid, vout: 0, value, spent })

describe('adoptFunding', () => {
  it('adopts a spent funding, so a claim the client already made cannot hide it', () => {
    expect(adoptFunding([out('a', 1_000, true)], 1_000)?.txid).toBe('a')
  })

  it('prefers the unspent match and ignores other amounts', () => {
    expect(adoptFunding([out('dust', 330), out('a', 1_000, true), out('b', 1_000)], 1_000)?.txid).toBe('b')
    expect(adoptFunding([out('dust', 330)], 1_000)).toBeNull()
  })
})

describe('providerKeyCurrent', () => {
  it('holds only for the key the covenant was built with', () => {
    expect([providerKeyCurrent('aa', 'aa'), providerKeyCurrent('aa', 'bb')]).toEqual([true, false])
  })
})

describe('uncollected', () => {
  const adopted = [
    { txid: 'a', vout: 0, value: 1 },
    { txid: 'u', vout: 0, value: 1 },
  ]
  const none = new Set<string>()

  it('counts an output the read does not show as uncollected', () => {
    const left = uncollected(adopted, { outpoints: [], claimedOffchain: none, claimedOnL1: none })
    expect(left.map((o) => o.txid)).toEqual(['a', 'u'])
  })

  it('needs a spend offchain and a confirmed claim on L1', () => {
    const outpoints = [
      { txid: 'a', vout: 0, spent: true, unrolled: false },
      { txid: 'u', vout: 0, spent: true, unrolled: true },
    ]
    expect(uncollected(adopted, { outpoints, claimedOffchain: none, claimedOnL1: none }).map((o) => o.txid)).toEqual([
      'u',
    ])
    expect(uncollected(adopted, { outpoints, claimedOffchain: none, claimedOnL1: new Set(['u:0']) })).toEqual([])
  })

  it('trusts this tick’s accepted claim over a read that has not caught up', () => {
    const outpoints = [{ txid: 'a', vout: 0, spent: false, unrolled: false }]
    const left = uncollected(adopted, { outpoints, claimedOffchain: new Set(['a:0']), claimedOnL1: new Set(['u:0']) })
    expect(left).toEqual([{ txid: 'u', vout: 0, value: 1 }])
  })
})
