import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { ArkAddress, arkade, VHTLC, VHTLCV2ContractHandler } from '@arkade-os/sdk'
import {
  CovenantSwapScript,
  enforcePayTo,
  enforcePayToAsset,
  parseAssetId,
  preimageCondition,
  serializeAssetId,
} from '@arkade-os/solver-arkade/arkade/covenant.js'

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
    expect(script.vhtlcOptions?.nonInteractiveRefund?.withoutReceiver).toBe(true)
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
    // Confirmed, not hypothesized: against the currently-published SDK the
    // two tests above both still pass, because it silently accepts and
    // ignores the flag on both sides of the round trip. This is the one that
    // proves the flag has a real effect on the derived taproot output rather
    // than being a passthrough on an options object nothing reads — and it is
    // the one that currently FAILS against the published SDK, which is the
    // honest signal that this file depends on unmerged ts-sdk#812.
    const withFlag = new CovenantSwapScript(paramsV2())
    const withoutFlag = new VHTLC.ScriptV2({
      ...withFlag.vhtlcOptions,
      nonInteractiveRefund: { ...withFlag.vhtlcOptions.nonInteractiveRefund!, withoutReceiver: false },
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
 * The asset covenant, and specifically the two things that make it safe rather
 * than merely present.
 *
 * These assert the ENCODING and its structure. They do not prove the emulator
 * accepts a spend — that needs a funded asset lockup and a real co-signature,
 * which is the gate on wiring this into a corridor, not on landing the script.
 * What they do prove is that the fragment says what it is supposed to say, and
 * that the BTC path is untouched.
 */
describe('enforcePayToAsset', () => {
  const ASSET = { txid: new Uint8Array(32).fill(0xab), groupIndex: 2 }

  it('contains the BTC covenant verbatim as its tail, so an asset lockup never enforces less', () => {
    // The compatibility property, asserted structurally rather than hoped for:
    // whatever the BTC covenant demands, the asset one demands too.
    const btc = enforcePayTo(DEST)
    const asset = enforcePayToAsset(DEST, ASSET)
    expect(hex.encode(asset).endsWith(hex.encode(btc))).toBe(true)
    expect(asset.length).toBeGreaterThan(btc.length)
  })

  // NOTE: "the BTC covenant is byte-identical" is not re-asserted here — the
  // `enforcePayTo` suite above already pins it to a literal hex string, which
  // is the stronger assertion. Every lockup already funded derives from that
  // script, so a one-byte change makes those underivable and unrefundable;
  // that test is the regression, and the tail-sharing above is what keeps this
  // one honest.

  it('VERIFYs the lookup success flag on BOTH sides', () => {
    // The load-bearing detail. INSPECTOUTASSETLOOKUP pushes `amount 1`, or
    // `0 0` when the asset is absent — so without the VERIFY that pops the
    // flag, an output carrying NONE of the asset reports amount 0, and 0 >= 0
    // passes. The asset-stripping spend this covenant exists to stop would
    // succeed. One VERIFY per lookup, output side and input side.
    const words = (arkade.ArkadeScript.decode(enforcePayToAsset(DEST, ASSET)) as unknown as unknown[]).map(String)
    for (const lookup of ['INSPECTOUTASSETLOOKUP', 'INSPECTINASSETLOOKUP']) {
      const at = words.findIndex((w) => w.includes(lookup))
      expect(at, `${lookup} present`).toBeGreaterThanOrEqual(0)
      expect(words[at + 1], `${lookup} is followed by VERIFY`).toMatch(/VERIFY/)
    }
  })

  it('bounds the output to exactly one asset', () => {
    // Without this a spend can satisfy the amount check and still inject
    // further assets alongside the one bound.
    const words = (arkade.ArkadeScript.decode(enforcePayToAsset(DEST, ASSET)) as unknown as string[]).map(String)
    const at = words.findIndex((w) => w.includes('INSPECTOUTASSETCOUNT'))
    expect(at).toBeGreaterThanOrEqual(0)
    // Anchored, and the comparand pinned: `/EQUALVERIFY/` alone passes for
    // `99 EQUALVERIFY` — i.e. for a covenant bounding the output to some OTHER
    // number of assets, which is not what this test claims to prove.
    expect(words.slice(at + 1, at + 3).join(' ')).toMatch(/^1 EQUALVERIFY$/)
  })

  it('binds the asset id, so the script differs per asset', () => {
    // The id is baked into the pkScript, exactly as refundLocktime is: a row
    // naming a different asset derives a different script, and a different
    // script cannot spend the funded one.
    const other = enforcePayToAsset(DEST, { txid: new Uint8Array(32).fill(0xcd), groupIndex: 2 })
    const group = enforcePayToAsset(DEST, { ...ASSET, groupIndex: 3 })
    expect(hex.encode(other)).not.toBe(hex.encode(enforcePayToAsset(DEST, ASSET)))
    expect(hex.encode(group)).not.toBe(hex.encode(enforcePayToAsset(DEST, ASSET)))
  })

  it('refuses a malformed asset id rather than encoding one', () => {
    expect(() => enforcePayToAsset(DEST, { txid: new Uint8Array(31), groupIndex: 0 })).toThrow(/32 bytes/)
    expect(() => enforcePayToAsset(DEST, { ...ASSET, groupIndex: -1 })).toThrow(/\[0, 65535\]/)
    expect(() => enforcePayToAsset(DEST, { ...ASSET, groupIndex: 1.5 })).toThrow(/\[0, 65535\]/)
  })
})

/**
 * The wire Asset ID codec, and specifically its endianness.
 *
 * `docs/rfq-protocol.md` § 2 carries an asset as 68 lowercase hex characters;
 * the introspection opcodes want `(txid, gidx)`. The Arkade Assets spec fixes
 * the encoding as `AssetId := { txid: bytes32, gidx: u16 LE }`, and the LE is
 * the whole reason this has tests: reading it big-endian does not fail, it
 * silently names a different asset.
 */
describe('parseAssetId / serializeAssetId', () => {
  const TXID = new Uint8Array(32).fill(0xab)

  it('reads the group index little-endian', () => {
    // group 1 is `0100`, NOT `0001`. Big-endian would read this as 256.
    expect(parseAssetId(`${hex.encode(TXID)}0100`).groupIndex).toBe(1)
    // and the byte pair that WOULD be 1 big-endian is 256 here
    expect(parseAssetId(`${hex.encode(TXID)}0001`).groupIndex).toBe(256)
  })

  it('keeps the txid in internal byte order, unreversed', () => {
    // The endianness rule covers integer fields; a txid is a byte string. The
    // leading 64 hex chars are therefore NOT the explorer-reversed form.
    const id = parseAssetId(`${hex.encode(TXID)}0200`)
    expect(hex.encode(id.txid)).toBe(hex.encode(TXID))
  })

  it('round-trips both directions', () => {
    const id = `${hex.encode(TXID)}2a00`
    expect(serializeAssetId(parseAssetId(id))).toBe(id)
    expect(parseAssetId(serializeAssetId({ txid: TXID, groupIndex: 42 }))).toEqual({ txid: TXID, groupIndex: 42 })
  })

  it('matches the identity the registry card validates', () => {
    // ^(btc|[0-9a-f]{68})$ — 32-byte txid + u16 is exactly 68 characters.
    expect(serializeAssetId({ txid: TXID, groupIndex: 7 })).toMatch(/^[0-9a-f]{68}$/)
  })

  it('refuses anything that is not a 68-char lowercase hex id', () => {
    expect(() => parseAssetId(hex.encode(TXID))).toThrow(/68 lowercase hex/)
    expect(() => parseAssetId(`${hex.encode(TXID).toUpperCase()}0100`)).toThrow(/68 lowercase hex/)
    expect(() => parseAssetId(`${hex.encode(TXID)}01zz`)).toThrow(/68 lowercase hex/)
  })

  it('parses a REAL asset id minted on regtest', () => {
    // Not synthetic. Minted 2026-08-15 on the arkade-regtest stack via
    // `wallet.assetManager.issue({ amount, metadata })`, which returned:
    //
    //   arkTxId  b227e0d9a502713f46e441bdf7be8bbffde5091e23975de2527c6dbf94358dd6
    //   assetId  b227e0d9...358dd6 + 0000
    //
    // Three properties of the wire format, confirmed against real output
    // rather than inferred from the spec's character count: the id is exactly
    // 68 characters, its leading 64 ARE the genesis txid in the same
    // orientation the SDK reports `arkTxId` (i.e. not reversed), and the
    // remainder is the u16 group index.
    const arkTxId = 'b227e0d9a502713f46e441bdf7be8bbffde5091e23975de2527c6dbf94358dd6'
    const assetId = `${arkTxId}0000`
    expect(assetId).toMatch(/^[0-9a-f]{68}$/)

    const parsed = parseAssetId(assetId)
    expect(hex.encode(parsed.txid)).toBe(arkTxId)
    // CAVEAT, deliberately recorded: this asset's group index is 0, which is
    // byte-identical little- and big-endian. So this fixture confirms the
    // LAYOUT but cannot disambiguate the ENDIANNESS — that is what the
    // synthetic `0100`/`0001` case above is for. A real id with a nonzero
    // group index would subsume both; we have not minted one.
    expect(parsed.groupIndex).toBe(0)
    expect(serializeAssetId(parsed)).toBe(assetId)
  })

  it('refuses a group index a u16 cannot carry', () => {
    expect(() => serializeAssetId({ txid: TXID, groupIndex: 0x10000 })).toThrow(/\[0, 65535\]/)
  })

  it('refuses it at the COVENANT boundary too, not only when serializing', () => {
    // The one that matters. `enforcePayToAsset` validates through
    // `assertAssetId`, so a bound present only in `serializeAssetId` leaves the
    // script builder accepting an out-of-range index, encoding it, and
    // producing a covenant the emulator rejects at SPEND time — with
    // `OP_VERIFY failed vin=0` and nothing naming the cause, on a lockup that
    // is already funded.
    expect(() => enforcePayToAsset(DEST, { txid: TXID, groupIndex: 0x10000 })).toThrow(/\[0, 65535\]/)
  })
})

describe('enforcePayToAsset — txid orientation', () => {
  const ASSET = { txid: new Uint8Array(32).fill(0).map((_, i) => i + 1), groupIndex: 1 }

  it('pushes the txid REVERSED, because that is what the opcode matches', () => {
    // The trap, pinned. `asset.txid` is wire order — what `parseAssetId`
    // returns and the registry publishes — but INSPECTOUTASSETLOOKUP matches
    // the reversed 32 bytes. Pushing wire order makes the lookup report the
    // asset ABSENT (`0 0`), which fails the covenant with nothing in the error
    // naming the cause; the emulator says only `OP_VERIFY failed`. Established
    // on regtest against a real minted asset.
    const script = hex.encode(enforcePayToAsset(DEST, ASSET))
    const wireOrder = hex.encode(ASSET.txid)
    const reversed = hex.encode(Uint8Array.from(ASSET.txid).reverse())
    expect(script).toContain(reversed)
    expect(script).not.toContain(wireOrder)
  })

  it('does not mutate the caller’s asset id', () => {
    const mine = { txid: Uint8Array.from(ASSET.txid), groupIndex: 1 }
    const before = hex.encode(mine.txid)
    enforcePayToAsset(DEST, mine)
    expect(hex.encode(mine.txid)).toBe(before)
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

  it('pushes the txid REVERSED, from a caller-supplied wire order', () => {
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
        nonInteractiveClaim: { receiverPkScript: RECEIVER_PAYOUT, emulatorPubkey: EMULATOR },
        nonInteractiveRefund: { senderPkScript: DEST, emulatorPubkey: EMULATOR, withoutReceiver: true },
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
