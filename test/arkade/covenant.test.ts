import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { ArkAddress, arkade, VHTLC, VHTLCV2ContractHandler } from '@arkade-os/sdk'
import { CovenantSwapScript, enforcePayTo, preimageCondition } from '@arkade-os/solver-arkade/arkade/covenant.js'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const RECEIVER = key(1)
const SERVER = key(3)
const EMULATOR = key(9)
const DEST = p2tr(key(5))
const PREIMAGE_HASH = ripemd160(sha256(new Uint8Array(32).fill(7)))
const REFUND_LOCKTIME = 1_800_000_000
const CLAIM_DELAY = 4096

const CLIENT = key(11)
const CLIENT_REFUND_DELAY = 6144
const REFUND_WITHOUT_SERVER_DELAY = 5120
const RECEIVER_PAYOUT = p2tr(key(13))

/**
 * The only shape there is.
 *
 * There used to be two: without a client key this built a base three-leaf
 * script from a local artifact, which no handler could re-derive. That shape is
 * gone and so are the tests that compared the two.
 */
const params = () => ({
  receiver: RECEIVER,
  server: SERVER,
  preimageHash: PREIMAGE_HASH,
  refundLocktime: REFUND_LOCKTIME,
  claimDelay: CLAIM_DELAY,
  client: CLIENT,
  clientRefundDelay: CLIENT_REFUND_DELAY,
  refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
  // Every test in this file predates the suite shape becoming a parameter and
  // was written when the timelocked refund leaf was unconditionally on; kept
  // on here (no legacy selector) so none of them change meaning. Tests that
  // care about the shape itself override it.
  nonInteractiveParameters: {
    emulatorPubkey: EMULATOR,
    receiverPkScript: RECEIVER_PAYOUT,
    senderPkScript: DEST,
  },
})

const paramsV2 = params

describe('preimageCondition', () => {
  it('encodes HASH160 <hash> EQUAL and nothing else', () => {
    expect(hex.encode(preimageCondition(PREIMAGE_HASH))).toBe(`a914${hex.encode(PREIMAGE_HASH)}87`)
  })

  it('rejects a hash that is not HASH160-sized', () => {
    expect(() => preimageCondition(new Uint8Array(32))).toThrow(/20 bytes/)
  })
})

describe('enforcePayTo', () => {
  it('emits the covenant byte-for-byte with the destination program pinned', () => {
    // PUSHCURRENTINPUTINDEX DUP INSPECTOUTPUTSCRIPTPUBKEY 1 EQUALVERIFY
    // <program> EQUALVERIFY INSPECTOUTPUTVALUE PUSHCURRENTINPUTINDEX
    // INSPECTINPUTVALUE GREATERTHANOREQUAL
    expect(hex.encode(enforcePayTo(DEST))).toBe(`cd76d1518820${hex.encode(DEST.subarray(2))}88cfcdc9a2`)
  })

  it('rejects anything that is not a P2TR pkScript', () => {
    expect(() => enforcePayTo(DEST.subarray(2))).toThrow(/P2TR/)
    expect(() => enforcePayTo(Uint8Array.from([0x00, 0x20, ...key(5)]))).toThrow(/P2TR/)
  })
})

