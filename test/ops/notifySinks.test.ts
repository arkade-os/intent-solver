// Telegram's endpoint embeds the bot token IN THE URL, so any error quoting the
// request URL leaks a credential into the operator's logs.
import { describe, it, expect, vi } from 'vitest'
import { telegramSink, slackSink } from '@arkade-os/solver-app/ops/notifySinks.js'

const TOKEN = '123456:AAHsuperSecretBotTokenValue'
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xoxbSuperSecretPath'

const okFetch = () => vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
const badFetch = (status = 401, body = 'Unauthorized') =>
  vi.fn().mockResolvedValue({ ok: false, status, text: async () => body })

describe('telegramSink', () => {
  it('posts the message to the chat', async () => {
    const fetchImpl = okFetch()
    await telegramSink(TOKEN, '-100999', fetchImpl).send('a swap was fulfilled')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('api.telegram.org')
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      chat_id: '-100999',
      text: 'a swap was fulfilled',
    })
  })

  it('throws on a non-2xx so the notifier retries', async () => {
    await expect(telegramSink(TOKEN, '-1', badFetch()).send('x')).rejects.toThrow()
  })

  it('NEVER puts the bot token in the error it throws', async () => {
    await expect(telegramSink(TOKEN, '-1', badFetch()).send('x')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }) as Error,
    )
  })

  it('does not leak the token when the transport itself fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED for bot${TOKEN}`))
    const error = (await telegramSink(TOKEN, '-1', fetchImpl)
      .send('x')
      .catch((e: unknown) => e as Error)) as unknown as Error
    expect(error.message).not.toContain(TOKEN)
  })

  it('still names the status, so a 401 is diagnosable without the secret', async () => {
    await expect(telegramSink(TOKEN, '-1', badFetch(401)).send('x')).rejects.toThrow(/401/)
  })

  it('is identified by name only', () => {
    expect(telegramSink(TOKEN, '-1', okFetch()).name).toBe('telegram')
  })
})

describe('slackSink', () => {
  it('posts the message to the webhook', async () => {
    const fetchImpl = okFetch()
    await slackSink(WEBHOOK, fetchImpl).send('a swap failed')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe(WEBHOOK)
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ text: 'a swap failed' })
  })

  it('throws on a non-2xx so the notifier retries', async () => {
    await expect(slackSink(WEBHOOK, badFetch(500, 'no_service')).send('x')).rejects.toThrow()
  })

  it('NEVER puts the webhook URL in the error it throws', async () => {
    const error = (await slackSink(WEBHOOK, badFetch())
      .send('x')
      .catch((e: unknown) => e as Error)) as unknown as Error
    expect(error.message).not.toContain(WEBHOOK)
    expect(error.message).not.toContain('xoxbSuperSecretPath')
  })

  it('does not leak the webhook when the transport itself fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`getaddrinfo failed ${WEBHOOK}`))
    const error = (await slackSink(WEBHOOK, fetchImpl)
      .send('x')
      .catch((e: unknown) => e as Error)) as unknown as Error
    expect(error.message).not.toContain('xoxbSuperSecretPath')
  })

  it('is identified by name only', () => {
    expect(slackSink(WEBHOOK, okFetch()).name).toBe('slack')
  })
})

// A hung request would wedge the drain and drop every later message.
describe('request deadline', () => {
  it('bounds every request with an abort signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    await telegramSink(TOKEN, '-1', fetchImpl).send('x')
    await slackSink(WEBHOOK, fetchImpl).send('x')
    for (const [, init] of fetchImpl.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('reports an aborted request without leaking the endpoint', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`TimeoutError dialling ${WEBHOOK}`))
    const error = (await slackSink(WEBHOOK, fetchImpl)
      .send('x')
      .catch((e: unknown) => e)) as Error
    expect(error.message).not.toContain('xoxbSuperSecretPath')
  })
})
