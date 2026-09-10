// `admin/settings.ts` exposes an explicit ALLOW-LIST, which is what stops a new
// Config field leaking by default. Pinned because the failure is silent.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sinksFrom } from '@arkade-os/solver-app/ops/notifySinks.js'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const settingsSource = read('../../packages/solver-app/src/admin/settings.ts')
const statusSource = read('../../packages/solver-app/src/admin/routes/status.ts')

const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'SLACK_WEBHOOK_URL']
const SECRET_FIELDS = ['telegramBotToken', 'slackWebhookUrl', 'telegramChatId']

describe('notification secrets never reach the admin API', () => {
  it('names none of the credential env vars in the settings allow-list', () => {
    for (const key of SECRET_KEYS) expect(settingsSource, key).not.toContain(key)
  })

  it('reads none of the credential fields in the settings projection', () => {
    for (const field of SECRET_FIELDS) expect(settingsSource, field).not.toContain(field)
  })

  it('does not surface them on the overview either', () => {
    for (const field of SECRET_FIELDS) expect(statusSource, field).not.toContain(field)
  })
})

describe('sinksFrom', () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' })

  it('builds NOTHING when nothing is configured — off by default', () => {
    expect(sinksFrom({ telegramBotToken: null, telegramChatId: null, slackWebhookUrl: null }, fetchImpl)).toEqual([])
  })

  it('needs BOTH halves of the Telegram pair, since one alone cannot send', () => {
    expect(sinksFrom({ telegramBotToken: 'tok', telegramChatId: null, slackWebhookUrl: null }, fetchImpl)).toEqual([])
    expect(sinksFrom({ telegramBotToken: null, telegramChatId: '-1', slackWebhookUrl: null }, fetchImpl)).toEqual([])
  })

  it('builds telegram when the pair is complete', () => {
    const sinks = sinksFrom({ telegramBotToken: 'tok', telegramChatId: '-1', slackWebhookUrl: null }, fetchImpl)
    expect(sinks.map((s) => s.name)).toEqual(['telegram'])
  })

  it('builds slack from the webhook alone', () => {
    const sinks = sinksFrom({ telegramBotToken: null, telegramChatId: null, slackWebhookUrl: 'https://h' }, fetchImpl)
    expect(sinks.map((s) => s.name)).toEqual(['slack'])
  })

  it('supports both at once — the requirement was both, not either', () => {
    const sinks = sinksFrom({ telegramBotToken: 'tok', telegramChatId: '-1', slackWebhookUrl: 'https://h' }, fetchImpl)
    expect(sinks.map((s) => s.name)).toEqual(['telegram', 'slack'])
  })

  it('exposes no credential on the sink objects it returns', () => {
    const sinks = sinksFrom(
      { telegramBotToken: 'SECRET_TOKEN', telegramChatId: '-1', slackWebhookUrl: 'https://SECRET_HOOK' },
      fetchImpl,
    )
    const serialised = JSON.stringify(sinks.map((s) => ({ ...s })))
    expect(serialised).not.toContain('SECRET_TOKEN')
    expect(serialised).not.toContain('SECRET_HOOK')
  })
})