describe('CovenantSwapScript', () => {
  it('builds the claim leaf as preimage + receiver + server', () => {
    const script = new CovenantSwapScript(params())
    // `82012088` is OP_SIZE <32> OP_EQUALVERIFY — the preimage-length check.
    // The retired three-leaf artifact omitted it; `VHTLC.ScriptV2` does not.
    expect(script.claimScript).toBe(
      `82012088a914${hex.encode(PREIMAGE_HASH)}876920${hex.encode(RECEIVER)}ad20${hex.encode(SERVER)}ac`,
    )
  })

  it('builds the non-interactive refund leaf as server + receiver + covenant-tweaked emulator key', () => {
    const script = new CovenantSwapScript(params())
    const tweaked = arkade.computeArkadeScriptPublicKey(EMULATOR, enforcePayTo(DEST))
    // `<server> CHECKSIGVERIFY <receiver> CHECKSIGVERIFY <tweaked> CHECKSIG`.
    //
    // This asserted the RETIRED artifact's shape until the base script was
    // removed — `<locktime> CLTV DROP <server> CHECKSIGVERIFY <tweaked>
    // CHECKSIG` — which no live corridor has used for months. Two real
    // differences, now pinned against what actually ships:
    //
    //  - No CLTV. This tier is gated by the covenant, not by a timelock; the
    //    deadline lives on the leaves that need one.
    //  - The RECEIVER signs too. This is the provider's own non-interactive
    //    unwind, so the provider is a required signer rather than a bystander.
    //
    // The tweaked key is what binds the leaf to "pays the client, value >=
    // input": the emulator only signs for it after verifying that covenant.
    expect(script.refundScript).toBe(`20${hex.encode(SERVER)}ad20${hex.encode(RECEIVER)}ad20${hex.encode(tweaked)}ac`)
    // and no key of the client's appears in this leaf
    expect(script.refundScript.includes(hex.encode(key(5)))).toBe(false)
  })

  it('commits the refund destination into the covenant, so a different destination changes the script', () => {
    const a = new CovenantSwapScript(params())
    const b = new CovenantSwapScript({
      ...params(),
      nonInteractiveParameters: { ...params().nonInteractiveParameters, senderPkScript: p2tr(key(6)) },
    })
    expect(hex.encode(a.pkScript)).not.toBe(hex.encode(b.pkScript))
  })

  it('gives the provider a server-independent claim behind a CSV delay', () => {
    const script = new CovenantSwapScript(params())
    // condition + CSV(claimDelay) + receiver only
    // Same preimage-length check as the claim leaf above.
    expect(script.unilateralClaimScript.startsWith(`82012088a914${hex.encode(PREIMAGE_HASH)}8769`)).toBe(true)
    expect(script.unilateralClaimScript.includes('b275')).toBe(true)
    expect(script.unilateralClaimScript.endsWith(`20${hex.encode(RECEIVER)}ac`)).toBe(true)
  })

  it('derives an address whose pkScript round-trips', () => {
    const script = new CovenantSwapScript(params())
    const address = script.address('ark', SERVER).encode()
    expect(address.startsWith('ark1')).toBe(true)
    expect(hex.encode(ArkAddress.decode(address).pkScript)).toBe(hex.encode(script.pkScript))
  })

  it('exposes each leaf for spending', () => {
    const script = new CovenantSwapScript(params())
    expect(script.claim()).toBeDefined()
    expect(script.refund()).toBeDefined()
    expect(script.unilateralClaim()).toBeDefined()
  })

  // A height is no longer a mistake here: a block-typed deployment builds one
  // deliberately, and the covenant reads the unit off the value rather than
  // dictating it. What the constructor still refuses is a ladder whose rungs
  // count DIFFERENT clocks — see `test/core/blockTimelocks.test.ts` for the rule.
  it('accepts a block-height locktime alongside a block-typed ladder', () => {
    const script = new CovenantSwapScript({
      ...params(),
      refundLocktime: 812,
      claimDelay: 20,
      refundWithoutServerDelay: 20,
      clientRefundDelay: 28,
    })
    expect(script.pkScript).toBeDefined()
  })

  it('rejects a ladder that mixes blocks and seconds', () => {
    // Compiles and funds; it just inverts which recourse opens first, and the
    // solo refund opening before the claim is the ordering that lets a funder
    // take money from a claimant holding the preimage.
    expect(
      () =>
        new CovenantSwapScript({
          ...params(),
          refundLocktime: 812,
          claimDelay: 20,
          refundWithoutServerDelay: 20,
          clientRefundDelay: CLIENT_REFUND_DELAY,
        }),
    ).toThrow(/mixes units/)
  })

  it('rejects a non-positive locktime in either unit', () => {
    expect(() => new CovenantSwapScript({ ...params(), refundLocktime: 0 })).toThrow(/positive/)
  })

  it('rejects a claim delay BIP68 cannot encode', () => {
    expect(() => new CovenantSwapScript({ ...params(), claimDelay: 1000 })).toThrow(/512/)
  })

  it('rejects an emulator key of the wrong length', () => {
    expect(
      () =>
        new CovenantSwapScript({
          ...params(),
          nonInteractiveParameters: { ...params().nonInteractiveParameters, emulatorPubkey: EMULATOR.subarray(4) },
        }),
    ).toThrow(/32 or 33/)
  })
})

