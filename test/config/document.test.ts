import { describe, it, expect } from 'vitest'
import { parseDocument } from '@arkade-os/solver-app/config/document.js'
import { FULL_DOCUMENT } from '../support/configDocuments.js'

const errorOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return String(error)
  }
  throw new Error('expected a throw')
}

describe('parseDocument', () => {
  it('accepts a document with every key the schema knows', () => {
    expect(parseDocument(FULL_DOCUMENT, [])).toEqual(FULL_DOCUMENT)
  })

  it('accepts an empty document: every key is optional at this layer', () => {
    expect(parseDocument({}, [])).toEqual({})
  })

  it('refuses an unknown key and names its path', () => {
    expect(() => parseDocument({ network: 'regtest', limits: { maxSwapSat: 1 } }, [])).toThrow(
      'limits.maxSwapSat: unknown key',
    )
  })

  it('refuses an unknown top-level key', () => {
    expect(() => parseDocument({ netwrok: 'regtest' }, [])).toThrow('netwrok: unknown key')
  })

  it('refuses a bigint field given as a number', () => {
    expect(() => parseDocument({ corridors: { 'arkade:BTC->USDC@arb': { maxUnits: 1e21 } } }, [])).toThrow(
      /corridors\["arkade:BTC->USDC@arb"\]\.maxUnits: must be a decimal string/,
    )
  })

  it('refuses a bigint string that is not plain decimal', () => {
    expect(() => parseDocument({ offers: { minFillAmount: '0x10' } }, [])).toThrow(
      'offers.minFillAmount: must be a decimal string',
    )
  })

  it('accepts only the offer covenant versions the runtime knows', () => {
    expect(() => parseDocument({ offers: { covenantVersions: ['offer-v1', 'offer-v2'] } }, [])).not.toThrow()
    expect(() => parseDocument({ offers: { covenantVersions: ['offer-v1', 'offer-v3'] } }, [])).toThrow(
      'offers.covenantVersions[1]: must be one of offer-v1, offer-v2',
    )
  })

  it('accepts RFQ covenant names or content hashes', () => {
    expect(() =>
      parseDocument({ rfq: { covenantVersions: ['asset-swap-v2', 'sha256:' + 'ab'.repeat(32)] } }, []),
    ).not.toThrow()
    expect(() => parseDocument({ rfq: { covenantVersions: ['bad version'] } }, [])).toThrow(
      'rfq.covenantVersions[0]: must be a version name or content hash',
    )
  })

  it('refuses a wrong type and says which', () => {
    expect(() => parseDocument({ limits: { maxSwapSats: '5000' } }, [])).toThrow('limits.maxSwapSats: must be a number')
  })

  it('accepts $schema', () => {
    expect(() => parseDocument({ $schema: './x.json', network: 'regtest' }, [])).not.toThrow()
  })

  it('accepts a registered rail block, refuses an unregistered one', () => {
    expect(() => parseDocument({ rails: { lightning: { custom: { mnemonic: 'm' } } } }, ['custom'])).not.toThrow()
    expect(() => parseDocument({ rails: { lightning: { custom: {} } } }, [])).toThrow(
      'rails.lightning.custom: unknown key',
    )
  })

  it('refuses a second evm chain', () => {
    expect(() => parseDocument({ rails: { evm: { a: {}, b: {} } } }, [])).toThrow(
      'rails.evm: at most one chain is supported for now',
    )
  })

  it('refuses an asset of unknown kind', () => {
    expect(() => parseDocument({ assets: { X: { kind: 'bep20' } } }, [])).toThrow(
      'assets.X.kind: must be one of erc20, arkade',
    )
  })

  it('reports every problem, one per line', () => {
    const message = errorOf(() => parseDocument({ limits: { maxSwapSat: 1 }, http: { port: 'x' } }, []))
    expect(message).toContain('limits.maxSwapSat: unknown key')
    expect(message).toContain('http.port: must be a number')
  })

  it('never echoes a received value', () => {
    expect(errorOf(() => parseDocument({ rails: { arkade: { mnemonic: 4242 } } }, []))).not.toContain('4242')
    expect(errorOf(() => parseDocument({ offers: { minFillAmount: 'seed words' } }, []))).not.toContain('seed words')
  })

  it('refuses a document that is not an object', () => {
    expect(() => parseDocument([], [])).toThrow('document: must be an object')
  })
})
