---------------------------- MODULE OnchainReceive ----------------------------
(***************************************************************************)
(* ONCHAIN RECEIVE CORRIDOR   onchain:BTC -> arkade:BTC                    *)
(*                                                                         *)
(* WHICH TYPESCRIPT THIS SPECIFIES                                         *)
(*                                                                         *)
(*   src/db/onchainReceiveSwaps.ts   the durable row, LEGAL_EDGES,         *)
(*                                   transition(), patch(), fail(),        *)
(*                                   committedSats(), findRecoverable()    *)
(*   src/receive/onchainOrchestrator.ts  the whole state machine: quote(),  *)
(*                                   tick(), tickAll(), step(), whenQuoted, *)
(*                                   whenAwaitingConfirmations,            *)
(*                                   whenFundingArkade, whenAwaitingClaim,  *)
(*                                   whenClaimed, whenRefundingArkade      *)
(*   src/core/onchainReceive.ts      htlcLocktimeFor,                      *)
(*                                   arkadeRefundLocktimeFor,              *)
(*                                   evaluateOnchainReceiveAcceptance,     *)
(*                                   evaluateOnchainReceiveFunding,        *)
(*                                   MIN_ARKADE_FUND_WINDOW,               *)
(*                                   SETTLE_SAFETY_MARGIN,                 *)
(*                                   MAX_REFUND_HORIZON, MIN_SETTLE_WINDOW,*)
(*                                   DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT*)
(*   src/receive/onchainArkadeOps.ts findLockups / findLockupOutpoints /   *)
(*                                   findClaimPreimage / fund / refund     *)
(*   src/receive/fundLockup.ts       the solver's own float leaving        *)
(*   src/onchain/claim.ts            the L1 sweep (no CLTV on the claim    *)
(*                                   leaf; sequence 0xfffffffd, RBF)       *)
(*   src/receive/orchestrator.ts:86-99  EMPTY_LOCKUP_GRACE                 *)
(*   packages/solver-app/src/worker.ts                   the queue fan-out and its safety claim*)
(*                                                                         *)
(* AUTHORITY FOR THE EDGE TABLE                                            *)
(*                                                                         *)
(* src/db/onchainReceiveSwaps.ts lines 64-75, verbatim:                    *)
(*                                                                         *)
(*   quoted:                 ['awaiting_confirmations', 'refused']         *)
(*   awaiting_confirmations: ['funding_arkade', 'refused']                 *)
(*   funding_arkade:         ['awaiting_claim', 'stuck']                   *)
(*   awaiting_claim:         ['claimed', 'refunding_arkade', 'stuck']      *)
(*   claimed:                ['settled', 'stuck']                          *)
(*   refunding_arkade:       ['claimed', 'refunded', 'stuck']              *)
(*   settled:  []   refunded: []   refused:  []   stuck:    []             *)
(*                                                                         *)
(* plus src/db/onchainReceiveSwaps.ts:49-63                                *)
(*   NON_TERMINAL = quoted awaiting_confirmations funding_arkade           *)
(*                  awaiting_claim claimed refunding_arkade                *)
(*   EXPOSED      = funding_arkade awaiting_claim claimed refunding_arkade *)
(*                                                                         *)
(* `Edges` below adds exactly two edges the TypeScript does not have —     *)
(* none -> {quoted, rejected} and rejected -> {} — which model quote()'s   *)
(* INSERT-or-refuse.  In the TypeScript that is a row appearing or not     *)
(* appearing, not a transition.  They are marked in the definition.        *)
(* Everything else is diffable line for line against LEGAL_EDGES.          *)
(*                                                                         *)
(* THE STRUCTURAL FACT THIS CORRIDOR IS DEFINED BY                         *)
(*                                                                         *)
(* This is the ONLY corridor with both `claimed` and `settled`, and the    *)
(* window between them is the sharpest exposure in the system:             *)
(*                                                                         *)
(*   `claimed`  the CLIENT ALREADY HAS THE SOLVER'S SATS.  Some party      *)
(*              spent the Arkade lockup with a witness that hash-verifies  *)
(*              against payment_hash, and the covenant pinned that spend   *)
(*              to clientPayoutPkScript.  The solver has collected NOTHING.*)
(*   `settled`  the solver BROADCAST — not confirmed — its own L1 spend of *)
(*              the client's HTLC.                                         *)
(*                                                                         *)
(* Between those two states the solver is down `Amount` sats and its only  *)
(* recourse is a single L1 outpoint that the CLIENT may take back once     *)
(* htlc_locktime matures.  Every deadline in core/onchainReceive.ts exists *)
(* to keep that window strictly inside (funding, htlc_locktime), and the   *)
(* ordering that does it is                                                *)
(*                                                                         *)
(*   arkadeRefundLocktime R  +  SETTLE_SAFETY_MARGIN  <=  htlcLocktime E   *)
(*                                                                         *)
(* i.e. the SOLVER's escape hatch opens BEFORE the client's — role-        *)
(* reversed from both send legs, because here the solver is the one who    *)
(* funded a script.  `BreakDeadlineOrder` deletes the `htlcLocktime -      *)
(* SETTLE_SAFETY_MARGIN` term from arkadeRefundLocktimeFor                 *)
(* (src/core/onchainReceive.ts:75-76) and is the mandated mutation.        *)
(*                                                                         *)
(* TWO CONTESTED OUTPUTS, WITH DIFFERENT ARBITERS                          *)
(*                                                                         *)
(*   The ARKADE lockup (SOLVER-funded).  SwapCore's `conf`.  Spenders:     *)
(*   "clientClaim" (the collaborative claim leaf the client holds, or      *)
(*   covclaimd's nonInteractiveClaim — BOTH pinned to clientPayoutPkScript *)
(*   and NEITHER carrying a timelock, so this spend is live from the       *)
(*   instant of funding and never expires) and "solverRefund" (the         *)
(*   covenant refund, gated on the absolute CLTV `refund_locktime` which   *)
(*   matures against the CHAIN TIP's timestamp, not wall clock).  The      *)
(*   arbiter is the Arkade SERVER: it co-signs exactly one spend, there is *)
(*   no mempool and no reorg, so acceptance and confirmation coincide.     *)
(*                                                                         *)
(*   The L1 HTLC (CLIENT-funded).  Local `bcast` / `l1`.  Spenders:        *)
(*   "solverClaim" (the claim leaf — needs P, carries NO CLTV) and         *)
(*   "clientRefund" (opens at htlc_locktime against median-time-past).     *)
(*   The arbiter is a MINER, so broadcast and confirmation are separate    *)
(*   steps and a reorg can evict an insufficiently deep funding.           *)
(*                                                                         *)
(* SwapCore has vocabulary for one contested output; the second one is     *)
(* local.  See the report — this is the one gap in the shared module, and  *)
(* the onchain send corridor hit it too.                                   *)
(*                                                                         *)
(* WHAT IS DELIBERATELY ABSTRACTED AWAY                                    *)
(*                                                                         *)
(*  - Amounts.  Every swap is `Amount` sats and the client's L1 HTLC is    *)
(*    either exactly right or absent.  whenQuoted's exact-amount filter    *)
(*    (:452) protects against adopting a partial/dust payment, which is a  *)
(*    pre-exposure concern; it cannot reach the money invariant.           *)
(*  - The preimage column.  P is written in the SAME UPDATE as the edge    *)
(*    into `claimed` (:634, :895), so `st[s] = "claimed"` already means "P *)
(*    is on disk and the L1 sweep needs nothing external".  A separate     *)
(*    variable could only disagree with the state, which the code prevents.*)
(*  - findClaimPreimage's hash verification (src/arkade/wallet.ts:315-354).*)
(*    A witness of the right SHAPE is never trusted, only a matching HASH, *)
(*    so a readable claim IS a valid P.  Modelling a bogus one adds a      *)
(*    paid-and-uncollected terminal that `stuck` already covers.           *)
(*  - covclaimd.  Modelled as "somebody claims the lockup, or nobody       *)
(*    does" — which is exactly what whenAwaitingClaim does: it looks for a *)
(*    spend and does not care who made it (:610-615).  cli.ts:444-449 does *)
(*    not configure a covclaimd at all, so a spec that REQUIRED covclaimd  *)
(*    to act would not describe the shipped deployment.                    *)
(*  - The reservation ledger (src/arkade/reservations.ts).  It is a second *)
(*    in-process guard that also evaporates in Go, but its failure mode is *)
(*    liveness (a swap dies with VTXO_ALREADY_SPENT), not money.  See the  *)
(*    report.                                                              *)
(*  - The event log, column allowlists, patch().  patch() is unguarded on  *)
(*    this leg too, but the only columns it may write (refund_outcome,     *)
(*    arkade_refund_txid) are advisory and no automatic path reads them.   *)
(*    NOTE this makes EMPTY_LOCKUP_GRACE's stated assumption ("nothing on  *)
(*    this leg patches a row, so updatedAt does not move while we wait",   *)
(*    :910-911) true today and unenforced tomorrow.                        *)
(*                                                                         *)
(* MODELLING DECISIONS THAT ARE ASSUMPTIONS, NOT FACTS                     *)
(*                                                                         *)
(*  (A1) `FundIsIdempotent`.  arkade.fund -> fundLockup -> wallet.send     *)
(*       carries NO idempotency key of any kind, and the orchestrator      *)
(*       itself says so (:538-545).  The green model ASSUMES a Go rewrite  *)
(*       adds one, exactly as LightningSend assumes the Lightning backend  *)
(*       honours the derived key.  With it FALSE — today's TypeScript —    *)
(*       NoDoublePay fails, and it fails WITHOUT a crash: two workers      *)
(*       reading the same `funding_arkade` row both find the lockup empty  *)
(*       and both send.  See OnchainReceive_DoubleFund.cfg.               *)
(*                                                                         *)
(*  (A2) The drive loop keeps up.  `Tick` is disabled while any swap has   *)
(*       an immediately-completable solver step outstanding (`Urgent`).    *)
(*       Without it, "the solver stopped for 90 minutes" is a valid trace  *)
(*       and every timing guard looks broken.  This does NOT weaken the    *)
(*       concurrency model: workers still race, crash mid-action, lose     *)
(*       CASes and double-broadcast, all inside a frozen tick.  What is    *)
(*       deliberately NOT urgent is every wait the code is supposed to sit *)
(*       through: an unconfirmed L1 funding, an `awaiting_claim` row whose *)
(*       gate is still open, and a `refunding_arkade` row whose CLTV has   *)
(*       not matured against the chain tip (FORFEIT_CLOSURE_LOCKED).       *)
(*                                                                         *)
(*  (A3) `MempoolExclusive`.  First-seen relay: a conflicting spend of an  *)
(*       outpoint that is already in the mempool does not propagate.  With *)
(*       it FALSE both spends sit in the mempool and the miner picks, and  *)
(*       since the solver's claim tx is RBF-signalling                     *)
(*       (src/onchain/claim.ts:44) the client can in principle fee-bump    *)
(*       past it.  Green keeps it TRUE; see the report.                    *)
(*                                                                         *)
(*  (A4) `IndexerNeverLies`.  findLockups is spendableOnly and             *)
(*       findClaimPreimage must additionally fetch the spending virtual    *)
(*       transaction, so the two views do not go true together.  With the  *)
(*       flag TRUE a landed claim is readable immediately.  With it FALSE  *)
(*       the pair reads exactly like the inexplicable case and             *)
(*       EMPTY_LOCKUP_GRACE is all that stands between a COMPLETED swap    *)
(*       and terminal `stuck` — from which nothing ever sweeps L1.         *)
(*                                                                         *)
(*  (A5) `ClaimFeeAffordable`.  whenClaimed refuses to broadcast when the  *)
(*       fee at the current rate leaves less than ONCHAIN_DUST_SATS        *)
(*       (:771-786) and parks the row in terminal `stuck` — on a leg with  *)
(*       NO operator retry command.  Green assumes fees never spike into   *)
(*       that branch, which is an assumption about the fee market, not a   *)
(*       property of the code.                                             *)
(*                                                                         *)
(*  (A6) The client funds the L1 HTLC at most once.  A reorg is modelled   *)
(*       as permanent eviction rather than as re-broadcast; re-funding     *)
(*       after an eviction would only re-enter states already reachable.   *)
(*                                                                         *)
(*  (A7) `MtpLag` is BOUNDED, i.e. blocks keep arriving.  `Tick` is        *)
(*       disabled once wall clock would outrun the chain tip's clock by    *)
(*       more than MtpLag, which is how the lag bound is realised without  *)
(*       a second fairness condition.  Real median-time-past is the median *)
(*       of eleven block timestamps and can stall arbitrarily.  The bound  *)
(*       constrains BOTH sides — the solver's covenant CLTV and the        *)
(*       client's L1 refund mature against the same clock — so a stall     *)
(*       freezes the race rather than tilting it, which is why this is an  *)
(*       assumption and not a finding.  See the ASSUME below for the       *)
(*       quantity MtpLag must be compared against, which is NOT the one an *)
(*       earlier revision of this module compared it against.              *)
(*                                                                         *)
(*  NOTE what is deliberately NOT on this list: LockupProvablySpent.  It   *)
(*  is a COUNTERFACTUAL, not an assumption — every cfg in this directory   *)
(*  sets it FALSE, which is the shipped spendableOnly read.  An earlier    *)
(*  revision set it TRUE everywhere, including in the green model, and so  *)
(*  checked a `whenFundingArkade` the TypeScript does not have.  See       *)
(*  AlreadyFunded and the fairness note.                                    *)
(*                                                                         *)
(* WHAT A GO IMPLEMENTER MUST PRESERVE                                     *)
(*                                                                         *)
(*  1. awaiting_confirmations -> funding_arkade is committed BEFORE        *)
(*     arkade.fund (:532 then :594).  That ordering is right and is the    *)
(*     template; it is NOT sufficient on its own, because the row stays in *)
(*     `funding_arkade` for the whole duration of the send and every       *)
(*     worker that reads it there will send again.  Add a per-swap lease   *)
(*     or a funding idempotency key.  See (A1) and SubmitArkFund.          *)
(*  2. The confirmation depth is the ENTIRE reorg policy and it is checked *)
(*     exactly once, at that same edge (:512).  Nothing re-validates it    *)
(*     after the solver has paid out.  See BreakConfirmations and note the *)
(*     missing lower clamp: Math.min(x ?? 1, 6) with no Math.max(1, ...)   *)
(*     makes `(output?.confirmations ?? 0) >= 0` vacuously true for a      *)
(*     MISSING output, not merely a shallow one.                           *)
(*  3. R + SETTLE_SAFETY_MARGIN <= E is the corridor's ordering invariant. *)
(*     Today MAX_REFUND_HORIZON always binds first and the margin term is  *)
(*     dead code; raising the horizon silently re-arms it.  See            *)
(*     OnchainReceive_Broken.cfg and its control.                          *)
(*  4. A late-but-valid claim must be re-read BEFORE every refund attempt  *)
(*     (:892-896).  refunding_arkade -> claimed is a RECOVERY, not a       *)
(*     failure: it is what turns a lost Arkade race into a swap the solver *)
(*     can still settle on L1.                                             *)
(*  5. `settled` and `refunded` record a BROADCAST / a submission, never a *)
(*     confirmation, and neither is in NON_TERMINAL.  Nothing revisits     *)
(*     them.  See the Collected() definition and the report.               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC, SwapCore

CONSTANTS
    HtlcLocktime,        \* htlc_locktime E — the CLIENT's L1 refund leaf matures
    SettleSafetyMargin,  \* SETTLE_SAFETY_MARGIN     (15 min)
    RefundHorizon,       \* MAX_REFUND_HORIZON (2 h), from quote time = clock 0
    MinArkFundWindow,    \* MIN_ARKADE_FUND_WINDOW   (90 min)
    LockupDeadline,      \* created_at + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT
    MinConfirmations,    \* min_confirmations
    MtpLag,              \* how far the chain tip's clock may trail wall clock
    BreakDeadlineOrder,  \* MUTATION: drop `htlcLocktime - SETTLE_SAFETY_MARGIN`
    BreakConfirmations,  \* MUTATION: the depth gate becomes vacuous
    FundIsIdempotent,    \* MUTATION: see (A1)
    LockupProvablySpent, \* COUNTERFACTUAL: whenFundingArkade's alreadyFunded read
                         \* is NOT spendableOnly.  FALSE is the shipped TypeScript
                         \* (arkade.findLockups, :551) and is what every cfg here
                         \* sets; TRUE is the fix a Go rewrite should adopt.
    IndexerNeverLies,    \* MUTATION: see (A4)
    ClaimFeeAffordable,  \* MUTATION: see (A5)
    MempoolExclusive,    \* MUTATION: see (A3)
    AtomicAdmission      \* MUTATION: quote() is one conditional INSERT

MinOf(a, b) == IF a <= b THEN a ELSE b

(***************************************************************************)
(* arkadeRefundLocktimeFor, src/core/onchainReceive.ts:75-76:              *)
(*                                                                         *)
(*   Math.min(htlcLocktime - SETTLE_SAFETY_MARGIN, now + MAX_REFUND_HORIZON)*)
(*                                                                         *)
(* with `now` = quote time = clock 0.  THE MUTATION deletes the first      *)
(* bound, leaving the horizon cap alone to decide — which is exactly what  *)
(* happens under the shipped constants anyway, where the horizon (7200 s)  *)
(* is always smaller than htlcLocktime - 900 (>= 9900 s) and the margin    *)
(* term therefore never selects.  The invariant holds today as a SIDE      *)
(* EFFECT of the horizon cap, not because the margin term does any work;   *)
(* raise MAX_REFUND_HORIZON and the margin term is the only thing left.    *)
(* The green cfg reproduces that shape (RefundHorizon binds strictly), the *)
(* broken cfg raises the horizon AND deletes the margin term, and          *)
(* OnchainReceive_BrokenControl.cfg raises the horizon and KEEPS it.       *)
(***************************************************************************)
RefundLocktime ==
    IF BreakDeadlineOrder
      THEN RefundHorizon                                        \* <<< THE MUTATION
      ELSE MinOf(HtlcLocktime - SettleSafetyMargin, RefundHorizon)

(***************************************************************************)
(* The constant ordering is the whole content of the timing guards.        *)
(*                                                                         *)
(* Real values, from src/core/onchainReceive.ts with minConfirmations = 1  *)
(* and T0 = quote time:                                                    *)
(*                                                                         *)
(*   client's funding deadline   T0 +   900   (DEFAULT_..._LOCKUP_TIMEOUT) *)
(*   arkade funding gate closes  T0 +  1800   (R - MIN_ARKADE_FUND_WINDOW) *)
(*   arkade refund opens      R  T0 +  7200   (MAX_REFUND_HORIZON binds)   *)
(*   onchain htlc deadline    E  T0 + 11400   (600*1 + 2*MIN_SETTLE_WINDOW)*)
(*                                                                         *)
(* which leaves E - R = 4200 s for the whole claimed -> settled sweep      *)
(* after the very latest possible Arkade claim.  The ASSUMEs below are     *)
(* that budget written as an ordering, so a cfg cannot quietly make it     *)
(* negative without saying so.                                             *)
(***************************************************************************)
ASSUME MinConfirmations >= 1                     \* the missing Math.max(1, ...)
(***************************************************************************)
(* THE TIP-LAG BUDGET IS E - R, NOT SETTLE_SAFETY_MARGIN.                  *)
(*                                                                         *)
(* An earlier revision asserted `MtpLag < SettleSafetyMargin`, on the       *)
(* reading that the margin term is what covers the tip lag.  That is FALSE  *)
(* for the shipped constants and it names the wrong pair:                   *)
(*                                                                         *)
(*   SETTLE_SAFETY_MARGIN  900 s   (src/core/onchainReceive.ts:51)         *)
(*   MTP lag              ~3600 s  (src/core/send.ts:39-42, the codebase's *)
(*                                  own figure, and the reason              *)
(*                                  MIN_CLAIM_WINDOW is 90 min not 15)      *)
(*                                                                         *)
(* 900 < 3600, so by this repo's own rule ("a wall-clock margin smaller     *)
(* than the MTP lag is no margin at all") the margin term could not carry   *)
(* the lag even if it selected — and it does not select: MAX_REFUND_HORIZON *)
(* binds, so R = T0 + 7200 and E = T0 + 11400.  The real headroom between   *)
(* the solver's escape hatch opening and the client's is                    *)
(*                                                                         *)
(*   E - R  =  4200 s,  against a ~3600 s tip lag — 600 s of slack, and it  *)
(*   comes entirely from the HORIZON CAP, not from SETTLE_SAFETY_MARGIN.    *)
(*                                                                         *)
(* GO IMPLEMENTERS: that 600 s is the whole cushion, and raising            *)
(* MAX_REFUND_HORIZON spends it.  Guarded on BreakDeadlineOrder because the *)
(* mutation deliberately drives E - R to zero.                             *)
(***************************************************************************)
ASSUME BreakDeadlineOrder
       \/ MtpLag < HtlcLocktime - RefundLocktime  \* the real tip-lag budget
ASSUME SettleSafetyMargin < HtlcLocktime         \* keeps the subtraction a Natural
ASSUME MinArkFundWindow < RefundLocktime         \* a funding window exists at all
ASSUME BreakDeadlineOrder                        \* the ordering invariant, or the
       \/ RefundLocktime + SettleSafetyMargin <= HtlcLocktime   \* mutation that kills it
ASSUME HtlcLocktime <= MaxClock

VARIABLES
    chainTime,      \* the chain tip's clock.  Monotone, <= clock, trails by
                    \* <= MtpLag.  BOTH the L1 nLockTime (BIP65 / MTP) and the
                    \* Arkade covenant's absolute CLTV mature against THIS,
                    \* never against wall clock.
    htlc,           \* [Swaps -> "none"|"seen"|"confirmed"|"gone"] the CLIENT's
                    \* L1 HTLC funding output.  "seen" = broadcast, 0 conf, and
                    \* whenQuoted adopts it at that depth (:451-459).  "gone" =
                    \* reorged away; only a "seen" output can be, which IS the
                    \* whole content of the min_confirmations policy.
    arkFund,        \* [Swaps -> 0..2] Arkade lockup fundings the solver's own
                    \* wallet actually made.  > 1 == the solver paid the same
                    \* lockup twice out of its own float.
    bcast,          \* [Swaps -> SUBSET L1Spends] spends BROADCAST for the L1 outpoint
    l1,             \* [Swaps -> SUBSET L1Spends] the CONFIRMED spend.  At most one.
    refEmptySeen    \* [Swaps -> BOOLEAN] EMPTY_LOCKUP_GRACE, abstracted: a
                    \* refunding_arkade row that reads empty may not be judged
                    \* on ONE look (:898-917).

OrVars == << chainTime, htlc, arkFund, bcast, l1, refEmptySeen >>
vars   == << clock, st, loc, conf, serverUp,
             chainTime, htlc, arkFund, bcast, l1, refEmptySeen >>

(***************************************************************************)
(* SwapCore constants supplied by cfg definition override.                 *)
(***************************************************************************)
ORPhases     == { "idle", "read", "fundCalled", "claimSent", "refundSent" }
ORResults    == { "none", "capOk", "capFull", "funded", "empty" }
ORSpendKinds == { "clientClaim", "solverRefund" }   \* the ARKADE lockup

L1Spends     == { "solverClaim", "clientRefund" }   \* the L1 HTLC outpoint

(***************************************************************************)
(* THE EDGE TABLE.  Diff this against                                      *)
(* src/db/onchainReceiveSwaps.ts:64-75.                                    *)
(***************************************************************************)
Row   == { "quoted", "awaiting_confirmations", "funding_arkade",
           "awaiting_claim", "claimed", "settled", "refunding_arkade",
           "refunded", "refused", "stuck" }
AllSt == Row \cup { "none", "rejected" }   \* the two spec-only pre-row markers

Edges == [ x \in AllSt |->
    CASE x = "none"     -> { "quoted", "rejected" }  \* SPEC ONLY: quote() inserts or refuses
      [] x = "rejected" -> { }                       \* SPEC ONLY: no row was ever created
      [] x = "quoted"                 -> { "awaiting_confirmations", "refused" }
      [] x = "awaiting_confirmations" -> { "funding_arkade", "refused" }
      [] x = "funding_arkade"         -> { "awaiting_claim", "stuck" }
      [] x = "awaiting_claim"         -> { "claimed", "refunding_arkade", "stuck" }
      [] x = "claimed"                -> { "settled", "stuck" }
      [] x = "refunding_arkade"       -> { "claimed", "refunded", "stuck" }
      [] x = "settled"                -> { }
      [] x = "refunded"               -> { }
      [] x = "refused"                -> { }
      [] x = "stuck"                  -> { } ]

(***************************************************************************)
(* THREE EDGES OF THE TABLE HAVE NO ACTION IN THIS MODULE, AND THAT IS     *)
(* DELIBERATE — each is documented in the TypeScript as unreachable by     *)
(* construction, guarded only so a bad edit fails loudly:                   *)
(*                                                                         *)
(*   funding_arkade -> stuck    no fail() call site exists in this state    *)
(*   awaiting_claim -> stuck    the missing-nonInteractiveClaim-leaf branch *)
(*                              (:646-652); quote() always builds it        *)
(*   awaiting_confirmations -> refused via the "no funding txid/vout"       *)
(*                              branch (:506-509); the CAS at :456-459      *)
(*                              writes both columns in the same UPDATE      *)
(*                                                                         *)
(* ForwardOnly only constrains steps that are TAKEN, so an unmodelled edge *)
(* costs nothing; leaving them in the table is what makes it diffable.     *)
(***************************************************************************)

NonTerminal == { "quoted", "awaiting_confirmations", "funding_arkade",
                 "awaiting_claim", "claimed", "refunding_arkade" }
Exposed     == { "funding_arkade", "awaiting_claim", "claimed", "refunding_arkade" }
Terminal    == { "settled", "refunded", "refused", "stuck", "rejected" }
Drivable    == NonTerminal \cup { "none" }   \* findRecoverable(), plus quote()

--------------------------------------------------------------------------
(***************************************************************************)
(* THE WORLD, AS THE SOLVER MAY OBSERVE IT                                 *)
(***************************************************************************)

\* The client's L1 HTLC output exists (mempool or chain).  findOutputs sees it
\* at any depth; whenQuoted adopts it at depth 0 on purpose, because nothing
\* of the solver's own is at risk until awaiting_confirmations resolves.
L1Exists(s)    == htlc[s] \in { "seen", "confirmed" }

\* (output?.confirmations ?? 0) >= row.minConfirmations, :512.
\* THE MUTATION reproduces minConfirmations = 0 exactly: with `?? 0 >= 0` a
\* MISSING output passes too, not merely a shallow one.
HtlcDeepEnough(s) == BreakConfirmations \/ htlc[s] = "confirmed"

\* arkade.findLockups(row.pkScript) is getVtxos({spendableOnly: TRUE}), so it
\* empties the INSTANT any spend of the lockup lands.
ArkLockupSpendable(s) == arkFund[s] >= 1 /\ conf[s] = {}

\* whenFundingArkade's alreadyFunded read, :551-552.  Because findLockups is
\* spendableOnly it cannot tell "never funded" from "funded and already
\* claimed" — the crash-then-claim hole.  The corridor already owns the reads
\* that close it (findLockupOutpoints, unfiltered, is on the same ops
\* interface two methods away; lockupProvablySpent is used by BOTH send legs
\* and is deliberately absent from OnchainReceiveArkadeOps' Pick list,
\* src/receive/onchainArkadeOps.ts:28-38).
\*
\* LockupProvablySpent = FALSE IS THE SHIPPED CODE and is what every cfg in
\* this directory sets.  TRUE is the counterfactual in which the Go rewrite
\* uses the unfiltered read.  Two things turn on it, and only one is money:
\*   MONEY     with FundIsIdempotent = FALSE (also today's code, (A1)) the
\*             FALSE branch is a SECOND, independent double-fund: a claim
\*             lands while the row is in `funding_arkade`, the next tick reads
\*             the lockup empty, and arkade.fund sends again.  Distinct from
\*             the two-concurrent-readers race, and reachable with ONE worker.
\*   FAIRNESS  it is why SubmitArkFund can re-enable for ever, which is why
\*             PushSubmit and PushRecord must be separate SF groups.  See the
\*             fairness note below.
AlreadyFunded(s) ==
    \/ (IF LockupProvablySpent THEN arkFund[s] >= 1 ELSE ArkLockupSpendable(s))
    \/ arkFund[s] >= 2      \* model counter cap; NoDoublePay has already failed

\* findClaimPreimage returns P only if a claim spend exists AND the indexer can
\* already produce the spending virtual transaction.  It NEVER invents one: a
\* readable claim is always a real, hash-verified claim.
ClaimReadable(s)  == SpentBy(s, "clientClaim")
ClaimReadsNull(s) == ~ClaimReadable(s) \/ ~IndexerNeverLies

\* onchain.findSpendWitness (src/receive/onchainOrchestrator.ts:704-708), plus
\* any broadcast/mempool sighting — Esplora reports a mempool spend as spent,
\* which is why `bcast` and not only `l1` counts here.  WitnessSeen itself
\* stays truthiness-only, for the urgency arms and guards that care merely
\* WHETHER some spend exists; the discriminator lives in the KIND-specific
\* predicates below, the model's rendering of whenClaimed's ourClaim match
\* (src/receive/onchainOrchestrator.ts:725-727) — a spend through the claim
\* leaf is the only one that carries the row's preimage, and on this leg the
\* claim path is the solver's own.  (#176 shipped the discriminator in the
\* code; #232 adds it here.)
WitnessSeen(s)       == (bcast[s] \cup l1[s]) # {}
OwnClaimSeen(s)      == "solverClaim"  \in (bcast[s] \cup l1[s])
ClientRefundSeen(s)  == "clientRefund" \in (bcast[s] \cup l1[s])

--------------------------------------------------------------------------
(***************************************************************************)
(* MONEY.  These two predicates are the seam SwapCore's NoSilentLossShape  *)
(* is instantiated with.                                                   *)
(***************************************************************************)

\* The solver's own Arkade float has irreversibly left its wallet.
PaidOut(s) == arkFund[s] >= 1

\* The solver's own L1 sweep confirmed.
L1Swept(s) == "solverClaim" \in l1[s]

\* The sweep is broadcast, unopposed, and the outpoint it spends still exists.
\* In THIS MODEL that is irreversible: ConfirmL1 can only pick a member of
\* `bcast`, and nothing else is in it.  In reality it is not — the claim tx is
\* RBF-signalling (src/onchain/claim.ts:44) and `settled` is terminal, so a
\* claim that never confirms is a loss the state machine cannot express.  That
\* residual is what (A3) MempoolExclusive = FALSE explores.
L1SweepUnopposed(s) ==
    /\ "solverClaim" \in bcast[s]
    /\ "clientRefund" \notin bcast[s]
    /\ l1[s] = {}
    /\ L1Exists(s)

\* The solver pulled its own lockup back.  Arkade arbitration is atomic, so
\* there is no broadcast/confirm gap on this side.
ArkRefunded(s) == SpentBy(s, "solverRefund")

Collected(s) == L1Swept(s) \/ L1SweepUnopposed(s) \/ ArkRefunded(s)

\* The client took the solver's Arkade float.
ClientTookLockup(s) == SpentBy(s, "clientClaim")

\* The solver's only recourse is gone: either the client refunded the L1 HTLC
\* past htlc_locktime, or a reorg evicted the funding the solver paid against.
ClientTookL1(s) == "clientRefund" \in l1[s]
L1Gone(s)       == ~L1Exists(s) \/ ClientTookL1(s)

--------------------------------------------------------------------------
(***************************************************************************)
(* GUARDS.  Evaluated on the CURRENT clock against the worker's SNAPSHOT   *)
(* of the row, which is what the orchestrator does: every gate is          *)
(* re-evaluated on every tick, never once at quote time.                   *)
(***************************************************************************)

\* evaluateOnchainReceiveFunding, src/core/onchainReceive.ts:134-153.
\* `now >= arkadeRefundLocktime - MIN_ARKADE_FUND_WINDOW` refuses; written as
\* addition so Naturals never goes negative.
\*
\* THE SAME PREDICATE gates creating the exposure (:514-521) and unwinding it
\* (:665-672).  Consequence the spec makes visible: the solver starts refunding
\* MIN_ARKADE_FUND_WINDOW before its own refund path is even open, so
\* `refunding_arkade` is normally entered long before the CLTV matures and
\* sits there retrying.
FundGateOpen == clock + MinArkFundWindow < RefundLocktime

\* whenQuoted's deadline, :453.
LockupTimedOut == clock >= LockupDeadline

\* The covenant refund's absolute CLTV matures against the CHAIN TIP's
\* timestamp, not wall clock (src/arkade/wallet.ts:572-575, :691-697).  Before
\* it does, the Arkade server rejects with FORFEIT_CLOSURE_LOCKED — which in
\* the TypeScript is a THROW out of tick(), leaving the row exactly where it
\* was for the next sweep.  Modelled as the action simply being disabled.
ArkRefundPushable(s) ==
    /\ ArkLockupSpendable(s)
    /\ serverUp
    /\ chainTime >= RefundLocktime

--------------------------------------------------------------------------
(***************************************************************************)
(* ENVIRONMENT.  An adversary within physical limits.                      *)
(***************************************************************************)

\* The client broadcasts their own L1 HTLC funding.  Depth 0.  Only possible
\* once a row exists, because the HTLC address is derived by the solver and
\* handed back by quote() — and quote() returns it only after insertQuote
\* commits.  Funding LATE (after the row has already been refused) is left
\* legal on purpose: it is exactly the case the lockup deadline creates.
ClientFundsHtlc(s) ==
    /\ htlc[s] = "none"
    /\ st[s] \notin { "none", "rejected" }
    /\ htlc' = [htlc EXCEPT ![s] = "seen"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, arkFund, bcast, l1, refEmptySeen >>

\* A block buries it to min_confirmations.  Modelled as one step because
\* MinConfirmations is the only depth the code ever compares against.
ConfirmHtlcFunding(s) ==
    /\ htlc[s] = "seen"
    /\ htlc' = [htlc EXCEPT ![s] = "confirmed"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, arkFund, bcast, l1, refEmptySeen >>

\* A REORG EVICTS THE CLIENT'S FUNDING.  Only reachable while the output has
\* not reached min_confirmations — which is the ENTIRE reorg policy of this
\* corridor, checked once at :512 and never re-validated after the solver has
\* paid out.  Any spend broadcast against the evicted outpoint dies with it.
ReorgHtlcFunding(s) ==
    /\ htlc[s] = "seen"
    /\ l1[s] = {}
    /\ htlc'  = [htlc  EXCEPT ![s] = "gone"]
    /\ bcast' = [bcast EXCEPT ![s] = {}]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, arkFund, l1, refEmptySeen >>

\* THE ADVERSARIAL SPEND ON THE ARKADE SIDE, AND THE REASON
\* refunding_arkade -> claimed EXISTS.  Neither claim leaf carries a timelock:
\* the collaborative `claim` leaf (P + receiver + server) the CLIENT holds and
\* the `nonInteractiveClaim` leaf (server + emulator, pinned by ArkadeScript to
\* clientPayoutPkScript) covclaimd pushes are BOTH spendable from the instant
\* the lockup is funded and remain spendable forever — including after the
\* solver has decided to refund, and up to the moment the refund executes.
\* There is NO clock condition here on purpose.  Both leaves need the Arkade
\* server, which is why a censoring server freezes this too.
ClientClaimsLockup(s) ==
    /\ arkFund[s] >= 1
    /\ serverUp
    /\ SpendAccepted(s, "clientClaim")
    /\ UNCHANGED << clock, st, loc, serverUp >>
    /\ UNCHANGED OrVars

\* The client's own L1 refund leaf opens at htlc_locktime, against MTP.
ClientRefundsL1(s) ==
    /\ L1Exists(s)
    /\ l1[s] = {}
    /\ "clientRefund" \notin bcast[s]
    /\ chainTime >= HtlcLocktime
    /\ (MempoolExclusive => "solverClaim" \notin bcast[s])
    /\ bcast' = [bcast EXCEPT ![s] = bcast[s] \cup { "clientRefund" }]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, htlc, arkFund, l1, refEmptySeen >>

\* A miner picks ONE of the broadcast spends of the L1 outpoint.  Bitcoin
\* consensus permits exactly one; the conflicting transaction is evicted.
\* This is the only place `l1` is written, which is what makes the L1 half of
\* AtMostOneOutcome an inevitability rather than a hope.
ConfirmL1(s) ==
    /\ L1Exists(s)
    /\ l1[s] = {}
    /\ \E k \in bcast[s] :
          /\ (k = "clientRefund" => chainTime >= HtlcLocktime)
          /\ l1'    = [l1    EXCEPT ![s] = { k }]
          /\ bcast' = [bcast EXCEPT ![s] = { k }]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, htlc, arkFund, refEmptySeen >>

Censor == CensorCore /\ UNCHANGED OrVars

\* (A2): the clock does not advance while the solver has a step it could
\* finish right now on this swap.
Urgent(s) ==
    \/ st[s] = "none"                                         \* admission settles at clock 0
    \/ (st[s] = "quoted" /\ L1Exists(s))                      \* adopt the funding output
    \/ (st[s] = "awaiting_confirmations" /\ HtlcDeepEnough(s) /\ FundGateOpen)
    \/ (st[s] = "awaiting_confirmations" /\ ~FundGateOpen)     \* refuse now
    \/ st[s] = "funding_arkade"                                \* adopt or fund, always
    \/ (st[s] = "awaiting_claim" /\ ClaimReadable(s))          \* P is readable, take it
    \/ (st[s] = "awaiting_claim" /\ ~FundGateOpen)             \* unwind now
    \/ (st[s] = "refunding_arkade" /\ ClaimReadable(s))        \* the back-edge
    \/ (st[s] = "refunding_arkade" /\ ArkRefundPushable(s))    \* the refund can go out
    \/ (st[s] = "refunding_arkade" /\ ~ArkLockupSpendable(s))  \* empty read, judge it
    \/ (st[s] = "claimed" /\ ~WitnessSeen(s))                  \* SWEEP L1 NOW
    \/ (st[s] = "claimed" /\ WitnessSeen(s))                   \* record the verdict

SolverBehind == \E s \in Swaps : Urgent(s)

\* Wall clock.  Refuses to outrun the chain tip's clock by more than MtpLag,
\* which is how the lag bound is realised without a second fairness condition.
Tick ==
    /\ TickCore
    /\ ~SolverBehind
    /\ clock + 1 <= chainTime + MtpLag
    /\ UNCHANGED OrVars

\* The chain tip's clock catches up.  Monotone and never ahead of wall clock.
\* Both the L1 nLockTime and the Arkade covenant CLTV mature against this.
ChainTick ==
    /\ chainTime < clock
    /\ chainTime' = chainTime + 1
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << htlc, arkFund, bcast, l1, refEmptySeen >>

--------------------------------------------------------------------------
(***************************************************************************)
(* WORKER ACTIONS.  One named operator per orchestrator function, so the   *)
(* Go rewrite can be diffed against them one for one.                      *)
(***************************************************************************)

\* store.get(id) / findRecoverable(), and — in the same breath — whatever
\* else the handler samples before it decides:
\*   quote()             `admission.reserve` (deps.totalCommitted) (:288)
\*   whenFundingArkade   `await arkade.findLockups(row.pkScript)` (:551)
\* ALWAYS a separate step from the write that follows, which is the whole
\* point: every await in the TypeScript yields the event loop, and every
\* goroutine boundary in Go yields the scheduler.  Sampling findLockups HERE
\* rather than inside SubmitArkFund is what exposes the double-fund race —
\* two workers may both read "empty" and both then send.
ReadSwap(w, s) ==
    /\ ReadRowWith(w, s, Drivable,
           CASE st[s] = "none" ->
                    IF Exposure(NonTerminal) + Amount <= MaxExposed
                      THEN "capOk" ELSE "capFull"
             [] st[s] = "funding_arkade" ->
                    IF AlreadyFunded(s) THEN "funded" ELSE "empty"
             [] OTHER -> "none")
    /\ UNCHANGED OrVars

\* step() returned false with nothing to do, or the CAS was lost silently, or
\* an indexer read simply had not caught up yet.
GiveUp(w) ==
    /\ loc[w].phase = "read"
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED OrVars

Crash(w) == CrashCore(w) /\ UNCHANGED OrVars

(***** quote() : src/receive/onchainOrchestrator.ts:222-370 ****************)

\* insertQuote().  The partial UNIQUE index on payment_hash makes the INSERT
\* itself single-winner, which is modelled by the CAS on "none".  There is NO
\* equivalent backstop for the exposure cap: with AtomicAdmission = FALSE the
\* insert trusts the admission.reserve lease taken earlier, which is today's
\* TypeScript (:288, in-process only).  With TRUE the cap is re-checked by the write that
\* consumes it, which is what a Go handler pool requires.
InsertQuote(w, s) ==
    /\ Saw(w, s, "none")
    /\ loc[w].res \in { "capOk", "capFull" }
    /\ \/ /\ st[s] = "none"
          /\ IF /\ loc[w].res = "capOk"
                /\ ( ~AtomicAdmission
                     \/ Exposure(NonTerminal) + Amount <= MaxExposed )
               THEN st' = [st EXCEPT ![s] = "quoted"]
               ELSE st' = [st EXCEPT ![s] = "rejected"]
       \/ /\ st[s] # "none"
          /\ UNCHANGED st
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

(***** whenQuoted : :449-490 ***********************************************)

\* An output of EXACTLY amount_sats is at the client's HTLC address.  Adopted
\* at ANY depth — funding_txid and funding_vout are written in the same UPDATE
\* as the state change, so the pair can never be torn.  A match wins even on
\* the tick the deadline expires (the code tests `match` first).
SeeHtlcFunding(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ L1Exists(s)
    /\ \/ CasWon(s, "quoted", "awaiting_confirmations")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* Nothing arrived by created_at + DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT.
\* Pre-exposure, so `refused` is the right terminal and this leg needs no
\* refund sweep for it (src/db/onchainReceiveSwaps.ts:591-606).
RefuseQuoted(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ ~L1Exists(s)
    /\ LockupTimedOut
    /\ \/ CasWon(s, "quoted", "refused")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

(***** whenAwaitingConfirmations : :504-533 ********************************)

\* THE INTENT COMMIT, and the one thing this corridor gets structurally right
\* that the Lightning receive leg does not: the CAS into an EXPOSED state runs
\* BEFORE the irreversible arkade.fund (:532 then :594).  What it does NOT
\* buy is exclusivity — the row stays in `funding_arkade` for the whole
\* duration of the send, and every worker that reads it there will send again.
\* See SubmitArkFund.
FundGate(w, s) ==
    /\ Saw(w, s, "awaiting_confirmations")
    /\ HtlcDeepEnough(s)
    /\ FundGateOpen
    /\ \/ CasWon(s, "awaiting_confirmations", "funding_arkade")
       \/ CasLost(s, "awaiting_confirmations")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* The headroom is gone.  Collapses the code's two refusal branches — "not
\* confirmed and out of time" and "confirmed but out of time" — because they
\* differ only in failure_reason.  Nothing of the solver's own is at risk in
\* this state either way, which is exactly why failing here is always safe.
RefuseAwaiting(w, s) ==
    /\ Saw(w, s, "awaiting_confirmations")
    /\ ~FundGateOpen
    /\ \/ CasWon(s, "awaiting_confirmations", "refused")
       \/ CasLost(s, "awaiting_confirmations")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

(***** whenFundingArkade : :547-604 ****************************************)

\* Crash recovery: this swap's own (unique) script already holds the money, so
\* transition without funding again.  Asking the world what landed, instead of
\* persisting a "did we already call fund" flag, is sound against a CRASH —
\* nothing else is running — and unsound against CONCURRENCY, because another
\* worker may be mid-send.  See SubmitArkFund.
AdoptFunding(w, s) ==
    /\ Saw(w, s, "funding_arkade")
    /\ loc[w].res = "funded"
    /\ \/ CasWon(s, "funding_arkade", "awaiting_claim")
       \/ CasLost(s, "funding_arkade")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* THE IRREVERSIBLE ACT OF THIS CORRIDOR: the solver's own float leaves.
\* arkade.fund -> fundLockup -> wallet.sendBitcoin, with NO idempotency key of
\* any kind — the orchestrator says so itself at :538-545.  It happens BEFORE
\* the CAS that records it, and — critically — the enabling condition is a
\* READ taken in an earlier step, so TWO workers can both hold res = "empty"
\* and both send.  In TypeScript the only thing preventing that is the
\* in-process `inFlight` Set (:193, :374-383) plus cli.ts's single sequential
\* watch loop.  The CAS below decides who RECORDS the outpoint, never who
\* PAYS.  (A1) FundIsIdempotent is the assumption a Go rewrite must supply,
\* by a durable per-swap lease or a client-side key the wallet honours.
SubmitArkFund(w, s) ==
    /\ Saw(w, s, "funding_arkade")
    /\ loc[w].res = "empty"
    /\ \/ \* the wallet recognises the swap key and returns the existing funding
          /\ FundIsIdempotent
          /\ arkFund[s] >= 1
          /\ UNCHANGED arkFund
       \/ \* a real send.  If one already existed and the wallet did not
          \* dedup, this is the second one: arkFund reaches 2.
          /\ ~(FundIsIdempotent /\ arkFund[s] >= 1)
          /\ arkFund[s] < 2
          /\ arkFund' = [arkFund EXCEPT ![s] = arkFund[s] + 1]
       \/ \* model counter cap; NoDoublePay has already failed by here and the
          \* branch exists only so the action never becomes disabled and fakes
          \* a livelock.
          /\ arkFund[s] >= 2
          /\ UNCHANGED arkFund
    /\ Advance(w, "fundCalled", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << chainTime, htlc, bcast, l1, refEmptySeen >>

\* arkade_fund_txid and the state change land together.  A crash between the
\* send and here leaves the row in `funding_arkade` with the float already
\* out — recovered by AdoptFunding, unless a claim has meanwhile emptied the
\* spendableOnly view (see AlreadyFunded).
RecordFunding(w, s) ==
    /\ At(w, s, "fundCalled")
    /\ \/ CasWon(s, "funding_arkade", "awaiting_claim")
       \/ CasLost(s, "funding_arkade")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

(***** whenAwaitingClaim : :626-677 ****************************************)

\* Somebody spent the lockup with a witness that hash-verifies against
\* payment_hash.  WHO is not this method's business (:610-615) — the client's
\* collaborative claim and covclaimd's nonInteractiveClaim reveal the same P.
\* Checked BEFORE the reveal re-push and BEFORE the deadline backstop, so an
\* observable claim always beats a refund decision on the same tick.
\*
\* P is written in the SAME UPDATE, which is what makes `claimed` need nothing
\* external any more: no counterparty, no covclaimd, no Arkade server, only
\* the solver's own signer and a broadcast.
SeeArkadeClaim(w, s) ==
    /\ Saw(w, s, "awaiting_claim")
    /\ ClaimReadable(s)
    /\ \/ CasWon(s, "awaiting_claim", "claimed")
       \/ CasLost(s, "awaiting_claim")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* The deadline backstop, :661-675.  Reuses evaluateOnchainReceiveFunding —
\* the SAME predicate that gated creating the exposure — so the solver starts
\* unwinding MIN_ARKADE_FUND_WINDOW before its own refund path opens.
\* Requires the preimage read to have returned null, because the code checks
\* that first and returns on it.
ArmRefund(w, s) ==
    /\ Saw(w, s, "awaiting_claim")
    /\ ClaimReadsNull(s)
    /\ ~FundGateOpen
    /\ \/ CasWon(s, "awaiting_claim", "refunding_arkade")
       \/ CasLost(s, "awaiting_claim")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

(***** whenClaimed : :694-792 — THE SHARPEST WINDOW IN THE SYSTEM *********)

\* The outpoint is already spent by the CLIENT'S REFUND: htlc_locktime has
\* passed and the client pulled its L1 HTLC back before the solver claimed
\* it.  whenClaimed's fail() branch, src/receive/onchainOrchestrator.ts:736-740.
\* `stuck` has no outgoing edge; the reason string names the client, and —
\* unlike the pre-#176 code — that attribution is CORRECT, because the
\* own-claim flavour is handled first.  The ~OwnClaimSeen conjunct is that
\* precedence: shipped code checks `if (ourClaim)` before anything else.
ClaimSeesPriorSpend(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ ClientRefundSeen(s)
    /\ ~OwnClaimSeen(s)
    /\ \/ CasWon(s, "claimed", "stuck")
       \/ CasLost(s, "claimed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* The solver's OWN claim sits at the outpoint: SubmitL1Claim broadcast it
\* and the process died before RecordSettled's CAS, so the row still reads
\* `claimed`.  whenClaimed's ourClaim branch, :725-734: the witness carries
\* the row's preimage, which only the claim leaf reveals, so the swap is
\* recovered as `settled` — with onchain_claim_txid honestly left null, as
\* the shipped comment argues (:729-733; the spec has no txid column to
\* model).  Before #176 this read as a false-negative `stuck`; the pre-#176
\* truthiness-only behaviour is what ClaimSeesPriorSpend modelled until the
\* discriminator was added here (#232).
ClaimSeesOwnClaim(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ OwnClaimSeen(s)
    /\ \/ CasWon(s, "claimed", "settled")
       \/ CasLost(s, "claimed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* The fee at the current rate leaves less than ONCHAIN_DUST_SATS, :771-786.
\* Refusing to build a non-standard transaction is right; parking a swap where
\* the solver HAS ALREADY PAID OUT in a terminal state with no operator retry
\* command is the part (A5) makes visible.
ClaimDust(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ ~ClaimFeeAffordable
    /\ ~WitnessSeen(s)
    /\ \/ CasWon(s, "claimed", "stuck")
       \/ CasLost(s, "claimed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* IRREVERSIBLE, AND IT HAPPENS BEFORE THE CAS.  signOnchainClaimTx then
\* onchain.broadcastRaw.  NOTE what is deliberately NOT a guard here: there is
\* no `now < htlc_locktime` check, and correctly so — the claim leaf carries
\* no CLTV, so racing the client's refund is the right behaviour.  Requires
\* the outpoint to exist: after a reorg broadcastRaw throws forever and the
\* row parks in `claimed`, which is a condition no state or edge names.
SubmitL1Claim(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ ~WitnessSeen(s)
    /\ L1Exists(s)
    /\ bcast' = [bcast EXCEPT ![s] = bcast[s] \cup { "solverClaim" }]
    /\ Advance(w, "claimSent", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << chainTime, htlc, arkFund, l1, refEmptySeen >>

\* onchain_claim_txid and the state change land together.  `settled` records a
\* BROADCAST, not a confirmation, and is terminal — findRecoverable never
\* revisits it.
RecordSettled(w, s) ==
    /\ At(w, s, "claimSent")
    /\ \/ CasWon(s, "claimed", "settled")
       \/ CasLost(s, "claimed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

(***** whenRefundingArkade : :885-935 **************************************)

\* THE BACK-EDGE, AND THE REASON THIS CORRIDOR IS WORTH SPECIFYING.  The
\* solver decided to refund and the counterparty's claim landed instead.
\* Re-read on EVERY tick and BEFORE any refund is pushed (:892-896), because
\* the refund and the claim are competing spends of the same VTXO and the
\* claim can land right up until the refund executes.  Losing that race is not
\* a loss: the solver now has P and can still sweep the L1 HTLC — which is the
\* whole reason SETTLE_SAFETY_MARGIN keeps refund_locktime before
\* htlc_locktime.  If the claim lands after the recheck and before the refund
\* is accepted, arkade.refund throws, the throw propagates out of tick, the
\* row stays in `refunding_arkade` (no CAS ran), and the next tick's recheck
\* is what recovers it — modelled by SubmitArkRefund simply being disabled
\* once conf # {}.
RefundSeesClaim(w, s) ==
    /\ Saw(w, s, "refunding_arkade")
    /\ ClaimReadable(s)
    /\ \/ CasWon(s, "refunding_arkade", "claimed")
       \/ CasLost(s, "refunding_arkade")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* IRREVERSIBLE, AND IT HAPPENS BEFORE THE CAS.  The Arkade server co-signs
\* exactly one spend of the VTXO, so a concurrent double refund is harmless:
\* SpendAccepted requires conf = {} and the loser is simply rejected.  That is
\* the structural contrast with SubmitArkFund, where two concurrent calls pick
\* DIFFERENT coins and both succeed.  Same before-CAS shape, opposite outcome,
\* and the difference is whether the side effect is idempotent-by-conflict.
SubmitArkRefund(w, s) ==
    /\ Saw(w, s, "refunding_arkade")
    /\ ClaimReadsNull(s)
    /\ ArkRefundPushable(s)
    /\ SpendAccepted(s, "solverRefund")
    /\ Advance(w, "refundSent", "none")
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED OrVars

\* arkade_refund_txid and the state change land together.  A crash between the
\* two leaves an already-refunded swap looking exactly like the inexplicable
\* case, and RefundSeesEmpty then books it `stuck`.
RecordRefunded(w, s) ==
    /\ At(w, s, "refundSent")
    /\ \/ CasWon(s, "refunding_arkade", "refunded")
       \/ CasLost(s, "refunding_arkade")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OrVars

\* Nothing provably claimed it and nothing is left to refund.  EMPTY_LOCKUP_
\* GRACE, :898-917: this may not be judged on ONE look, because findLockups
\* (spendableOnly) empties the instant a claim lands while findClaimPreimage
\* still has to fetch the spending transaction.  The 120-second timer is
\* abstracted to "a second observation", which is exactly the property the
\* code's own comment argues for; modelling the wall-clock value would only
\* add clock states, since the ambiguity it covers either resolves within one
\* read (a claim) or never (our own crashed refund).
RefundSeesEmpty(w, s) ==
    /\ Saw(w, s, "refunding_arkade")
    /\ ~ArkLockupSpendable(s)
    /\ ClaimReadsNull(s)
    /\ IF refEmptySeen[s]
         THEN /\ \/ CasWon(s, "refunding_arkade", "stuck")
                 \/ CasLost(s, "refunding_arkade")
              /\ UNCHANGED refEmptySeen
         ELSE /\ UNCHANGED st
              /\ refEmptySeen' = [refEmptySeen EXCEPT ![s] = TRUE]
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << chainTime, htlc, arkFund, bcast, l1 >>

--------------------------------------------------------------------------
(***************************************************************************)
(* THE NEXT-STATE RELATION                                                 *)
(***************************************************************************)

(***************************************************************************)
(* FAIRNESS GROUPS.                                                        *)
(*                                                                         *)
(* SF on a group is equivalent to SF on each member ONLY IF no member can  *)
(* be taken infinitely often WITHOUT the swap advancing (SwapCore T2).     *)
(*                                                                         *)
(* DriveRow: every member ends in a compare-and-swap and parks.  The one    *)
(*   member that can be a no-op is RefundSeesEmpty's FIRST observation —    *)
(*   and it can fire at most once per swap, because refEmptySeen is         *)
(*   monotone and the second firing CASes to `stuck`.                       *)
(*                                                                         *)
(* PushSubmit / PushRecord: the six actions that live at a worker phase     *)
(*   rather than at a row read — the three irreversible submissions and the *)
(*   three CASes that record them.  THEY ARE IN SEPARATE GROUPS, for the    *)
(*   same reason LightningSend keeps SubmitPay and RecordPay apart, and an  *)
(*   earlier revision of this module got it wrong.  The bad argument was:   *)
(*   "SubmitArkFund needs res = 'empty', and after the first send every     *)
(*   fresh read of the row yields 'funded', so it can fire at most once per *)
(*   swap."  That holds only under LockupProvablySpent = TRUE.  The SHIPPED *)
(*   read is arkade.findLockups, which is spendableOnly (:551), so once the *)
(*   client's claim lands the lockup reads EMPTY again and SubmitArkFund    *)
(*   re-enables for ever.  Merged, SF on the group is then discharged by    *)
(*   re-submitting a fund that never advances the row — exactly the trap    *)
(*   SwapCore T2 names — and TLC reports a liveness counterexample whose    *)
(*   cycle is ReadSwap / SubmitArkFund / Crash with RecordFunding starved.  *)
(*   Verified: merged + LockupProvablySpent = FALSE violates Liveness in    *)
(*   68 s; safety alone is unaffected (408,650 distinct states, no error).  *)
(*                                                                         *)
(*   Split, PushRecord's own SF discharges RecordFunding, which is enabled  *)
(*   infinitely often along that cycle, and the model is green with the     *)
(*   SHIPPED read.  The cost is one more fairness condition (12 total),     *)
(*   comfortably under TLC's ceiling (SwapCore T3): 16 conditions on this   *)
(*   state space did not finish its liveness tableau in 15 minutes, 12      *)
(*   finish in about eight.                                                 *)
(***************************************************************************)
DriveRow(w, s) ==
    \/ InsertQuote(w, s)
    \/ SeeHtlcFunding(w, s)      \/ RefuseQuoted(w, s)
    \/ FundGate(w, s)            \/ RefuseAwaiting(w, s)
    \/ AdoptFunding(w, s)
    \/ SeeArkadeClaim(w, s)      \/ ArmRefund(w, s)
    \/ ClaimSeesPriorSpend(w, s) \/ ClaimSeesOwnClaim(w, s)
    \/ ClaimDust(w, s)
    \/ RefundSeesClaim(w, s)     \/ RefundSeesEmpty(w, s)

\* The three irreversible submissions.  SubmitArkFund can re-enable without
\* the row advancing (see the fairness note above), so this group must not be
\* merged with the CASes that record it.
PushSubmit(w, s) ==
    \/ SubmitArkFund(w, s)
    \/ SubmitL1Claim(w, s)
    \/ SubmitArkRefund(w, s)

\* The three CASes that record them.  Each ends in a compare-and-swap and parks.
PushRecord(w, s) ==
    \/ RecordFunding(w, s)
    \/ RecordSettled(w, s)
    \/ RecordRefunded(w, s)

PushSideEffect(w, s) == PushSubmit(w, s) \/ PushRecord(w, s)

\* Everything a worker can do to swap s other than reading it or giving up.
Progress(w, s) == DriveRow(w, s) \/ PushSideEffect(w, s)

Environment(s) ==
    \/ ClientFundsHtlc(s)    \/ ConfirmHtlcFunding(s) \/ ReorgHtlcFunding(s)
    \/ ClientClaimsLockup(s) \/ ClientRefundsL1(s)    \/ ConfirmL1(s)

Next ==
    \/ \E w \in Workers :
          \/ \E s \in Swaps : ReadSwap(w, s) \/ Progress(w, s)
          \/ GiveUp(w)
          \/ Crash(w)
    \/ \E s \in Swaps : Environment(s)
    \/ Censor
    \/ Tick
    \/ ChainTick

Init ==
    /\ InitCore("none")
    /\ chainTime    = 0
    /\ htlc         = [s \in Swaps |-> "none"]
    /\ arkFund      = [s \in Swaps |-> 0]
    /\ bcast        = [s \in Swaps |-> {}]
    /\ l1           = [s \in Swaps |-> {}]
    /\ refEmptySeen = [s \in Swaps |-> FALSE]

(***************************************************************************)
(* FAIRNESS.  Strong fairness per (swap, action group): a worker that      *)
(* repeatedly reads a row and finds an applicable step must eventually     *)
(* take it.  Weak fairness would be satisfied by an endless read/give-up   *)
(* loop.  Crash, Censor and every Environment action are deliberately      *)
(* UNFAIR — the environment owes us nothing, the client need never claim,  *)
(* and a broadcast need never be mined.                                    *)
(*                                                                         *)
(* SwapCore's traps T1 (never write a conjunction inside a quantifier      *)
(* body), T3 (TLC's ceiling on temporal actions) and T4 (symmetry is       *)
(* unsound with per-swap fairness) all apply; this is the same shape       *)
(* LightningSend uses.  ConfirmL1 deliberately carries NO fairness: a      *)
(* broadcast that never confirms must not be assumed away, and no row      *)
(* needs it to reach a terminal state.                                     *)
(***************************************************************************)
Fairness ==
    /\ \A w \in Workers : WF_vars(GiveUp(w))
    /\ WF_vars(Tick)
    /\ WF_vars(ChainTick)
    \* "some worker eventually does this for this swap".  The \E is over
    \* WORKERS, never over swaps: swaps must each be driven, workers are
    \* interchangeable.
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ReadSwap(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : DriveRow(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : PushSubmit(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : PushRecord(w, s))

Spec == Init /\ [][Next]_vars /\ Fairness

--------------------------------------------------------------------------
(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypeOK ==
    /\ TypeOKCore(AllSt)
    /\ chainTime    \in 0..MaxClock
    /\ htlc         \in [Swaps -> { "none", "seen", "confirmed", "gone" }]
    /\ arkFund      \in [Swaps -> 0..2]
    /\ bcast        \in [Swaps -> SUBSET L1Spends]
    /\ l1           \in [Swaps -> SUBSET L1Spends]
    /\ refEmptySeen \in [Swaps -> BOOLEAN]

\* Every state change is an edge of LEGAL_EDGES.  An ACTION property.
ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars

\* The irreversible outbound side effect — the solver's own Arkade float
\* leaving its wallet — happens at most once per swap.  NOT guaranteed by the
\* compare-and-swap: the row sits in `funding_arkade` for the whole duration
\* of the send and every worker that reads it there sends again.  See (A1).
\* The L1 claim broadcast is deliberately NOT counted here: it is an INFLOW,
\* and two broadcasts of the same outpoint are a double-spend consensus
\* settles for free.
NoDoublePay == \A s \in Swaps : arkFund[s] <= 1

\* Each contested output has at most one winner.  The Arkade lockup is
\* arbitrated by the Arkade server (SwapCore's `conf`), the L1 HTLC outpoint
\* by a miner (`l1`), and the two are independent.
AtMostOneOutcome ==
    /\ AtMostOneOutcomeInv
    /\ \A s \in Swaps : Cardinality(l1[s]) <= 1

ExposureBounded == ExposureBoundedBy(NonTerminal)

\* THE money invariant: if the solver's float has irreversibly left, it has
\* not been made whole, and the machine has stopped, then a human is being
\* paged.  Anything else is a silent loss.
NoSilentLoss == NoSilentLossShape(PaidOut, Collected, Terminal, "stuck")

\* THE loss the deadline ordering exists to prevent: the client took the
\* solver's Arkade float AND the solver's only recourse — the single L1
\* outpoint the client funded — is gone, either refunded by the client past
\* htlc_locktime or reorged out from under a payout the solver made against
\* it.  Both legs of the swap in the client's hands.  This is the invariant
\* the mandated mutation breaks.
NoNetLoss == \A s \in Swaps : ~(ClientTookLockup(s) /\ L1Gone(s))

\* Structural consequence of the edge table that this leg's ABSENCE of a
\* refund sweep depends on (src/db/onchainReceiveSwaps.ts:591-606 argues it in
\* prose): `refused` must be unreachable from every EXPOSED state, so a
\* refused row can never have a lockup of the solver's own behind it.
\* Asserted as a theorem over the table rather than trusted, because a Go
\* author adding awaiting_claim -> refused for a "nothing happened yet" case
\* would silently make that argument false.
RefusedUnreachableFromExposed ==
    \A x \in Exposed : "refused" \notin Edges[x]

\* Same table-assertion discipline as RefusedUnreachableFromExposed, for the
\* opposite direction: every EXPOSED state must carry an escalation to
\* `stuck` in the edge table, so store.fail() from an exposed row always has
\* somewhere legal to go.  transition() THROWS on a non-edge, so a missing
\* one would surface as an exception inside a tick rather than as a
\* refusal.  Two of the four stuck edges (funding_arkade -> stuck,
\* awaiting_claim -> stuck) have no action in this module — see the table
\* comment above — but the pin is about the table itself: a future edit
\* that drops claimed -> stuck or refunding_arkade -> stuck, or adds an
\* exposed state without one, fails every cfg loudly.  (This leg's older
\* `-coverage` argument proves actions were TAKEN, not that stuck is
\* REACHABLE FROM every exposed state; the issue #218 review caught exactly
\* that gap in the LightningReceive argument.)
StuckReachableFromEveryExposed ==
    \A x \in Exposed : "stuck" \in Edges[x]

\* The two clocks never cross, and wall clock never outruns the chain tip by
\* more than the modelled lag.
ChainTimeSane == chainTime <= clock /\ clock <= chainTime + MtpLag

(***************************************************************************)
(* LIVENESS IS CONDITIONAL ON THE ARKADE SERVER, AND THAT IS A FINDING.    *)
(*                                                                         *)
(* whenRefundingArkade has NO escalation for a censoring server: with the   *)
(* lockup still spendable and arkade.refund throwing, the code re-reads,    *)
(* finds outputs.length > 0, throws again, and the row sits in              *)
(* `refunding_arkade` with the solver's float out, forever.  The Lightning  *)
(* send corridor escalates claiming -> stuck once past the deadline         *)
(* (src/send/orchestrator.ts:1526-1536); this leg has no equivalent, and the*)
(* empty-lockup grace cannot help because the lockup is not empty.          *)
(*                                                                         *)
(* So the property is stated as an implication rather than weakened into    *)
(* uselessness: while the Arkade server keeps co-signing, every swap        *)
(* reaches a terminal state.  A cfg that dropped Censor from Next would     *)
(* hide the gap; this states it.                                            *)
(***************************************************************************)
Liveness == ([]serverUp) => EventuallyTerminal(Terminal)

(***************************************************************************)
(* Swap ids and worker ids are interchangeable: no action names one, every *)
(* invariant is a \A over them, and Liveness is a \A too.  SYMMETRY IS     *)
(* STILL NOT DECLARED — TLC's symmetry reduction is unsound in the         *)
(* presence of per-swap fairness conditions and reports counterexamples    *)
(* whose cycle exists only in the quotient graph (SwapCore T4, verified on *)
(* LightningSend).  `Perms` is defined for the record and for anyone who   *)
(* wants a safety-only run.                                                *)
(***************************************************************************)
Perms == Permutations(Swaps) \cup Permutations(Workers)

(***************************************************************************)
(* THE GREEN RUN                                                           *)
(*                                                                         *)
(*   Model checking completed. No error has been found.                    *)
(*   2325490 states generated, 339234 distinct states found, 0 left.       *)
(*   The depth of the complete state graph search is 55.                   *)
(*   Finished in 08min 41s   (-workers 4)                                  *)
(*                                                                         *)
(* Those numbers are for LockupProvablySpent = FALSE — the shipped          *)
(* spendableOnly read — with PushSubmit and PushRecord as separate fairness *)
(* groups.  An earlier revision ran TRUE with the groups merged (2756040 /  *)
(* 407390 / depth 55) and was green only because the counterfactual read    *)
(* propped up the merge.  Merged + FALSE violates Liveness in 68 s.         *)
(*                                                                         *)
(* Checked: TypeOK, NoDoublePay, AtMostOneOutcome, ExposureBounded,        *)
(* NoSilentLoss, NoNetLoss, RefusedUnreachableFromExposed,                 *)
(* StuckReachableFromEveryExposed, ChainTimeSane;                          *)
(* properties ForwardOnly ([][...]_vars) and Liveness.                     *)
(*                                                                         *)
(* The witness-discriminator split (#232) shrank this run from 2764674 /   *)
(* 408650 to the numbers above.  A `-coverage` run of the same model       *)
(* confirms every action fires except two: ClaimDust — disabled by         *)
(* ClaimFeeAffordable = TRUE and exercised by OnchainReceive_DustStuck.cfg *)
(* (4955 firings) — and ClaimSeesPriorSpend, which fires in NO cfg; see    *)
(* KNOWN-VACUOUS below for why that is structural rather than a hole.      *)
(*                                                                         *)
(* MUTATION CHECKS — RESULTS                                               *)
(*                                                                         *)
(* A spec that passes because it is too weak to fail is worse than none.   *)
(* Six guards were broken one at a time, each by a single constant, each   *)
(* with its own .cfg.  All six produce a counterexample, and two ship a    *)
(* GREEN CONTROL that isolates the guard from the constants around it.     *)
(*                                                                         *)
(*   OnchainReceive_Broken.cfg       BreakDeadlineOrder = TRUE             *)
(*                                   (+ RefundHorizon 2 -> 4)              *)
(*                                   -> NoNetLoss violated, 12s            *)
(*   OnchainReceive_BrokenControl.cfg  same, guard restored -> GREEN        *)
(*   OnchainReceive_ZeroConf.cfg     BreakConfirmations = TRUE             *)
(*                                   -> NoNetLoss violated, 2s             *)
(*   OnchainReceive_DoubleFund.cfg   FundIsIdempotent = FALSE              *)
(*                                   -> NoDoublePay violated, 2s           *)
(*   OnchainReceive_StaleIndexer.cfg IndexerNeverLies = FALSE              *)
(*                                   -> NoNetLoss violated, 18s            *)
(*   OnchainReceive_DustStuck.cfg    ClaimFeeAffordable = FALSE            *)
(*                                   -> NoNetLoss violated, 13s            *)
(*   OnchainReceive_Overexposed.cfg  AtomicAdmission = FALSE, MaxExposed 1 *)
(*                                   -> ExposureBounded violated, 1s       *)
(*   OnchainReceive_OverexposedControl.cfg  same, guard restored -> GREEN   *)
(*                                                                         *)
(* A SEVENTH, ADDED BY AUDIT, because the six above all leave the           *)
(* MIN_ARKADE_FUND_WINDOW gate at the exposure-creating edge untouched and  *)
(* an invariant set has to be shown to catch a guard its author did not     *)
(* choose:  delete `FundGateOpen` from `FundGate` (the spec's rendering of  *)
(* evaluateOnchainReceiveFunding at src/receive/onchainOrchestrator.ts:514, *)
(* :665) and the green cfg reports NoNetLoss violated at depth 24 — the     *)
(* solver funds Arkade at wall clock 4, the chain tip catches up, and the   *)
(* client takes both legs (SubmitArkFund, ClientClaimsLockup, ChainTick,    *)
(* ClientRefundsL1, ConfirmL1).  Distinct from                              *)
(* BreakDeadlineOrder, which changes the FORMULA for R rather than removing *)
(* the gate that consults it.  The invariants have teeth on both.           *)
(*                                                                         *)
(* KNOWN-VACUOUS IN THE GREEN CFG, and stated so the next reader does not   *)
(* over-read the pass:                                                      *)
(*   ExposureBounded  MaxExposed = 2, Amount = 1, |Swaps| = 2, so           *)
(*     Exposure <= 2 holds by arithmetic no matter what quote() does, and   *)
(*     AtomicAdmission = TRUE consequently does no work here either.  The   *)
(*     cap is only actually exercised by the Overexposed pair, which set    *)
(*     MaxExposed = 1.                                                      *)
(*   RefusedUnreachableFromExposed and StuckReachableFromEveryExposed are    *)
(*     predicates over `Edges` alone, with no state variable in them.  They *)
(*     are table assertions evaluated once per state; no behaviour can      *)
(*     violate them.  They belong in THEOREMS, and are listed under         *)
(*     INVARIANTS only so a cfg cannot forget them.                         *)
(*   ClaimSeesPriorSpend  fires in NO cfg, green included.  Both claimed    *)
(*     conjuncts are Urgent (:620-621) and Tick refuses to advance while    *)
(*     SolverBehind holds, so the row is driven out of `claimed` — by       *)
(*     ClaimSeesOwnClaim, ClaimDust or RecordSettled — before chain time    *)
(*     can reach HtlcLocktime and open the client's L1 refund leaf.  The    *)
(*     shipped fail branch (:736-740) fires only when a crash loop          *)
(*     outlasts the settlement margin, a timing the urgency discipline      *)
(*     excludes by construction.  Kept because the branch exists in the     *)
(*     code; the split merely makes its unreachability here visible.        *)
(*                                                                         *)
(* THE MANDATED ONE, IN FULL.  OnchainReceive_Broken.cfg deletes the       *)
(* `htlcLocktime - SETTLE_SAFETY_MARGIN` bound from                        *)
(* arkadeRefundLocktimeFor and raises MAX_REFUND_HORIZON so that deletion  *)
(* can be felt (see that cfg's header for why the second change is part of *)
(* the finding rather than a fudge).  R then equals E: the solver's own    *)
(* escape hatch opens at the very instant the client's does.  TLC finds    *)
(* this in 27 states.  Constants: HtlcLocktime 4, SettleSafetyMargin 2,    *)
(* RefundHorizon 4, MinArkFundWindow 1, MtpLag 1.                          *)
(*                                                                         *)
(*   1-4    s1 quoted at clock 0                                           *)
(*   5      ClientFundsHtlc(s1)   the client broadcasts its L1 HTLC        *)
(*   6      SeeHtlcFunding        quoted -> awaiting_confirmations, at     *)
(*                                depth 0, which is what the code does     *)
(*   9-10   InsertQuote(s2), ConfirmHtlcFunding(s1)  one block; the        *)
(*                                funding is now at min_confirmations      *)
(*   11     FundGate              awaiting_confirmations -> funding_arkade *)
(*                                <<< THE MUTATION.  With the real guard   *)
(*                                R would be min(4-2, 4) = 2 and this edge *)
(*                                would still be legal here — the mutation *)
(*                                does not change WHETHER the solver funds,*)
(*                                it changes how long it may wait to bail. *)
(*   12-13  ReadSwap, SubmitArkFund   the solver's own Arkade float leaves.*)
(*                                IRREVERSIBLE.  Nothing has been collected*)
(*   14     RecordFunding         funding_arkade -> awaiting_claim         *)
(*   16-20  Tick / ChainTick x3   clock 0 -> 3, chain tip 0 -> 2.  The     *)
(*                                client does nothing at all: the claim    *)
(*                                leaf has no timelock, so waiting costs   *)
(*                                the client nothing and costs the solver  *)
(*                                its whole margin.                        *)
(*   21     ArmRefund             awaiting_claim -> refunding_arkade at    *)
(*                                clock 3 = R - MIN_ARKADE_FUND_WINDOW.    *)
(*                                The solver has DECIDED to unwind — and   *)
(*                                cannot act, because the covenant CLTV    *)
(*                                matures against the chain tip, which is  *)
(*                                still at 2.                              *)
(*   22-23  ChainTick, Tick       chain tip 3, clock 4                     *)
(*   24     ClientClaimsLockup    THE CLIENT TAKES THE ARKADE LOCKUP.  The *)
(*                                covenant pays it to clientPayoutPkScript.*)
(*                                The solver's refund is now impossible —  *)
(*                                one output, one spend.                   *)
(*   25     ChainTick             chain tip 4 = R = E.  The solver's       *)
(*                                refund would mature THIS INSTANT.  Too   *)
(*                                late by one action.                      *)
(*   26     ClientRefundsL1       and the same instant opens the CLIENT's  *)
(*                                L1 refund leaf, because R = E            *)
(*   27     ConfirmL1             a miner confirms it                      *)
(*                                                                         *)
(*   Final state: conf[s1] = {"clientClaim"}  /\  l1[s1] = {"clientRefund"} *)
(*   NoNetLoss violated.  The client holds the solver's Arkade float AND   *)
(*   its own L1 sats back.  The row still reads `refunding_arkade`: the    *)
(*   solver has not even noticed yet, and when it does it will read the    *)
(*   claim, move to `claimed`, find the L1 outpoint already spent, and     *)
(*   book `stuck` — the state whose comment in the TypeScript names this   *)
(*   exact scenario as "the double-loss-for-the-solver scenario the        *)
(*   timelock-ordering invariant exists to prevent".                       *)
(*                                                                         *)
(* Note what the counterexample does NOT need: no crash, no lost           *)
(* compare-and-swap, no concurrent double-anything, and no misbehaviour by *)
(* any component.  Every party follows the protocol.  R + M <= E is not a  *)
(* concurrency guard — it is the statement that the solver's escape hatch  *)
(* must open far enough before the client's that the solver can still use  *)
(* it after losing the Arkade race.  That is why breaking it is caught by  *)
(* a money invariant and not by ForwardOnly or NoDoublePay.                *)
(*                                                                         *)
(* THE OTHER FIVE, IN ONE LINE EACH:                                       *)
(*                                                                         *)
(*   ZeroConf     12 states.  The solver funds Arkade against a depth-0    *)
(*     funding (SubmitArkFund at state 10), a reorg evicts it (state 11),  *)
(*     the client claims the lockup (state 12).  The solver is down the    *)
(*     full amount against an outpoint that no longer exists, and the row  *)
(*     is still in `funding_arkade`.                                       *)
(*                                                                         *)
(*   DoubleFund   13 states, and THE SHORTEST TRACE IN THE SET NEEDS NO    *)
(*     CRASH: two ReadSwap actions on the same `funding_arkade` row (10,   *)
(*     11), both sampling findLockups as empty, then two SubmitArkFund     *)
(*     actions (12, 13).  arkFund = 2 at clock 0.  This is what deleting   *)
(*     `inFlight` does on its own.                                         *)
(*                                                                         *)
(*   StaleIndexer 31 states.  The client claims while the row is in        *)
(*     `refunding_arkade` (20); the spendable view has emptied but the     *)
(*     claim is not readable yet, so two successive empty reads (21, 22)   *)
(*     exhaust the grace and book `stuck` on a swap that COMPLETED.        *)
(*     Nobody sweeps L1, and the client refunds it at E (30, 31).          *)
(*                                                                         *)
(*   DustStuck    29 states.  The claim lands and is read normally (16,    *)
(*     17); the dust check refuses the L1 sweep and books terminal `stuck` *)
(*     (19); the client refunds L1 at E (28, 29).  A fee spike inside a    *)
(*     window where the solver has already paid out is a total loss, on a  *)
(*     leg with no operator retry command.                                 *)
(*                                                                         *)
(*   Overexposed  a handful of states: two quote handlers each read        *)
(*     committedSats before either inserts.                                *)
(***************************************************************************)
=============================================================================