describe('CovenantSwapScript — client-unilateral refund leaf', () => {
  it('builds the refundUnilateral leaf as CSV(delay) + client alone', () => {
    const script = new CovenantSwapScript(paramsV2())
    // CSV(delay) DROP <client> CHECKSIG — same CSV+DROP shape the
    // unilateralClaim leaf already proves (`b275`), tail keyed to CLIENT alone.
    expect(script.refundUnilateralScript).toBeDefined()
    expect(script.refundUnilateralScript!.includes('b275')).toBe(true)
    expect(script.refundUnilateralScript!.endsWith(`20${hex.encode(CLIENT)}ac`)).toBe(true)
  })

  it('needs nobody else: no server or emulator key appears in the leaf', () => {
    const script = new CovenantSwapScript(paramsV2())
    expect(script.refundUnilateralScript!.includes(hex.encode(SERVER))).toBe(false)
    expect(script.refundUnilateralScript!.includes(hex.encode(EMULATOR))).toBe(false)
  })

  it('rejects a clientRefundDelay BIP68 cannot encode', () => {
    expect(() => new CovenantSwapScript({ ...paramsV2(), clientRefundDelay: 1000 })).toThrow(/512/)
  })
})

describe('CovenantSwapScript — refundCollaborative leaf', () => {
  it('builds the leaf as a plain 3-of-3: client + receiver + server, no timelock', () => {
    const script = new CovenantSwapScript(paramsV2())
    // <client> CHECKSIGVERIFY <receiver> CHECKSIGVERIFY <server> CHECKSIG —
    // no condition, no CSV/CLTV: nothing precedes the signer chain and
    // nothing follows it.
    expect(script.refundCollaborativeScript).toBe(
      `20${hex.encode(CLIENT)}ad20${hex.encode(RECEIVER)}ad20${hex.encode(SERVER)}ac`,
    )
  })
})

describe('CovenantSwapScript — refundWithoutServer leaf', () => {
  it('builds the leaf as CSV(delay) + client + receiver, no server key', () => {
    const script = new CovenantSwapScript(paramsV2())
    // CSV(delay) DROP <client> CHECKSIGVERIFY <receiver> CHECKSIG — same
    // CSV+DROP shape unilateralClaim/refundUnilateral already prove (`b275`),
    // tail keyed to client+receiver together.
    expect(script.refundWithoutServerScript).toBeDefined()
    expect(script.refundWithoutServerScript!.includes('b275')).toBe(true)
    expect(script.refundWithoutServerScript!.endsWith(`20${hex.encode(CLIENT)}ad20${hex.encode(RECEIVER)}ac`)).toBe(
      true,
    )
  })

  it('needs no server key: absent from the leaf entirely', () => {
    const script = new CovenantSwapScript(paramsV2())
    expect(script.refundWithoutServerScript!.includes(hex.encode(SERVER))).toBe(false)
    expect(script.refundWithoutServerScript!.includes(hex.encode(EMULATOR))).toBe(false)
  })

  it('rejects a refundWithoutServerDelay BIP68 cannot encode', () => {
    expect(() => new CovenantSwapScript({ ...paramsV2(), refundWithoutServerDelay: 1000 })).toThrow(/512/)
  })
})

