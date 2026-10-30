/**
 * Where the solver's configuration comes from: one JSON document, named by
 * `SOLVER_CONFIG` (a file) or carried whole by `SOLVER_CONFIG_JSON`.
 */
import { readFileSync } from 'node:fs'
import { log, messageOf } from '@arkade-os/solver-core/util/poll.js'
import { configFromKnobs, sentryOptionsFromKnobs, type Config, type Knobs } from '../config.js'
import { lightningRailFor, lightningRailNames } from '../ops/rails.js'
import type { SentryOptions } from '../ops/sentry.js'
import { parseDocument, type SolverDocument } from './document.js'
import { documentToKnobs, PATHS, renameKnobs } from './knobs.js'

export interface LoadOptions {
  env?: NodeJS.ProcessEnv
  /** Applied to the parsed document before anything reads it: a deployment's own defaults and refusals. */
  profile?: (doc: SolverDocument) => SolverDocument
}

let registeredProfile: LoadOptions['profile']

/**
 * The profile every `loadConfig` that passes none applies: the shipped CLI loads its own config, so a
 * consumer running it registers here, at import time above the entrypoint, as it does a rail.
 */
export const registerConfigProfile = (profile: NonNullable<LoadOptions['profile']>): void => {
  if (registeredProfile) throw new Error('a config profile is already registered')
  registeredProfile = profile
}

const positionOf = (error: unknown, text: string): string => {
  const message = messageOf(error)
  const at = /position (\d+)/.exec(message)?.[1] ?? (/end of JSON/.test(message) ? String(text.length) : undefined)
  return at === undefined ? '' : ` at position ${at}`
}

/** Neither source set: the CLI follows it with the document any old variables describe. */
export class NoConfigDocument extends Error {}

export const readDocument = (env: NodeJS.ProcessEnv): unknown => {
  const path = env.SOLVER_CONFIG?.trim()
  const inline = env.SOLVER_CONFIG_JSON?.trim()
  if (path && inline) throw new Error('set only one of SOLVER_CONFIG or SOLVER_CONFIG_JSON')
  if (!path && !inline) {
    throw new NoConfigDocument(
      'set SOLVER_CONFIG to a JSON file path, or SOLVER_CONFIG_JSON to the document ' +
        '(cli config-from-env prints one from the current environment)',
    )
  }
  const source = path ? `SOLVER_CONFIG ${path}` : 'SOLVER_CONFIG_JSON'
  let text = inline ?? ''
  if (path) {
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      throw new Error(`${source}: cannot be read (${(error as NodeJS.ErrnoException).code ?? messageOf(error)})`)
    }
  }
  text = text.replace(/^﻿/, '')
  try {
    return JSON.parse(text)
  } catch (error) {
    // Position only: V8's message can quote the text it failed on, and the text holds the mnemonic.
    throw new Error(`${source}: invalid JSON${positionOf(error, text)}`)
  }
}

/** Set by platforms rather than operators, so refusing them would refuse a deployment for its host. */
export const LEGACY_IGNORED = ['HOST', 'PORT'] as const

const LEGACY = new Set(
  PATHS.map(([, knob]) => knob).filter((knob) => !(LEGACY_IGNORED as readonly string[]).includes(knob)),
)
// No LND_ family: its settings are all exact ids above, and Kubernetes derives LND_PORT & co from a service named lnd.
const LEGACY_FAMILY = /^(LN_SEND|LN_RECEIVE|ONCHAIN_SEND|EVM|ASSET|OFFER)_/
// What Kubernetes derives from any Service's name (`evm-rpc` → EVM_RPC_SERVICE_HOST); no setting ends this way.
const SERVICE_LINK = /_(SERVICE_HOST|SERVICE_PORT(_\w+)?|PORT(_\d+_(TCP|UDP|SCTP)(_(PROTO|PORT|ADDR))?)?)$/

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => Boolean(env[name]?.trim())

export const legacyEnvNames = (env: NodeJS.ProcessEnv): string[] => {
  const railLegacy = new Set(lightningRailNames().flatMap((rail) => lightningRailFor(rail)?.legacyEnv?.names ?? []))
  return Object.keys(env)
    .filter(
      (name) =>
        isSet(env, name) &&
        (LEGACY.has(name) || railLegacy.has(name) || (LEGACY_FAMILY.test(name) && !SERVICE_LINK.test(name))),
    )
    .sort()
}

/** Refused rather than ignored: a host half-migrated would otherwise run on settings it believes it changed. */
export const assertNoLegacyEnv = (env: NodeJS.ProcessEnv): void => {
  const legacy = legacyEnvNames(env)
  if (legacy.length > 0) {
    throw new Error(
      `legacy environment variables are set and would be ignored: ${legacy.join(', ')}. ` +
        'Move them into the config document (cli config-from-env prints one).',
    )
  }
  const ignored = LEGACY_IGNORED.filter((name) => isSet(env, name))
  if (ignored.length > 0) log(`ignoring legacy ${ignored.join('/')}; set http.host/http.port in the config`)
}

export const loadConfig = (opts: LoadOptions = {}): Config => {
  const env = opts.env ?? process.env
  const raw = readDocument(env)
  assertNoLegacyEnv(env)
  const left = new Set([...JSON.stringify(raw).matchAll(/"(<[A-Za-z_][A-Za-z0-9_]*>)"/g)].map(([, held]) => held))
  if (left.size > 0) {
    throw new Error(`the config document still holds ${[...left].join(', ')}: put each variable's value in its place`)
  }
  const parsed = parseDocument(raw, lightningRailNames())
  const profile = opts.profile ?? registeredProfile
  const doc = profile ? parseDocument(profile(parsed), lightningRailNames()) : parsed
  const { knobs, pathOf, railBlock } = documentToKnobs(doc)
  try {
    return { ...configFromKnobs(knobs), configPaths: pathOf, lightningRailBlock: railBlock }
  } catch (error) {
    throw new Error(renameKnobs(messageOf(error), pathOf, knobs))
  }
}

/** Enough to find the databases: no requirement checked, and an unmigrated environment tolerated. */
export const loadKnobsForInspection = (env: NodeJS.ProcessEnv = process.env): Knobs =>
  documentToKnobs(parseDocument(readDocument(env), lightningRailNames())).knobs

const PATH_OF: ReadonlyMap<string, string> = new Map(PATHS.map(([path, knob]) => [knob, path]))

/**
 * Crash reporting, read before a command loads its config and from the `sentry`
 * block alone: a mistake elsewhere in the document is the crash worth reporting.
 * No readable document means no reporter rather than no command, because
 * `config-from-env` runs before any document exists.
 */
export const loadSentryOptions = (env: NodeJS.ProcessEnv = process.env): SentryOptions | null => {
  let raw: unknown
  try {
    raw = readDocument(env)
  } catch {
    return null
  }
  const doc = (raw !== null && typeof raw === 'object' ? raw : {}) as {
    network?: unknown
    sentry?: Record<string, unknown>
  }
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
  const knobs = {
    SWAP_NETWORK: text(doc.network),
    SENTRY_DSN: text(doc.sentry?.dsn),
    SENTRY_ENVIRONMENT: text(doc.sentry?.environment),
    SENTRY_RELEASE: text(doc.sentry?.release),
  }
  try {
    return sentryOptionsFromKnobs(knobs)
  } catch (error) {
    throw new Error(renameKnobs(messageOf(error), PATH_OF, knobs))
  }
}
