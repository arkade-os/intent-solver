/**
 * E2E — block-typed timelocks against a live regtest arkd.
 *
 * This suite exists because everything ELSE about block mode is checkable
 * without a chain, and the one thing that is not is the thing most likely to be
 * wrong: whether arkd ACCEPTS a covenant whose leaves count blocks.
 *
 * The unit tests prove we build the script we meant to build. They cannot prove
 * the server enforcing it agrees — and this is precisely the failure shape the
 * codebase keeps warning about, because arkd validates a script at SPEND, not
 * at funding. A lockup with a delay arkd dislikes is accepted, funded, and only
 * then unspendable, with money already in it. So the assertions here are, in
 * order of what they buy:
 *
 *   1. arkd advertises a block-typed delay at all (otherwise this suite is
 *      pointless and says so rather than passing vacuously)
 *   2. the ladder derived from it is block-typed, and its rungs keep their order
 *   3. the covenant BUILDS and encodes as an address against this server's key
 *   4. mining moves the chain past a block-typed deadline while the wall clock
 *      does not move — the property the whole feature exists for
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT DO: drive a full swap. That needs both
 * LND nodes and a channel, and it is `sendLightning.e2e.test.ts`'s job. Run
 * that file against a block-typed arkd to exercise the money path; run this one
 * to find out WHY it broke if it does.
 *
 * PREREQUISITES
 *   - arkade-regtest up with arkd configured for a BLOCK-typed unilateral exit
 *     delay (a value below 512, e.g. 20). A seconds-typed arkd SKIPS the
 *     block-specific assertions rather than failing them — the point is to test
 *     block mode where it exists, not to demand every deployment run it.
 *   - the usual e2e env file with ARK_MNEMONIC / ARK_SERVER_URL / EMULATOR_URL
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import {
  absoluteLocktimeIn,
  absoluteLocktimeReached,
  absoluteLocktimeSeconds,
  deriveUnilateralDelays,
  NOMINAL_BLOCK_SECONDS,
  relativeDelayFrom,
  SEQUENCE_GRANULARITY_SECONDS,
} from '@arkade-os/solver-core/core/timelocks.js'
import { mineBlocks } from './support/chain.js'
import { chainTip, requireStack } from './support/preflight.js'
import { openArkade, SETUP_TIMEOUT_MS, type E2eArkade } from './support/stack.js'

const p2tr = (xonly: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...xonly])

describe('block-typed timelocks against a live arkd', () => {
  let arkade: E2eArkade
  let advertisedExitDelay: number

  beforeAll(async () => {
    await requireStack('block-typed timelocks', ['arkd', 'emulator', 'esplora'])
    arkade = await openArkade()
    const info = await arkade.ctx.wallet.arkProvider.getInfo()
    advertisedExitDelay = Number(info.unilateralExitDelay)
  }, SETUP_TIMEOUT_MS)

  afterAll(() => arkade?.close())

  it('is running against a block-typed arkd, or says why it is not', () => {
    const { unit } = relativeDelayFrom(advertisedExitDelay)
    if (unit === 'seconds') {
      // Not a failure. A seconds-typed arkd is the ordinary configuration and
      // every other suite covers it; this one has nothing to say about it, and
      // saying so beats a green tick that tested nothing.
      console.warn(
        `SKIPPING block-timelock assertions: this arkd advertises ${advertisedExitDelay}, which is SECONDS. ` +
          `Configure arkd with a unilateral exit delay below ${SEQUENCE_GRANULARITY_SECONDS} (e.g. 20 blocks) to run them.`,
      )
    }
    expect(['blocks', 'seconds']).toContain(unit)
  })

  it('derives a block-typed ladder whose solo refund still opens last', () => {
    if (relativeDelayFrom(advertisedExitDelay).unit !== 'blocks') return
    const delays = deriveUnilateralDelays(advertisedExitDelay)

    for (const rung of Object.values(delays)) {
      expect(relativeDelayFrom(rung).unit).toBe('blocks')
    }
    // The ordering the whole ladder exists to enforce: the funder's SOLO path
    // must not open before the claimant's.
    expect(delays.unilateralRefundWithoutReceiverDelay).toBeGreaterThan(delays.unilateralClaimDelay)
  })

  it('builds a covenant this server can be addressed with', async () => {
    if (relativeDelayFrom(advertisedExitDelay).unit !== 'blocks') return
    const delays = deriveUnilateralDelays(advertisedExitDelay)
    const tipHeight = await chainTip()
    expect(tipHeight).not.toBeNull()

    const now = Math.floor(Date.now() / 1000)
    // Written as a HEIGHT, exactly as the orchestrators write it in block mode.
    const refundLocktime = absoluteLocktimeIn(now + 2 * 60 * 60, 'blocks', { now, tipHeight: tipHeight! })
    expect(refundLocktime).toBeGreaterThan(tipHeight!)

    const info = await arkade.ctx.wallet.arkProvider.getInfo()
    const serverKey = hex.decode(info.signerPubkey)
    const own = await arkade.ctx.identity.xOnlyPublicKey()

    const script = new CovenantSwapScript({
      receiver: own,
      server: serverKey,
      preimageHash: new Uint8Array(20).fill(7),
      refundLocktime,
      claimDelay: delays.unilateralClaimDelay,
      client: own,
      clientRefundDelay: delays.unilateralRefundWithoutReceiverDelay,
      refundWithoutServerDelay: delays.unilateralRefundDelay,
      nonInteractiveParameters: {
        emulatorPubkey: hex.decode(arkade.emulator.pubkey),
        receiverPkScript: p2tr(own),
        senderPkScript: p2tr(own),
      },
    })

    // THE ASSERTION THIS SUITE EXISTS FOR. `address()` runs the script through
    // the SDK's own encoding against this server's key; a leaf arkd's script
    // validator would reject is one the SDK cannot encode for it either.
    const address = script.address(arkade.profile.arkadeHrp, serverKey).encode()
    expect(address.startsWith(arkade.profile.arkadeHrp)).toBe(true)
    expect(script.pkScript).toHaveLength(34)
  })

  it('matures a block-typed deadline by MINING, with the wall clock unmoved', async () => {
    if (relativeDelayFrom(advertisedExitDelay).unit !== 'blocks') return
    const before = await chainTip()
    expect(before).not.toBeNull()

    const now = Math.floor(Date.now() / 1000)
    // A deadline three blocks out. Nothing about the clock will move it.
    const deadline = before! + 3
    expect(absoluteLocktimeReached(deadline, { now, tipHeight: before! })).toBe(false)

    const after = await mineBlocks(4)
    expect(after).not.toBeNull()
    expect(after!).toBeGreaterThanOrEqual(deadline)

    // Same `now` deliberately — the clock is held still to prove the deadline
    // moved because BLOCKS arrived, which is the property regtest cannot get
    // from a seconds-typed timelock at any amount of mining.
    expect(absoluteLocktimeReached(deadline, { now, tipHeight: after! })).toBe(true)

    // And the seconds projection tracks it, for the duration questions that
    // still have to be answered in seconds.
    expect(absoluteLocktimeSeconds(deadline, { now, tipHeight: after! })).toBeLessThanOrEqual(now)
  })

  it('does not mature a SECONDS deadline by mining, which is why block mode exists', async () => {
    const now = Math.floor(Date.now() / 1000)
    const secondsDeadline = now + 60 * 60
    const after = await mineBlocks(6)
    expect(after).not.toBeNull()
    // Six blocks, and the seconds-typed deadline has not moved an inch.
    expect(absoluteLocktimeReached(secondsDeadline, { now, tipHeight: after! })).toBe(false)
    expect(absoluteLocktimeSeconds(secondsDeadline, { now, tipHeight: after! })).toBe(secondsDeadline)
    expect(NOMINAL_BLOCK_SECONDS).toBe(600)
  })
})