describe('CovenantSwapScript — refundWithoutReceiver leaf', () => {
  it('builds the leaf as CLTV(refundLocktime) + client + server, no receiver key', () => {
    const script = new CovenantSwapScript(paramsV2())
    // CLTV(refundLocktime) DROP <client> CHECKSIGVERIFY <server> CHECKSIG.
    // `b175` is CHECKLOCKTIMEVERIFY+DROP — the ABSOLUTE-timelock counterpart
    // of the `b275` CSV+DROP shape the unilateral leaves use.
    expect(script.refundWithoutReceiverScript).toBeDefined()
    expect(script.refundWithoutReceiverScript!.includes('b175')).toBe(true)
    expect(script.refundWithoutReceiverScript!.endsWith(`20${hex.encode(CLIENT)}ad20${hex.encode(SERVER)}ac`)).toBe(
      true,
    )
  })

  it('needs no receiver and no emulator: neither key appears in the leaf', () => {
    // This is the whole point of the leaf on the RECEIVE legs: there the
    // receiver is the CLIENT-USER, whose cooperation a solver-initiated
    // refund cannot assume. See src/receive/arkadeOps.ts's role note.
    const script = new CovenantSwapScript(paramsV2())
    expect(script.refundWithoutReceiverScript!.includes(hex.encode(RECEIVER))).toBe(false)
    expect(script.refundWithoutReceiverScript!.includes(hex.encode(EMULATOR))).toBe(false)
  })
})

describe('CovenantSwapScript — nonInteractiveClaim leaf', () => {
  it('builds the leaf as preimage + server + covenant-tweaked emulator key, pinned to the receiver payout', () => {
    const script = new CovenantSwapScript(paramsV2())
    const tweaked = arkade.computeArkadeScriptPublicKey(EMULATOR, enforcePayTo(RECEIVER_PAYOUT))
    // Same shape as `refund`'s covenant test: preimage condition + VERIFY,
    // then <server> CHECKSIGVERIFY <tweaked> CHECKSIG. The tweaked key binds
    // this leaf to "pays the receiver, value >= input" instead of the
    // client's refund destination.
    expect(script.nonInteractiveClaimScript).toBe(
      `82012088a914${hex.encode(PREIMAGE_HASH)}876920${hex.encode(SERVER)}ad20${hex.encode(tweaked)}ac`,
    )
    // and no key of the receiver's own claim identity appears in the tree —
    // only the covenant-tweaked key, same non-leakage property `refund` has.
    expect(script.nonInteractiveClaimScript!.includes(hex.encode(RECEIVER))).toBe(false)
  })

  it('commits the receiver payout into the covenant, so a different payout changes the script', () => {
    const a = new CovenantSwapScript(paramsV2())
    const b = new CovenantSwapScript({
      ...paramsV2(),
      nonInteractiveParameters: { ...paramsV2().nonInteractiveParameters, receiverPkScript: p2tr(key(14)) },
    })
    expect(hex.encode(a.pkScript)).not.toBe(hex.encode(b.pkScript))
  })

  it('rejects a receiverPkScript that is not P2TR', () => {
    expect(
      () =>
        new CovenantSwapScript({
          ...paramsV2(),
          nonInteractiveParameters: {
            ...paramsV2().nonInteractiveParameters,
            receiverPkScript: RECEIVER_PAYOUT.subarray(2),
          },
        }),
    ).toThrow(/P2TR/)
  })
})

