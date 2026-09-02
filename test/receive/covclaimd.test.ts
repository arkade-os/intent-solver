import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCovclaimdClient, CovclaimdError } from '@arkade-os/solver-corridors/receive/covclaimd.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('createCovclaimdClient', () => {
  it('getPubKeys() GETs /v1/preimage/covclaimd-pubkey and maps snake_case to camelCase', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://covclaimd.example/v1/preimage/covclaimd-pubkey')
      return new Response(JSON.stringify({ covclaimd_pub_key: 'aa'.repeat(33), emulator_pub_key: 'bb'.repeat(33) }), {
        status: 200,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCovclaimdClient('http://covclaimd.example')
    await expect(client.getPubKeys()).resolves.toEqual({
      covclaimdPubKey: 'aa'.repeat(33),
      emulatorPubKey: 'bb'.repeat(33),
    })
  })

  it('getPubKeys() throws CovclaimdError on a non-2xx status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    const client = createCovclaimdClient('http://covclaimd.example')
    await expect(client.getPubKeys()).rejects.toThrow(CovclaimdError)
    await expect(client.getPubKeys()).rejects.toThrow(/503/)
  })

  it('reveal() POSTs the documented wire shape — swap_address, packet.{ciphertext,arkade_script}, taptree', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://covclaimd.example/v1/reveal')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init!.body as string)).toEqual({
        swap_address: 'tark1example',
        packet: { ciphertext: 'ciphertext-b64', arkade_script: 'script-b64' },
        taptree: 'deadbeef',
      })
      return new Response('', { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCovclaimdClient('http://covclaimd.example')
    await client.reveal({
      swapAddress: 'tark1example',
      ciphertext: 'ciphertext-b64',
      arkadeScript: 'script-b64',
      taptree: 'deadbeef',
    })
  })

  it('reveal() throws CovclaimdError with the response body on a non-2xx status', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('taptree does not hash to swap_address', { status: 400 }),
    ) as unknown as typeof fetch
    const client = createCovclaimdClient('http://covclaimd.example')
    await expect(
      client.reveal({ swapAddress: 'tark1example', ciphertext: 'c', arkadeScript: 's', taptree: 'd' }),
    ).rejects.toThrow(/taptree does not hash to swap_address/)
  })

  it('strips a trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://covclaimd.example/v1/preimage/covclaimd-pubkey')
      return new Response(JSON.stringify({ covclaimd_pub_key: 'aa', emulator_pub_key: 'bb' }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createCovclaimdClient('http://covclaimd.example/')
    await client.getPubKeys()
  })
})
