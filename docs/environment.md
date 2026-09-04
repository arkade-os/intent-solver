# Environment findings

Facts established by reading the published packages and by running against the
real services, rather than from documentation. Recorded because they change what
is buildable and testable, and each was a surprise.

## The non-interactive claim is not in any published SDK

The receive leg's covenant does not live in a program artifact. It is built
inside the SDK by passing `nonInteractiveClaim: { receiverPkScript,
emulatorPubkey }` to `VHTLC.Script`, which adds a seventh leaf: the preimage
condition plus a 2-of-2 of `[arkServer, tweak(emulatorPubkey, enforcePayTo)]`.

`enforcePayTo` is the covenant that makes the claim safe to hand to a third
party — it pins the output script to the receiver's taproot key and requires the
output value to be at least the input value, so anyone may push the claim but the
funds can only land on the user's script.

**This API exists in no published version.** Checked directly:

| build                              | `nonInteractiveClaim` |
| ---------------------------------- | --------------------- |
| npm `0.4.52`                       | absent                |
| npm `0.4.53`                       | absent                |
| npm `0.4.54` (latest)              | absent                |
| vendored `0.4.52` (wallet PR #750) | **present** (6 files) |

The two tarballs both claim version `0.4.52` and have different SHA-256 digests.
The vendored one is a build of the still-open upstream PR `arkade-os/ts-sdk#613`
(`feat/nic`). The receive leg therefore depends on unmerged upstream code, and
that is a decision to make deliberately rather than discover later.

## covclaimd wire protocol

Recovered from the vendored build rather than invented.

`GET /v1/preimage/covclaimd-pubkey` → `{ covclaimd_pub_key, emulator_pub_key }`
(both hex).

`POST /v1/reveal`:

```json
{
  "swap_address": "<arkade address>",
  "packet": {
    "ciphertext": "<base64>",
    "arkade_script": "<base64>"
  },
  "taptree": "<hex>"
}
```

The preimage is ECIES-encrypted to covclaimd's key, never sent in the clear:
ephemeral secp256k1 key, ECDH, HKDF-SHA256 with info `covclaimd/preimage/v1` and
the ephemeral public key as salt, then AES-GCM with that same key as additional
data. Wire layout is `ephPub(33) || nonce(12) || ciphertext`.

This is what keeps the provider out of the preimage's path: the client encrypts
to covclaimd directly, and the provider only ever sees the preimage once it
appears in a claim witness — which cannot exist until the funding output has been
spent to the user's script.

## Sandbox notes

- The local stack's block explorer (mempool backend) refuses to boot without
  fetching mining-pool metadata from GitHub, which a restricted egress policy
  blocks. Nothing on the Arkade or Lightning path needs it, so the startup gate was
  made non-fatal rather than worked around.
- A backend may hand back an expiry as a JavaScript `Date` rather than a number.
  The port normalises every such value to unix seconds, so no vendor type escapes
  the adapter — see {@link LightningBackend}'s own note on the same rule.

## Known trust assumptions and limits (send leg, beta)

Surfaced by an adversarial review of the money paths. None block a first mainnet
send, but each is a real edge an operator must know before scaling.

- **The server-independent exit is operator-driven, not automatic.** The swap
  script carries a `unilateralClaim` leaf (provider-only, behind a CSV) and
  `cli unilateral-exit` now spends it, so a *censoring* server is a delay and a
  fee bill rather than the unmitigated full-amount loss it once was. The two
  forms differ in what they touch, and the difference is the whole safety
  boundary:
  - `unilateral-exit <id> [preimage]` — decides the leaf, quotes the cost and
    reaches every refusal a real exit would. Signs nothing, broadcasts nothing,
    spends nothing.
  - `unilateral-exit <id> [preimage] --go` — signs every transaction of the exit
    and **broadcasts a fee-funding splitter as a side effect**, spending the
    solver's own onchain sats to fund the CPFP children. Not reversible. Run the
    first form and read its quote before reaching for this one.

  Nothing reaches for either on its own: an operator has to notice. The CSV runs
  from the moment the lockup confirms onchain, not from when it was funded, so
  the recovery is slow by construction and `refundLocktimeFor` reserves the
  ~7-day window for it. Mitigation in place meanwhile: past the refund deadline a
  persistently failing claim escalates a swap to `stuck` rather than looping
  silently.

- **The Arkade server's countersigning power is verified, not trusted.** A claim
  needs the server, but the checkpoint PSBTs it returns are txid-matched against
  the locally built ones before anything is signed (and the returned ark txid must
  equal the submitted transaction's), so a forged response cannot harvest the
  provider's signature or the preimage. Censorship remains the server's only
  leverage — the previous bullet.

- **Covenant refund is a hard 2-of-2 of Arkade server + emulator.** The client-key
  refund leaf was traded away for a stateless client. Permanent loss or key
  rotation of *either* service strands failed-swap lockups forever (a temporary
  outage only defers — the CLTV leaf has no expiry and the sweep retries). The
  emulator key is snapshotted per swap at quote time, so a rotation only breaks
  swaps quoted before it; the fix if this becomes real is to add the client-key
  refund leaf back alongside the covenant one (`TODO(client-key-refund)`).

- **Late funding is refused, not paid.** `refundLocktime` is anchored at quote
  time but the unilateral CSV matures from funding time, so a lockup that lands
  long after the quote would shrink the claim window. The lockup deadline is a
  hard precondition enforced the moment funding is first observed (not only while
  a watcher is running), so a stale lockup surfaced by `drive`-later or recovery
  is refunded, never paid.

- **An overfunded lockup is refused, and anyone can force one.** The
  exact-amount gate exists because a claim sweeps whole vtxos with no change —
  paying an overfunded swap would hand the excess to the provider with no path
  back. But the lockup address is public once quoted (status lookups, and the
  payee inherently knows the payment hash), so a griefer can dust the address
  with a few sats and kill a live swap, freezing the client's funds until the
  covenant refund matures (~7 days on mainnet). It is griefing, not theft: the
  covenant still pays only the client's own address.

- **A truly-failed payment can sit in `pending`.** The adapter's failed-status
  set is a deliberate allowlist: mislabelling a live payment dead is the
  unrecoverable error, so anything unrecognised stays `pending`. The cost is a
  provider row that polls until an operator looks; the client is unharmed because
  their covenant refund is theirs to push after the deadline regardless.

- **No provider fee.** The provider pays the invoice plus routing and only ever
  claims the invoice amount, losing the routing fee per swap. Fine for a capped
  PoC; a spread belongs in the quote before volume.

- **Exposure cap counts quotes, and quotes are metered.** `maxExposedSats`
  bounds the summed amount of every non-terminal swap — including bare `quoted`
  rows, because a quote is capacity the provider may have to honour. Since an
  unauthenticated quote would otherwise squat the cap for free, quote creation
  is rate-limited per requester identity (5 per lockup window; socket IP on
  HTTP, author key on relay). A distributed attacker can still out-shout the
  limiter — it prices spam per identity, it does not make squatting impossible;
  the cap remains the bound on what is ever at risk. A check-and-insert race
  can over-commit the cap slightly under concurrent quotes; safe at the current
  500–1000 sat / 3000 cap, revisit before raising limits.

## CLTV matures against median-time-past, not wall clock

The Arkade server enforces a seconds-based CLTV (the covenant refund's
`refundLocktime`) against **median-time-past** (BIP-113) — the median timestamp
of the last 11 blocks — not wall-clock time and not the tip block's own
timestamp. MTP lags wall clock by roughly an hour on mainnet.

Observed live: a covenant funded with a 15-minute refund deadline was still
rejected with `FORFEIT_CLOSURE_LOCKED` well past the wall-clock deadline. At that
moment the tip block's timestamp was already ~250s past the locktime, yet MTP was
~80 minutes *behind* it. The refund only matures once MTP crosses the locktime,
~8 blocks later.

Two consequences:

- **For the real send leg this is safe and immaterial.** `refundLocktimeFor`
  quotes a deadline ~7 days out; an MTP lag of ~1h against that is negligible, and
  it moves the client's refund *later* in wall-clock terms, never earlier — the
  safe direction for the provider, whose own claim path is collaborative (no
  locktime) and unaffected.
- **For testing, a near-future locktime is unusable.** `test-refund` therefore
  defaults its deadline to three hours in the *past*, which MTP has already
  crossed, so the refund is spendable immediately and exercises the identical
  leaf. A positive offset can still be passed to exercise the waiting path.