describe('CovenantSwapScript — timelocked non-interactive refund leaf', () => {
  it('carries the timelocked non-interactive refund leaf', () => {
    const script = new CovenantSwapScript(paramsV2())
    // ts-sdk#818 inverted the spelling: absent `legacy` IS the nine-leaf suite.
    // Asserted present first, or a dropped suite would satisfy the second line.
    expect(script.vhtlcOptions?.nonInteractiveParameters).toBeDefined()
    expect(script.vhtlcOptions?.nonInteractiveParameters?.legacy).toBeUndefined()
  })

  it('registers the flag, so the derived script matches the row', () => {
    // This is exactly `upsertContractRow`'s own re-derivation check, run
    // locally, and it becomes genuinely protective the moment ts-sdk#812
    // publishes: a flag dropped anywhere in the round trip would then
    // re-derive the eight-leaf script instead of the nine-leaf one — a
    // different pkScript — and registration would die on it in production as
    // an opaque `Script mismatch` instead of failing here, by name.
    //
    // Until ts-sdk#812 publishes, though, this test cannot tell a working
    // implementation from a no-op: against the currently-published SDK,
    // `withoutReceiver` is silently accepted and ignored on BOTH sides of the
    // round trip, so both still derive the same eight-leaf script and this
    // passes regardless. The next test is the one that currently discriminates.
    const script = new CovenantSwapScript(paramsV2())
    const params = VHTLCV2ContractHandler.serializeParams(script.vhtlcOptions!)
    expect(hex.encode(VHTLCV2ContractHandler.createScript(params).pkScript)).toBe(hex.encode(script.pkScript))
  })

  it('actually moves the address: the flag changes the pkScript relative to it being unset', () => {
    // Proves the leaf reaches the derived taproot output rather than being a
    // passthrough on an options object nothing reads.
    const withFlag = new CovenantSwapScript(paramsV2())
    const withoutFlag = new VHTLC.ScriptV2({
      ...withFlag.vhtlcOptions,
      nonInteractiveParameters: { ...withFlag.vhtlcOptions.nonInteractiveParameters!, legacy: 'preTimelockedRefund' },
    })
    expect(hex.encode(withFlag.pkScript)).not.toBe(hex.encode(withoutFlag.pkScript))
  })
})

/**
 * The leaf COUNT, pinned.
 *
 * Not a behavioural property — nothing branches on it — but four comments had
 * drifted to "seven-leaf" while `docs/rfq-protocol.md` § 7.1.1.1 and three
 * other files said eight. The count is load-bearing for exactly one audience:
 * someone reconstructing the taptree from the wire fields to check their own
 * `lockup_address` derivation. This makes the number fail a test rather than
 * mislead them.
 */
describe('CovenantSwapScript leaf count', () => {
  /**
   * Every leaf this class exposes a NAMED ACCESSOR for.
   *
   * NOT a count of the real taptree — see `leafCount` below for that, and
   * read it before trusting this one for anything. This list stayed at 8 the
   * entire time `nonInteractiveRefundWithoutReceiver` was hardcoded to `true`
   * and the real tree had already grown to 9: the flag has no accessor here
   * by design (see the leaf-mapping table in covenant.ts's header), so a
   * count built from named accessors is structurally blind to it. That is
   * the bug a cross-repo review caught — this test's own hardcoded list is
   * what let it through. Kept anyway because "eight named accessors, pairwise
   * distinct" is still a true and useful claim; `leafCount` below is what
   * carries the count that can actually fail.
   */
  const leavesOf = (script: CovenantSwapScript): string[] =>
    [
      script.claimScript,
      script.refundScript,
      script.refundWithoutReceiverScript,
      script.refundCollaborativeScript,
      script.refundWithoutServerScript,
      script.refundUnilateralScript,
      script.nonInteractiveClaimScript,
      script.unilateralClaimScript,
    ].filter((leaf): leaf is string => leaf !== undefined)

  it('exposes eight distinct NAMED leaf accessors', () => {
    const leaves = leavesOf(new CovenantSwapScript(paramsV2()))
    expect(leaves).toHaveLength(8)
    expect(new Set(leaves).size).toBe(8)
  })

  /**
   * The REAL taproot leaf count, read from the compiled script itself
   * (`VHTLC.ScriptV2`'s own `leaves` array) rather than from this class's
   * accessors — the fix for the gap `leavesOf` above cannot close.
   */
  it('the real taproot leaf count is eight in the pre-timelocked-refund shape', () => {
    const script = new CovenantSwapScript({
      ...paramsV2(),
      nonInteractiveParameters: { ...paramsV2().nonInteractiveParameters, legacy: 'preTimelockedRefund' },
    })
    expect(script.leafCount).toBe(8)
  })

  it('the real taproot leaf count is nine in the current shape — exactly the leaf leavesOf cannot see', () => {
    const script = new CovenantSwapScript(paramsV2())
    expect(script.leafCount).toBe(9)
  })
})

/**
 * A covenant denominated in an asset. This used to be a tripwire that refused,
 * because `VHTLC.Options` carried no `asset`; SDK 0.4.67 ships one (ts-sdk#763).
 */
