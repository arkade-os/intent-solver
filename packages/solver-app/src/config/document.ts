/**
 * The shape of the solver's JSON config document.
 *
 * Shape only: every key is optional here, and what a value MEANS is checked
 * once the document is flattened, by the same readers the environment used.
 */
import { z } from 'zod'

const UNKNOWN_KEY = 'unknown key'

// One message for a number and for a hex string alike: either way the value is not what was meant.
const decimal = z.custom<string>(
  (value) => typeof value === 'string' && /^\d+$/.test(value),
  'must be a decimal string',
)
const str = z.string()
const num = z.number()
const bool = z.boolean()
const strings = z.array(z.string())

const section = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().strict()

const lightningKnown = {
  backend: str,
  lnd: section({ socket: str, cert: str, certPath: str, macaroon: str, macaroonPath: str }),
  fake: section({ statePath: str }),
  lockupTimeoutSeconds: num,
  sweepConcurrency: num,
  sendHintScidDenylist: strings,
  receiveAcceptUnilateralGap: bool,
}

const lightning = (railNames: readonly string[]) =>
  z
    .object(lightningKnown)
    .partial()
    .catchall(z.unknown())
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (!(key in lightningKnown) && !railNames.includes(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: UNKNOWN_KEY })
        }
      }
    })

const evmChain = section({
  chainId: num,
  rpcUrl: str,
  htlcAddress: str,
  privateKey: str,
  minConfirmations: num,
  minAgeSeconds: num,
  fastestSecondsPerBlock: num,
  slowestSecondsPerBlock: num,
  timelockFastestSecondsPerBlock: num,
  timelockSlowestSecondsPerBlock: num,
  gasLimit: decimal,
  maxFeePerGasCeiling: decimal,
  feeHeadroomSeconds: num,
  orderMarginSeconds: num,
  quoteValiditySeconds: num,
  logScanRange: num,
  directClaimsOnly: bool,
})

const asset = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('erc20'),
      chain: str,
      address: str,
      decimals: num,
      priceFeed: str.optional(),
      pricePath: str.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('arkade'), assetId: str, approvalThreshold: decimal.optional() }).strict(),
])

const corridorTerms = section({
  enabled: bool,
  minSats: num,
  maxSats: num,
  feeBps: num,
  feeFlatSats: num,
  feeCapSats: num,
  feeMinSats: num,
  maxBandSats: num,
  bandBelowShare: num,
  minUnits: decimal,
  maxUnits: decimal,
})

const buildSchema = (railNames: readonly string[]) =>
  section({
    $schema: str,
    network: str,
    name: str,
    rails: section({
      arkade: section({
        mnemonic: str,
        serverUrl: str,
        emulatorUrl: str,
        esploraUrl: str,
        unilateralExitDelay: num,
        covclaimdUrl: str,
        poolAutoMint: bool,
        contractRetentionDays: num,
      }),
      lightning: lightning(railNames),
      onchain: section({ esploraUrl: str, chainTipEsploraUrl: str, feeRateRefreshMs: num, feeRateStaleMs: num }),
      evm: z.record(str, evmChain).refine((chains) => Object.keys(chains).length <= 1, {
        message: 'exactly one chain is supported for now',
      }),
    }),
    assets: z.record(str, asset),
    limits: section({ maxSwapSats: num, maxExposedSats: num, approvalThresholdSats: num }),
    corridors: z.record(str, corridorTerms),
    offers: section({
      markets: strings,
      minFillAmount: decimal,
      maxFillAmount: decimal,
      chargeCarrier: bool,
      carrierPricing: bool,
      quoteValiditySeconds: num,
    }),
    relay: section({
      url: str,
      protocol: str,
      healthPath: str,
      openRfqMaxBidsPerMinute: num,
      adPublish: str,
      cardRelays: strings,
    }),
    storage: section({ dir: str, swapDb: str, arkDb: str }),
    http: section({ host: str, port: num }),
    admin: section({ host: str, port: num.nullable(), restartEnabled: bool }),
    sentry: section({ dsn: str, environment: str, release: str }),
    notify: section({
      telegramBotToken: str,
      telegramChatId: str,
      slackWebhookUrl: str,
      balanceReportIntervalMinutes: num,
    }),
    diagnostics: section({ latency: bool }),
  })

export type SolverDocument = z.infer<ReturnType<typeof buildSchema>>

export const documentSchema = (railNames: readonly string[]): z.ZodType<SolverDocument> => buildSchema(railNames)

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** `corridors["arkade:BTC->lightning:BTC"].feeBps`, the form an operator can search the file for. */
export const jsonPath = (path: readonly (string | number)[]): string =>
  path
    .map((segment, index) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : IDENTIFIER.test(segment)
          ? `${index === 0 ? '' : '.'}${segment}`
          : `[${JSON.stringify(segment)}]`,
    )
    .join('') || 'document'

const ARTICLE: Record<string, string> = { object: 'an object', array: 'an array' }

const lines = (issue: z.ZodIssue): string[] => {
  switch (issue.code) {
    case z.ZodIssueCode.unrecognized_keys:
      return issue.keys.map((key) => `${jsonPath([...issue.path, key])}: ${UNKNOWN_KEY}`)
    // Built from the expected TYPE only: zod's own message would carry what was received.
    case z.ZodIssueCode.invalid_type:
      return [
        issue.received === 'undefined'
          ? `${jsonPath(issue.path)}: is required`
          : `${jsonPath(issue.path)}: must be ${ARTICLE[issue.expected] ?? `a ${issue.expected}`}`,
      ]
    case z.ZodIssueCode.invalid_union_discriminator:
      return [`${jsonPath(issue.path)}: must be one of ${issue.options.join(', ')}`]
    default:
      return [`${jsonPath(issue.path)}: ${issue.message}`]
  }
}

export const parseDocument = (raw: unknown, railNames: readonly string[]): SolverDocument => {
  const parsed = documentSchema(railNames).safeParse(raw)
  if (parsed.success) return parsed.data
  throw new Error(parsed.error.issues.flatMap(lines).join('\n'))
}
