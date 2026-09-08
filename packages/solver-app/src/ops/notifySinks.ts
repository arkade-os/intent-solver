/**
 * BOTH CREDENTIALS ARE URLS: Telegram embeds the bot token in its path and a
 * Slack webhook URL is itself the secret. So no URL, token or upstream error
 * object reaches the error thrown here — only a status and a sink name.
 */

import type { NotifySink } from './notify.js'

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

// Node's `fetch` has NO default timeout. Without this a hung request never
// settles: the drain stops and every later message is dropped for a queue that
// never empties — neither the bounded queue nor the bounded retries are reached.
export const REQUEST_TIMEOUT_MS = 10_000

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
})

// The upstream cause is DROPPED, not chained: a transport error routinely
// quotes the URL it was dialling, which here is the secret.
const opaqueFailure = (sink: string, detail: string): Error =>
  new Error(`${sink} notification failed (${detail}); the endpoint and token are withheld from this message`)

const send = async (sink: string, fetchImpl: FetchLike, url: string, body: unknown): Promise<void> => {
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(url, jsonPost(body))
  } catch {
    throw opaqueFailure(sink, 'the request could not be sent')
  }
  if (!response.ok) throw opaqueFailure(sink, `HTTP ${response.status}`)
}

export const telegramSink = (botToken: string, chatId: string, fetchImpl: FetchLike): NotifySink => ({
  name: 'telegram',
  send: (text) =>
    send('telegram', fetchImpl, `https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
})

export const slackSink = (webhookUrl: string, fetchImpl: FetchLike): NotifySink => ({
  name: 'slack',
  send: (text) => send('slack', fetchImpl, webhookUrl, { text }),
})

export interface NotifyCredentials {
  telegramBotToken: string | null
  telegramChatId: string | null
  slackWebhookUrl: string | null
}

/**
 * Empty when nothing is configured. Telegram needs BOTH halves — a token that
 * cannot address a message reads as a delivery failure, not a misconfig.
 */
export const sinksFrom = (credentials: NotifyCredentials, fetchImpl: FetchLike): NotifySink[] => {
  const sinks: NotifySink[] = []
  const { telegramBotToken, telegramChatId, slackWebhookUrl } = credentials
  if (telegramBotToken !== null && telegramChatId !== null) {
    sinks.push(telegramSink(telegramBotToken, telegramChatId, fetchImpl))
  }
  if (slackWebhookUrl !== null) sinks.push(slackSink(slackWebhookUrl, fetchImpl))
  return sinks
}