describe('CovenantSwapScript — denominated in an asset', () => {
  const ASSET_ID = { txid: new Uint8Array(32).fill(0).map((_unused, i) => i + 1), groupIndex: 2 }
  const sats = () => new CovenantSwapScript(paramsV2())
  const asset = () => new CovenantSwapScript({ ...paramsV2(), asset: ASSET_ID })

  it('builds, rather than refusing', () => {
    expect(() => asset()).not.toThrow()
  })

  it('binds the asset into both covenant leaves this class exposes', () => {
    expect(hex.encode(asset().refundArkadeScript)).not.toBe(hex.encode(sats().refundArkadeScript))
    expect(hex.encode(asset().nonInteractiveClaimArkadeScript!)).not.toBe(
      hex.encode(sats().nonInteractiveClaimArkadeScript!),
    )
  })

  it('binds the asset on EVERY emulator-enforced leaf, including the one with no accessor', () => {
    // THE WHOLE SAFETY ARGUMENT, and why the old refusal could go: an asset
    // "spent away through the non-interactive leaves" is answered only if EVERY
    // leaf the emulator co-signs binds it, and
    // `nonInteractiveRefundWithoutReceiver` has no accessor a named check sees.
    const enforced = (script: CovenantSwapScript): string[] =>
      Object.keys(new VHTLC.ScriptV2(script.vhtlcOptions)).filter((leaf) => leaf.endsWith('ArkadeScript'))
    // SDK-internal property names, and this assertion is what keeps a rename
    // loud: the loop below only ever visits what `enforced` discovered.
    expect(enforced(asset())).toEqual([
      'nonInteractiveClaimArkadeScript',
      'nonInteractiveRefundArkadeScript',
      'nonInteractiveRefundWithoutReceiverArkadeScript',
    ])
    const reversed = hex.encode(Uint8Array.from(ASSET_ID.txid).reverse())
    const built = new VHTLC.ScriptV2(asset().vhtlcOptions) as unknown as Record<string, Uint8Array>
    for (const leaf of enforced(asset())) expect(hex.encode(built[leaf]!)).toContain(reversed)
  })

  it('leaves every signature leaf byte-identical', () => {
    expect(asset().claimScript).toBe(sats().claimScript)
    expect(asset().refundWithoutReceiverScript).toBe(sats().refundWithoutReceiverScript)
    expect(asset().refundCollaborativeScript).toBe(sats().refundCollaborativeScript)
    expect(asset().refundWithoutServerScript).toBe(sats().refundWithoutServerScript)
    expect(asset().unilateralClaimScript).toBe(sats().unilateralClaimScript)
    expect(asset().refundUnilateralScript).toBe(sats().refundUnilateralScript)
  })

  it('keeps the leaf count, so an asset adds no path', () => {
    expect(asset().leafCount).toBe(sats().leafCount)
  })

  it('moves the address, so an asset lockup is never funded at the sats one', () => {
    expect(hex.encode(asset().pkScript)).not.toBe(hex.encode(sats().pkScript))
  })

  it('pushes the txid REVERSED, from a caller-supplied canonical order', () => {
    // The SDK does the flip, so a pre-reversing caller gets an unspendable lockup.
    const encoded = hex.encode(asset().refundArkadeScript)
    expect(encoded).toContain(hex.encode(Uint8Array.from(ASSET_ID.txid).reverse()))
    expect(encoded).not.toContain(hex.encode(ASSET_ID.txid))
  })

  it('does not mutate the caller’s asset id', () => {
    const mine = { txid: Uint8Array.from(ASSET_ID.txid), groupIndex: 2 }
    const before = hex.encode(mine.txid)
    new CovenantSwapScript({ ...paramsV2(), asset: mine })
    expect(hex.encode(mine.txid)).toBe(before)
  })

  it('binds the group index, so two groups of one genesis are different lockups', () => {
    const other = new CovenantSwapScript({ ...paramsV2(), asset: { ...ASSET_ID, groupIndex: 3 } })
    expect(hex.encode(other.pkScript)).not.toBe(hex.encode(asset().pkScript))
  })

  it('survives the contract-registration round trip', () => {
    const script = asset()
    const stored = VHTLCV2ContractHandler.serializeParams(script.vhtlcOptions)
    expect(hex.encode(VHTLCV2ContractHandler.createScript(stored).pkScript)).toBe(hex.encode(script.pkScript))
  })

  it('refuses a malformed asset id rather than deriving an address from one', () => {
    expect(() => new CovenantSwapScript({ ...paramsV2(), asset: { txid: new Uint8Array(31), groupIndex: 0 } })).toThrow(
      /32 bytes/,
    )
    expect(() => new CovenantSwapScript({ ...paramsV2(), asset: { ...ASSET_ID, groupIndex: 0x10000 } })).toThrow(
      /\[0, 65535\]/,
    )
  })

  it('still builds when no asset is named', () => {
    expect(() => new CovenantSwapScript(params())).not.toThrow()
  })
})

/**
 * NO DATABASE MIGRATION: both encodings are self-describing, so the two shapes
 * coexist in one database and a row written before block mode must rebuild
 * BYTE-IDENTICALLY.
 *
 * The claim is asserted against the SDK's own encoder rather than against a
 * literal captured from this tree, because that is what the claim is about:
 * a seconds row must still reach `VHTLC.ScriptV2` as `{ type: 'seconds' }`,
 * exactly as it did when the unit was hardcoded one line above the call.
 */
describe('CovenantSwapScript — a stored row rebuilds in the unit it was written in', () => {
  const reference = (
    unit: 'seconds' | 'blocks',
    over: { refundLocktime: number; claimDelay: number; refundWithoutServerDelay: number; clientRefundDelay: number },
  ): string => {
    const delay = (value: number) => ({ type: unit, value: BigInt(value) }) as const
    return hex.encode(
      new VHTLC.ScriptV2({
        sender: CLIENT,
        receiver: RECEIVER,
        server: SERVER,
        preimageHash: PREIMAGE_HASH,
        refundLocktime: BigInt(over.refundLocktime),
        unilateralClaimDelay: delay(over.claimDelay),
        unilateralRefundDelay: delay(over.refundWithoutServerDelay),
        unilateralRefundWithoutReceiverDelay: delay(over.clientRefundDelay),
        nonInteractiveParameters: { receiverPkScript: RECEIVER_PAYOUT, senderPkScript: DEST, emulatorPubkey: EMULATOR },
      }).pkScript,
    )
  }

  const SECONDS_ROW = {
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: CLAIM_DELAY,
    refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
    clientRefundDelay: CLIENT_REFUND_DELAY,
  }
  const BLOCK_ROW = { refundLocktime: 812, claimDelay: 20, refundWithoutServerDelay: 20, clientRefundDelay: 28 }

  it('hands the SDK seconds for a pre-existing row, exactly as the hardcoded unit did', () => {
    const script = new CovenantSwapScript({ ...params(), ...SECONDS_ROW })
    expect(hex.encode(script.pkScript)).toBe(reference('seconds', SECONDS_ROW))
  })

  it('hands the SDK blocks for a block-typed row', () => {
    const script = new CovenantSwapScript({ ...params(), ...BLOCK_ROW })
    expect(hex.encode(script.pkScript)).toBe(reference('blocks', BLOCK_ROW))
  })

  it('derives a DIFFERENT script from the same numbers in the other unit', () => {
    // Without this the two assertions above could both pass on an encoder that
    // ignored the unit, and "byte-identical" would be proving nothing.
    //
    // Ladder values valid in BOTH units, which is what makes the comparison
    // possible at all: the SDK refuses a seconds delay off the 512 grid, so the
    // block row above cannot be re-encoded as seconds to compare against.
    const AMBIGUOUS = {
      refundLocktime: REFUND_LOCKTIME,
      claimDelay: 1024,
      refundWithoutServerDelay: 1024,
      clientRefundDelay: 1536,
    }
    expect(reference('blocks', AMBIGUOUS)).not.toBe(reference('seconds', AMBIGUOUS))
  })
})
