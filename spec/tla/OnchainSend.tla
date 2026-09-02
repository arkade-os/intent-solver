------------------------------ MODULE OnchainSend ------------------------------
(***************************************************************************)
(* ONCHAIN SEND CORRIDOR   arkade:BTC -> onchain:BTC                       *)
(*                                                                         *)
(* WHICH TYPESCRIPT THIS SPECIFIES                                         *)
(*                                                                         *)
(*   src/db/onchainSwaps.ts          the durable row, LEGAL_EDGES,         *)
(*                                   transition(), patch(), fail(),        *)
(*                                   committedSats(), findRecoverable()    *)
(*   src/send/onchainOrchestrator.ts the whole state machine: step(),      *)
(*                                   whenQuoted, whenFunded,               *)
(*                                   whenFundingOnchain, recoverFunding,   *)
(*                                   submitFunding, whenAwaitingClaim,     *)
(*                                   whenClaiming, whenRefundingOnchain,   *)
(*                                   pushOnchainHtlcRefund, tick()         *)
(*   src/core/onchainSend.ts         DEFAULT_ONCHAIN_LOCKUP_TIMEOUT,       *)
(*                                   MIN_ONCHAIN_FUND_WINDOW,              *)
(*                                   htlcLocktimeFor,                      *)
(*                                   onchainRefundLocktimeFor,             *)
(*                                   DEFAULT_MIN_CONFIRMATIONS,            *)
(*                                   ONCHAIN_DUST_SATS                     *)
(*   src/onchain/htlc.ts             the two leaves: a claim leaf with NO  *)
(*                                   CHECKLOCKTIMEVERIFY, and a refund     *)
(*                                   leaf gated on htlc_locktime           *)
(*   src/onchain/claim.ts            the witness the client's claim leaves *)
(*                                   behind — the solver's only source of P*)
(*   src/onchain/refund.ts           the solver's refund spend, nLockTime  *)
(*                                   = htlc_locktime, sequence 0xfffffffd  *)
(*   src/send/arkadeOps.ts           claim() and assertScriptMatchesRow    *)
(*   packages/solver-app/src/worker.ts                   the queue fan-out and its safety claim*)
(*                                                                         *)
(* AUTHORITY FOR THE EDGE TABLE                                            *)
(*                                                                         *)
(* src/db/onchainSwaps.ts lines 54-64, verbatim:                           *)
(*                                                                         *)
(*   quoted:            ['funded', 'refused']                              *)
(*   funded:            ['funding_onchain', 'refused']                     *)
(*   funding_onchain:   ['awaiting_claim', 'stuck']                        *)
(*   awaiting_claim:    ['claiming', 'refunding_onchain', 'stuck']         *)
(*   claiming:          ['claimed', 'stuck']                               *)
(*   refunding_onchain: ['claiming', 'refunded', 'stuck']                  *)
(*   claimed:           []                                                 *)
(*   refunded:          []                                                 *)
(*   refused:           []                                                 *)
(*   stuck:             []                                                 *)
(*                                                                         *)
(* plus src/db/onchainSwaps.ts:39-52                                       *)
(*   NON_TERMINAL = quoted funded funding_onchain awaiting_claim           *)
(*                  claiming refunding_onchain                             *)
(*   EXPOSED      = funding_onchain awaiting_claim claiming                *)
(*                  refunding_onchain                                      *)
(*                                                                         *)
(* `Edges` below adds exactly two edges the TypeScript does not have —     *)
(* none -> {quoted, rejected} and rejected -> {} — which model quote()'s   *)
(* INSERT-or-refuse (onchainOrchestrator.ts:172-251).  In the TypeScript   *)
(* that is a row appearing or not appearing, not a transition.  They are   *)
(* marked in the definition.  Everything else diffs line for line.         *)
(*                                                                         *)
(* THE STRUCTURAL FACT THIS CORRIDOR IS DEFINED BY                         *)
(*                                                                         *)
(* Unlike the Lightning send leg, the contested output is INSIDE the state *)
(* machine.  The solver funds an L1 Taproot HTLC out of its own wallet.    *)
(* That output has two spending leaves and they are NOT symmetric:         *)
(*                                                                         *)
(*   claim leaf   SIZE 32 EQUALVERIFY HASH160 <h> EQUALVERIFY <ck> CHECKSIG*)
(*                — NO CHECKLOCKTIMEVERIFY.  The client may spend it at    *)
(*                any instant, forever, including long after the solver    *)
(*                has decided to refund.  (src/onchain/htlc.ts:87-92)      *)
(*   refund leaf  <htlc_locktime> CLTV DROP <rk> CHECKSIG — matures        *)
(*                against MEDIAN-TIME-PAST, not wall clock.                *)
(*                                                                         *)
(* Bitcoin confirms exactly one spend of an outpoint.  So the window in    *)
(* which the client can still beat the solver OPENS at htlc_locktime and   *)
(* NEVER CLOSES, and `refunding_onchain -> claiming` is the edge that      *)
(* records the solver LOSING that race — which is not a loss at all, since *)
(* the winning claim HANDS THE SOLVER P on its witness, and P is the only  *)
(* thing the Arkade claim needed.  That edge is `RefundSeesClaim` below,   *)
(* and the pre-broadcast re-read that enables it is the guard the mandated *)
(* mutation breaks.                                                        *)
(*                                                                         *)
(* WHAT IS DELIBERATELY ABSTRACTED AWAY                                    *)
(*                                                                         *)
(*  - Amounts, overfunding, dust.  Every swap is `Amount` sats.  The       *)
(*    ONCHAIN_DUST_SATS refusal (onchainOrchestrator.ts:773-791) routes to *)
(*    `stuck`, which NoSilentLoss already covers, and is a fee-market      *)
(*    property rather than a concurrency one.                              *)
(*  - The preimage column.  P is written in the SAME UPDATE as the         *)
(*    transition into `claiming` (:636 and :691), so `st[s] = "claiming"`  *)
(*    already means "P is on disk and the Arkade claim needs nothing       *)
(*    external".  A separate variable could only disagree with the state.  *)
(*  - patch(), the event log, column allowlists, the operator commands     *)
(*    reclaimOnchainHtlc()/refundNow().  Those are recovery for rows this  *)
(*    machine has already parked; they are not edges.                      *)
(*  - refundSweep() on `refused` rows.  It can only ever pay the client's  *)
(*    committed address, so on the contested Arkade output it is           *)
(*    indistinguishable from the client's own refund; both are             *)
(*    `ClientRefundLockup` here.                                           *)
(*  - checkFunded (funding_onchain -> awaiting_claim with funding_txid     *)
(*    already non-null, :539-541, :603-605).  DEAD EDGE: no code path      *)
(*    writes funding_txid without moving the state in the same UPDATE, so  *)
(*    it is unreachable through the store's API.  Marked, not modelled.    *)
(*                                                                         *)
(* MODELLING DECISIONS THAT ARE ASSUMPTIONS, NOT FACTS                     *)
(*                                                                         *)
(*  (A1) TWO CLOCKS.  `clock` is wall clock (this.now()).  `chainTime` is  *)
(*       median-time-past: monotone, never ahead of `clock`, and permitted *)
(*       to trail it by up to MtpLag.  A refund spend is NON-FINAL and is  *)
(*       rejected outright while chainTime < HtlcLocktime.                 *)
(*       HTLC_REFUND_MTP_MARGIN is a WALL-CLOCK PROXY for "MTP has passed  *)
(*       htlc_locktime", never a proof; ASSUME MtpLag <= RefundMtpMargin   *)
(*       is exactly the sizing claim the constant makes, written down so   *)
(*       it can be diffed rather than believed.                            *)
(*                                                                         *)
(*  (A2) The drive loop keeps up.  `Tick` is disabled while any swap has   *)
(*       an immediately-completable solver step outstanding (`Urgent`).    *)
(*       Same reasoning, and the same limits, as LightningSend's (A2): a   *)
(*       solver that simply stops loses money regardless of any guard.     *)
(*       It does NOT weaken the concurrency model — workers still race,    *)
(*       crash mid-action, lose CASes and double-broadcast, all inside a   *)
(*       frozen tick.                                                      *)
(*                                                                         *)
(*       BUT IT IS THE STRONGEST ASSUMPTION IN THIS MODULE, and it is what *)
(*       makes every TIMING guard on this corridor unfalsifiable.  Read    *)
(*       the `claiming` disjunct of `Urgent` literally: wall clock may not *)
(*       advance while a row sits in `claiming` with the Arkade lockup     *)
(*       unspent and the server up.  arkade.claim() is an RPC round trip   *)
(*       plus an Arkade-server co-signature, not an instant, so that       *)
(*       disjunct asserts something the code cannot deliver — and it is    *)
(*       precisely the interval MIN_ONCHAIN_FUND_WINDOW and                *)
(*       HTLC_REFUND_MTP_MARGIN were sized to pay for.                     *)
(*                                                                         *)
(*       MEASURED, not argued.  Delete ONLY that one disjunct from         *)
(*       `Urgent`, change no guard, and TLC violates NoNetLoss in 23       *)
(*       states: the client claims the L1 HTLC at the last instant (the    *)
(*       claim leaf has NO timelock, so it may), the row reaches           *)
(*       `claiming` holding P, the clock reaches refund_locktime before    *)
(*       the Arkade claim lands, and ClientRefundLockup takes the lockup.  *)
(*       Both legs gone, with funding admitted at clock 0 under the FULL   *)
(*       fund window.  Two consequences a Go author must not miss:         *)
(*                                                                         *)
(*         - that loss is REAL and UNGUARDED in the TypeScript.  Nothing   *)
(*           in whenAwaitingClaim/whenClaiming bounds the gap between the  *)
(*           client's L1 claim and the solver's Arkade claim against       *)
(*           refund_locktime, and MIN_ONCHAIN_FUND_WINDOW cannot bound it: *)
(*           it constrains when funding STARTS, not when the client claims.*)
(*         - therefore the "no error" results for BreakRefundTiming below, *)
(*           and for any mutation of FundGateOpen, are evidence about (A2) *)
(*           and NOT evidence about the guards.  Independently confirmed:  *)
(*           deleting FundGateOpen from FundGate leaves TLC green          *)
(*           (711,946 distinct states) for exactly this reason.            *)
(*                                                                         *)
(*  (A3) MempoolExclusive.  A transaction already broadcast for an         *)
(*       outpoint keeps any conflicting spend from being relayed and       *)
(*       confirmed (Bitcoin Core's first-seen policy).  This is the model  *)
(*       constant that makes `refunded` a safe terminal state, and it is   *)
(*       NOT what the code actually gets: src/onchain/refund.ts sets       *)
(*       sequence 0xfffffffd, which enables nLockTime AND OPTS INTO RBF.   *)
(*       0xfffffffe would enable the locktime without signalling           *)
(*       replaceability.  OnchainSend_MempoolRace.cfg sets this FALSE and  *)
(*       TLC finds the documented worst case.  See the report.             *)
(*                                                                         *)
(*  (A4) FundIsIdempotent.  The funding backend deduplicates repeated      *)
(*       calls for one swap.  It DOES NOT, and the code says so at         *)
(*       onchainOrchestrator.ts:544-556: the funding call — LND's          *)
(*       sendToChainAddress — takes no idempotency key.  Today the only    *)
(*       thing standing in for it is the in-process `inFlight` Set plus a  *)
(*       chain read that may lag.  OnchainSend_DoubleFund.cfg sets this    *)
(*       FALSE.                                                            *)
(*                                                                         *)
(*  (A5) The client's claim witness is parseable.  preimageFromClaimWitness*)
(*       is literally `witness[1] ?? null` (:88) — POSITIONAL and          *)
(*       unauthenticated.  A structurally valid claim built with a         *)
(*       different witness layout reads as "spent by something other than  *)
(*       a matching claim" and parks the row in `stuck` while the client   *)
(*       walks away with the L1 sats and then refunds the Arkade lockup    *)
(*       too.  That hazard is NOT modelled (it would need a third spend    *)
(*       kind and doubles the contested-output state space); it is         *)
(*       reported instead, and it is a real unguarded loss.                *)
(*                                                                         *)
(*  (A6) min_confirmations is the CLIENT's guardrail, not the solver's.    *)
(*       `confirmations` is read NOWHERE in src/send/onchainOrchestrator.ts*)
(*       — funding_onchain -> awaiting_claim fires at ZERO depth.  So      *)
(*       MinConfirmations appears here only where it really bites: the     *)
(*       client will not claim until the funding output has the promised   *)
(*       depth, and htlc_locktime was sized as minConf*600 + 10800 to pay  *)
(*       for that wait.  Modelling it as a solver gate would specify a     *)
(*       guard the code does not have.                                     *)
(*                                                                         *)
(*  (A7) findLockups() ANSWERS [] ONLY FOR A SPENT LOCKUP.  It does not:   *)
(*       it is getVtxos({ spendableOnly: true }) (src/arkade/wallet.ts:    *)
(*       133-136), so a swept, renewed or merely lagging vtxo reads []     *)
(*       exactly as a spent one does — and whenClaiming (:645-649) fails   *)
(*       the row to `stuck` on that read ALONE, with none of the           *)
(*       lockupProvablySpent second read pushRefund insists on (:313-317). *)
(*       LockupReadIsReliable = TRUE is the idealisation; FALSE is the     *)
(*       code.  OnchainSend_LaggingLockupRead.cfg sets it FALSE and TLC    *)
(*       violates NoNetLoss in 25 states with no crash, no lost CAS and no *)
(*       concurrency: the client claims the L1 HTLC, a lagging read parks  *)
(*       the row in `stuck` while it still holds P, and at refund_locktime *)
(*       the client pulls the Arkade lockup back too.  The fix in the Go   *)
(*       rewrite is the one the Arkade refund path already has — do not    *)
(*       believe an empty spendableOnly read without a second, positive    *)
(*       proof of the spend.                                               *)
(*                                                                         *)
(*  (A8) THE `awaiting_claim -> stuck` EDGE IS NOT MODELLED, though it is  *)
(*       in Edges and the code takes it twice: :610 (no funding txid/vout, *)
(*       unreachable through the store's API for the same reason           *)
(*       checkFunded is) and :633 (a spend that is not a recognisable      *)
(*       claim).  The second is reachable in reality and is the (A5)       *)
(*       hazard — an unparseable-but-valid client claim — for which this   *)
(*       model has no third spend kind.  Marked so its absence reads as a  *)
(*       decision: every other edge of the table has an action.            *)
(*                                                                         *)
(*  (A9) THE PRE-BROADCAST RE-READ AND THE BROADCAST ARE ONE STEP.         *)
(*       BroadcastRefund tests ~WitnessSeen(s) at the instant it writes    *)
(*       l1, but whenRefundingOnchain reads the witness (:687) and then    *)
(*       runs estimateFeeRate / build / sign / broadcastRaw (:762-795) —   *)
(*       four awaits in which a claim can be relayed behind a read that    *)
(*       has already returned.  Consequence: RefundBroadcastable's         *)
(*       `l1 = "claimSeen" /\ ~MempoolExclusive` disjunct is UNREACHABLE   *)
(*       in every cfg where BreakRefundRecheck is FALSE, so `contested`    *)
(*       is only ever entered claim-after-refund and never                 *)
(*       refund-after-claim.  Checked and reported rather than fixed: the  *)
(*       reachable OUTCOMES of the stale-read broadcast are the same       *)
(*       (rejected under first-seen, `contested` without it), so splitting *)
(*       the action costs state space and buys no new counterexample.      *)
(*       A Go rewrite must still not read this as permission to hoist the  *)
(*       re-read any earlier than it already is.                           *)
(*                                                                         *)
(* WHAT A GO IMPLEMENTER MUST PRESERVE                                     *)
(*                                                                         *)
(*  1. whenRefundingOnchain re-reads findSpendWitness IMMEDIATELY before   *)
(*     broadcasting, and a hash-verified preimage takes the row to         *)
(*     `claiming` instead.  See RefundSeesClaim and OnchainSend_Broken.cfg.*)
(*  2. `refunded` records a BROADCAST, not a confirmation, and is          *)
(*     terminal.  Either make it non-terminal until the spend confirms, or *)
(*     stop signalling RBF on the refund.  See OnchainSend_MempoolRace.cfg.*)
(*  3. funded -> funding_onchain is committed BEFORE onchain.fund, but the *)
(*     CAS gates ENTRY and not OCCUPANCY: the row sits in funding_onchain  *)
(*     for the whole RPC and a second worker sees the same preconditions.  *)
(*     A lease or a backend idempotency key is required.  See SubmitFunding*)
(*     and OnchainSend_DoubleFund.cfg.                                     *)
(*  4. The exposure cap must be enforced by the same write that consumes   *)
(*     it.  See AtomicAdmission and OnchainSend_Overexposed.cfg.           *)
(*  5. The recovery branch is chosen from the ROW and from the CHAIN       *)
(*     (`funding_txid IS NULL` then findOutputs), never from process       *)
(*     memory.  See AdoptFunding.                                          *)
(*                                                                         *)
(* HOW THIS WAS CHECKED                                                    *)
(*                                                                         *)
(*   OnchainSend.cfg           2 swaps, 2 workers, wall clock 0..3,        *)
(*                             median-time-past trailing by up to 1.       *)
(*                             GREEN: 3,445,546 states generated, 517,174  *)
(*                             distinct, depth 49, 24 s.  A coverage run   *)
(*                             confirms all 24 actions fire — no dead spec.*)
(*                             (Counts fell from 4,275,514/624,790 when    *)
(*                             RefundBroadcastable/ConfirmL1 were tightened*)
(*                             from `chainTime >= HtlcLocktime` to `>`, per *)
(*                             BIP113; see RefundBroadcastable.)           *)
(*   OnchainSend_Liveness.cfg  the same model on ONE swap, adding the      *)
(*                             temporal property.  GREEN: 44,653 states,   *)
(*                             8,152 distinct, depth 30, 5 s.  Liveness is *)
(*                             split out because TLC's tableau over the    *)
(*                             two-swap graph does not converge; see that  *)
(*                             cfg and the note in OnchainSend.cfg.        *)
(*   six mutation cfgs         see the results block at the end.           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC, SwapCore

CONSTANTS
    HtlcLocktime,        \* htlc_locktime: the solver's L1 refund leaf matures
    RefundMtpMargin,     \* HTLC_REFUND_MTP_MARGIN (90 min)
    MtpLag,              \* how far median-time-past may trail wall clock
    RefundLocktime,      \* refund_locktime: the client's ARKADE refund opens
    MinFundWindow,       \* MIN_ONCHAIN_FUND_WINDOW (90 min)
    LockupDeadline,      \* created_at + DEFAULT_ONCHAIN_LOCKUP_TIMEOUT (15 min)
    MinConfirmations,    \* min_confirmations — see (A6)
    BreakRefundRecheck,  \* MUTATION: drop whenRefundingOnchain's pre-broadcast read
    BreakRefundTiming,   \* MUTATION: arm the refund without the MTP margin
    MempoolExclusive,    \* MUTATION: see (A3)
    FundIsIdempotent,    \* MUTATION: see (A4)
    LockupReadIsReliable,\* MUTATION: see (A7)
    AtomicAdmission      \* MUTATION: quote() is one conditional INSERT

(***************************************************************************)
(* THE CONSTANT ORDERING IS THE WHOLE CONTENT OF THE TIMING GUARDS.        *)
(*                                                                         *)
(* Real values, from src/core/onchainSend.ts with minConfirmations = 1 and *)
(* T0 = quote time:                                                        *)
(*                                                                         *)
(*   htlc_locktime            T0 + 11400   (600*1 + 2*5400)                *)
(*   solver arms its refund   T0 + 16800   (+ HTLC_REFUND_MTP_MARGIN 5400) *)
(*   funding gate closes      T0 + 20400   (refund_locktime - 5400)        *)
(*   refund_locktime          T0 + 25800   (htlc_locktime + 2*7200)        *)
(*                                                                         *)
(* which leaves 9000 s for the whole refunding_onchain -> claiming ->      *)
(* claimed recovery after a late claim.  The ASSUMEs below are that budget *)
(* written as an ordering, so a cfg cannot quietly make it negative.       *)
(***************************************************************************)
ASSUME MtpLag <= RefundMtpMargin                         \* (A1): the sizing claim
ASSUME HtlcLocktime + RefundMtpMargin < RefundLocktime   \* recovery budget > 0
ASSUME MinConfirmations >= 1                             \* the missing Math.max
ASSUME RefundLocktime <= MaxClock

VARIABLES
    chainTime,  \* median-time-past.  Monotone, <= clock, trails by <= MtpLag.
    lockup,     \* [Swaps -> BOOLEAN] the CLIENT's Arkade lockup exists at pk_script
    fundOut,    \* [Swaps -> 0..2] L1 funding payments the BACKEND actually made.
                \* > 1 == the solver paid the same HTLC twice out of its own wallet.
    fundConf,   \* [Swaps -> 0..MinConfirmations] depth of the funding output.
                \* 0 also stands for "not yet visible to findOutputs" — the
                \* residual crash window recoverFunding documents at :578-591.
    l1          \* [Swaps -> L1Status] the L1 HTLC outpoint: what has been
                \* broadcast for it and what the chain has confirmed.

OsVars == << chainTime, lockup, fundOut, fundConf, l1 >>
OsRest == << lockup, fundOut, fundConf, l1 >>
vars   == << clock, st, loc, conf, serverUp,
             chainTime, lockup, fundOut, fundConf, l1 >>

(***************************************************************************)
(* SwapCore constants supplied by cfg definition override.                 *)
(*                                                                         *)
(* SwapCore's `conf` / SpendKinds is the ARKADE lockup — the client's       *)
(* covenant refund racing the solver's covenant claim.  The L1 outpoint is *)
(* a SECOND contested output with its own two spenders, which SwapCore has *)
(* no vocabulary for; `L1Status` and `l1` are local.  See the report.      *)
(* report: this is the one gap in the shared module.                       *)
(***************************************************************************)
OSPhases     == { "idle", "read", "fundCommitted", "fundCalled",
                  "refundSent", "claimSent" }
OSResults    == { "none", "capOk", "capFull" }
OSSpendKinds == { "solverClaim", "clientRefund" }   \* the ARKADE lockup

(***************************************************************************)
(* THE L1 HTLC OUTPOINT, as one enumeration rather than a broadcast set and *)
(* a confirmed set.  Written this way because the pair is what the state    *)
(* space is most sensitive to, and because only six of its sixteen          *)
(* combinations are reachable anyway:                                       *)
(*                                                                         *)
(*   unspent      nothing broadcast                                        *)
(*   claimSeen    the client's claim is in the mempool                     *)
(*   refundSeen   the solver's refund is in the mempool                    *)
(*   contested    BOTH are — reachable only when MempoolExclusive is FALSE *)
(*   claimed      the chain confirmed the client's claim                   *)
(*   refunded     the chain confirmed the solver's refund                  *)
(*                                                                         *)
(* "claimed"/"refunded" are absorbing, which is Bitcoin's one-spend rule    *)
(* and is checked as the action property L1OutcomeIsFinal rather than left *)
(* to the encoding.                                                        *)
(***************************************************************************)
L1Status == { "unspent", "claimSeen", "refundSeen", "contested",
              "claimed", "refunded" }

(***************************************************************************)
(* THE EDGE TABLE.  Diff this against src/db/onchainSwaps.ts:54-64.        *)
(***************************************************************************)
Row   == { "quoted", "funded", "funding_onchain", "awaiting_claim",
           "claiming", "claimed", "refunding_onchain", "refunded",
           "refused", "stuck" }
AllSt == Row \cup { "none", "rejected" }   \* the two spec-only pre-row markers

Edges == [ x \in AllSt |->
    CASE x = "none"              -> { "quoted", "rejected" }  \* SPEC ONLY: insert or refuse
      [] x = "rejected"          -> { }                       \* SPEC ONLY: no row was created
      [] x = "quoted"            -> { "funded", "refused" }
      [] x = "funded"            -> { "funding_onchain", "refused" }
      [] x = "funding_onchain"   -> { "awaiting_claim", "stuck" }
      [] x = "awaiting_claim"    -> { "claiming", "refunding_onchain", "stuck" }
      [] x = "claiming"          -> { "claimed", "stuck" }
      [] x = "refunding_onchain" -> { "claiming", "refunded", "stuck" }
      [] x = "claimed"           -> { }
      [] x = "refunded"          -> { }
      [] x = "refused"           -> { }
      [] x = "stuck"             -> { } ]

NonTerminal == { "quoted", "funded", "funding_onchain", "awaiting_claim",
                 "claiming", "refunding_onchain" }
Exposed     == { "funding_onchain", "awaiting_claim", "claiming",
                 "refunding_onchain" }
Terminal    == { "claimed", "refunded", "refused", "stuck", "rejected" }
Drivable    == NonTerminal \cup { "none" }   \* findRecoverable(), plus quote()

(***************************************************************************)
(* MONEY.                                                                  *)
(*                                                                         *)
(* The solver's L1 sats are NOT irreversibly gone the moment onchain.fund  *)
(* confirms — the refund leaf can still bring them home.  They are gone at *)
(* exactly the instant the CLIENT's claim CONFIRMS, which is also the      *)
(* instant P becomes readable.  That coincidence is the whole design: the  *)
(* payout and the secret arrive together, and the only question left is    *)
(* whether the solver looks.                                              *)
(***************************************************************************)
ClientTookL1(s)     == l1[s] = "claimed"             \* the solver's L1 sats left
SolverRefundedL1(s) == l1[s] = "refunded"            \* the solver got them back
L1Settled(s)        == ClientTookL1(s) \/ SolverRefundedL1(s)
PaidOut(s)          == ClientTookL1(s)
Collected(s)        == SpentBy(s, "solverClaim")     \* the Arkade lockup is ours
ClientTookLockup(s) == SpentBy(s, "clientRefund")    \* the client pulled it back

--------------------------------------------------------------------------
(***************************************************************************)
(* GUARDS.  Evaluated on the CURRENT clock against the worker's SNAPSHOT   *)
(* of the row — which is what whenFunded does: evaluateOnchainSendFunding  *)
(* runs at the instant before the money moves, not at quote time and not   *)
(* when the lockup was first seen.                                        *)
(***************************************************************************)

\* evaluateOnchainSendFunding, src/core/onchainSend.ts:120-126.
\* `now >= refundLocktime - MIN_ONCHAIN_FUND_WINDOW` refuses; written as
\* addition so Naturals never goes negative.
FundGateOpen == clock + MinFundWindow < RefundLocktime

\* whenQuoted's deadline, src/send/onchainOrchestrator.ts:506.
LockupTimedOut == clock >= LockupDeadline

\* whenAwaitingClaim, :620-622.  The margin is a WALL-CLOCK proxy for "MTP has
\* passed htlc_locktime" (A1).  The mutation drops the margin AND the deadline.
RefundArmed == BreakRefundTiming \/ clock >= HtlcLocktime + RefundMtpMargin

\* onchain.findSpendWitness is THREE-VALUED and `null` is not proof of
\* non-spend.  Esplora reads only `outspend.spent` and ignores
\* `status.confirmed` (packages/solver-rails-esplora/src/esplora.ts:148-167),
\* so an UNCONFIRMED claim already reads as spent — which is what makes the
\* pre-broadcast re-check worth anything at all.  LND's version resolves on a
\* confirmation event and returns null after a 5 s timeout, i.e. "not seen
\* within 5 seconds"; that half is not modelled as a separate knob because its
\* money consequence is identical to MempoolExclusive = FALSE.
WitnessSeen(s)   == l1[s] # "unspent"
ClaimWitness(s)  == l1[s] \in { "claimSeen", "contested", "claimed" }
AlienWitness(s)  == WitnessSeen(s) /\ ~ClaimWitness(s)

\* Can the solver's refund spend actually go out?  Three separate physical
\* facts, none of them a policy choice:
\*   - the outpoint is not already spent on-chain (else a plain double-spend);
\*   - BIP65/BIP113: src/onchain/refund.ts:74 sets nLockTime = htlc_locktime
\*     exactly, and IsFinalTx admits a time-based locktime only when
\*     nLockTime < median-time-past — STRICTLY.  Hence `>`, not `>=`: at
\*     MTP = htlc_locktime the refund is still non-final and every mempool
\*     rejects it, which is one more instant in which the client's untimelocked
\*     claim leaf can still win.  `>=` here would hand the solver a tick that
\*     Bitcoin does not give it.
\*   - first-seen: a conflicting spend already relayed keeps this one out (A3).
RefundBroadcastable(s) ==
    /\ chainTime > HtlcLocktime
    /\ \/ l1[s] = "unspent"
       \/ (l1[s] = "claimSeen" /\ ~MempoolExclusive)

--------------------------------------------------------------------------
(***************************************************************************)
(* ENVIRONMENT.  An adversary within physical limits.                      *)
(***************************************************************************)

\* The client locks up the exact amount on the Arkade side.
ClientFunds(s) ==
    /\ st[s] = "quoted"
    /\ ~lockup[s]
    /\ lockup' = [lockup EXCEPT ![s] = TRUE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, fundOut, fundConf, l1 >>

\* A block lands on top of the solver's funding transaction.  Depth 0 means
\* the output is not even visible to findOutputs yet, which is the residual
\* crash window recoverFunding concedes (:578-591) — small on LND, and wider on
\* any backend whose send call returns before the transaction is broadcast.
ConfirmFunding(s) ==
    /\ fundOut[s] >= 1
    /\ fundConf[s] < MinConfirmations
    /\ fundConf' = [fundConf EXCEPT ![s] = fundConf[s] + 1]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, lockup, fundOut, l1 >>

\* THE CLAIM LEAF HAS NO TIMELOCK.  The client may broadcast at ANY instant
\* once the funding output is as deep as the quote promised — before the
\* solver arms its refund, at the same instant, or long after.  There is no
\* clock condition here on purpose: a spec that lets the client's claim expire
\* cannot find the bug this corridor's back-edge exists to survive.
ClientClaimsL1(s) ==
    /\ fundOut[s] >= 1
    /\ fundConf[s] >= MinConfirmations
    /\ \/ /\ l1[s] = "unspent"
          /\ l1' = [l1 EXCEPT ![s] = "claimSeen"]
       \/ /\ l1[s] = "refundSeen"          \* replaces a refund already relayed
          /\ ~MempoolExclusive             \* — which sequence 0xfffffffd invites
          /\ l1' = [l1 EXCEPT ![s] = "contested"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, lockup, fundOut, fundConf >>

\* A miner picks ONE of the broadcast spends of the L1 outpoint.  Bitcoin
\* consensus permits exactly one; the conflicting transaction is evicted.
\* This is the only place `l1` is written, which is what makes
\* AtMostOneOutcome an inevitability rather than a hope.
ConfirmL1(s) ==
    /\ \/ /\ l1[s] = "claimSeen"
          /\ l1' = [l1 EXCEPT ![s] = "claimed"]
       \/ /\ l1[s] = "refundSeen"
          /\ chainTime > HtlcLocktime       \* BIP65/BIP113: strictly, see above
          /\ l1' = [l1 EXCEPT ![s] = "refunded"]
       \/ /\ l1[s] = "contested"
          /\ \/ l1' = [l1 EXCEPT ![s] = "claimed"]
             \/ /\ chainTime > HtlcLocktime
                /\ l1' = [l1 EXCEPT ![s] = "refunded"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << chainTime, lockup, fundOut, fundConf >>

\* THE ADVERSARIAL SPEND ON THE ARKADE SIDE.  The client's own
\* refundWithoutReceiver leaf, open from refund_locktime and needing the
\* Arkade server's co-signature.  This also models refundSweep()'s push on a
\* `refused` row: the covenant refund can only ever pay the client's committed
\* address, so both have the identical effect on the contested output.
ClientRefundLockup(s) ==
    /\ lockup[s]
    /\ serverUp
    /\ clock >= RefundLocktime
    /\ SpendAccepted(s, "clientRefund")
    /\ UNCHANGED << clock, st, loc, serverUp >>
    /\ UNCHANGED OsVars

Censor == CensorCore /\ UNCHANGED OsVars

\* (A2): the clock does not advance while the solver has a step it could
\* finish right now.  Note what is NOT urgent: an `awaiting_claim` row with no
\* witness and the refund not yet armed, and a `refunding_onchain` row whose
\* refund is still non-final.  Those are exactly the waits the code is
\* supposed to sit through, so the clock must be free to advance through them.
RefundStepAvailable(s) ==
    \/ (~BreakRefundRecheck /\ WitnessSeen(s))
    \/ ((BreakRefundRecheck \/ ~WitnessSeen(s)) /\ RefundBroadcastable(s))

Urgent(s) ==
    \/ st[s] = "none"                                     \* admission settles at clock 0
    \/ st[s] = "funded"                                   \* whenFunded funds or refuses now
    \/ st[s] = "funding_onchain"                          \* submit or adopt
    \/ (st[s] = "awaiting_claim"    /\ WitnessSeen(s))    \* P is on the chain, read it
    \/ (st[s] = "awaiting_claim"    /\ ~WitnessSeen(s) /\ RefundArmed)
    \/ (st[s] = "refunding_onchain" /\ RefundStepAvailable(s))
    \/ (st[s] = "claiming" /\ conf[s] = {} /\ serverUp)   \* the Arkade claim can be pushed
    \/ (st[s] = "claiming" /\ conf[s] # {})               \* the verdict must be recorded

SolverBehind == \E s \in Swaps : Urgent(s)

\* Wall clock.  Refuses to outrun median-time-past by more than MtpLag, which
\* is how (A1)'s bound is realised without a second fairness condition.
Tick ==
    /\ TickCore
    /\ ~SolverBehind
    /\ clock + 1 <= chainTime + MtpLag
    /\ UNCHANGED OsVars

\* Median-time-past catches up.  Monotone and never ahead of wall clock.
ChainTick ==
    /\ chainTime < clock
    /\ chainTime' = chainTime + 1
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED OsRest

--------------------------------------------------------------------------
(***************************************************************************)
(* WORKER ACTIONS.  One named operator per orchestrator function, so the   *)
(* Go rewrite can be diffed against them one for one.                      *)
(***************************************************************************)

\* store.get(id) / findRecoverable(), and — when the handler is quote()
\* rather than a tick — `await store.committedSats()` in the same breath
\* (onchainOrchestrator.ts:175).  ALWAYS a separate step from the write that
\* follows it: every await in the TypeScript yields the event loop, and every
\* goroutine boundary in Go yields the scheduler.
ReadSwap(w, s) ==
    /\ ReadRowWith(w, s, Drivable,
           IF st[s] = "none"
             THEN (IF Exposure(NonTerminal) + Amount <= MaxExposed
                     THEN "capOk" ELSE "capFull")
             ELSE "none")
    /\ UNCHANGED OsVars

\* step() returned false with nothing to do, or the CAS was lost silently.
GiveUp(w) ==
    /\ loc[w].phase = "read"
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED OsVars

Crash(w) == CrashCore(w) /\ UNCHANGED OsVars

(***** quote() : src/send/onchainOrchestrator.ts:150-251 *******************)

\* insertQuote().  The partial UNIQUE index on payment_hash
\* (src/db/onchainSwaps.ts:193-194) makes the INSERT itself single-winner,
\* modelled by the CAS on "none".  There is NO equivalent backstop for the
\* exposure cap: with AtomicAdmission = FALSE the insert trusts the snapshot
\* verdict, which is today's TypeScript.  With TRUE the cap is re-checked by
\* the write that consumes it, which is what a Go rewrite must do.
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
    /\ UNCHANGED OsVars

(***** whenQuoted : src/send/onchainOrchestrator.ts:502-523 ****************)

\* arkade.findLockups() saw the exact amount, in time.  The indexer is allowed
\* to LAG: a worker may simply not take this action even though lockup[s]
\* holds (it takes GiveUp instead).  It may never fire without lockup[s] — the
\* indexer never invents an output.
SeeLockup(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ lockup[s]
    /\ ~LockupTimedOut
    /\ \/ CasWon(s, "quoted", "funded")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* Nothing arrived, or a full lockup arrived after DEFAULT_ONCHAIN_LOCKUP_
\* TIMEOUT.  Late funding is REFUSED, never honoured: htlc_locktime and
\* refund_locktime were both anchored at quote time, so a late lockup silently
\* shrinks every window downstream of it.
RefuseQuoted(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ LockupTimedOut
    /\ \/ CasWon(s, "quoted", "refused")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

(***** whenFunded : src/send/onchainOrchestrator.ts:527-537 ****************)

\* THE INTENT COMMIT.  `const won = await store.transition(...); if (!won)
\* return false` — the CAS runs BEFORE onchain.fund, and only the winner calls
\* submitFunding.  Note precisely what that buys and what it does not: it
\* gates ENTRY into funding_onchain, not OCCUPANCY of it, and the row stays
\* there for the whole duration of the RPC.  See SubmitFunding.
FundGate(w, s) ==
    /\ Saw(w, s, "funded")
    /\ FundGateOpen
    /\ \/ /\ CasWon(s, "funded", "funding_onchain")
          /\ Advance(w, "fundCommitted", "none")
       \/ /\ CasLost(s, "funded")
          /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* MIN_ONCHAIN_FUND_WINDOW declined.  Nothing has been broadcast, so this is a
\* refusal, not an incident — and `refused` is structurally unreachable from
\* every EXPOSED state, which is what makes refundSweep safe by construction.
RefuseFund(w, s) ==
    /\ Saw(w, s, "funded")
    /\ ~FundGateOpen
    /\ \/ CasWon(s, "funded", "refused")
       \/ CasLost(s, "funded")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

(***** submitFunding / recoverFunding : :539-601 ***************************)

\* TWO ENTRY POINTS, and this is the race the CAS does NOT cover.
\*   (a) the funded->funding_onchain winner, straight from whenFunded;
\*   (b) whenFundingOnchain's `!row.fundingTxid` recovery branch — which any
\*       worker may take, at any time, while the row sits in funding_onchain,
\*       and which falls through to a REAL fund whenever the chain read finds
\*       no output of exactly amountSats.
\* fundConf[s] = 0 is that read coming back empty.  It is empty both when
\* nothing was ever broadcast and when a broadcast is not yet visible, and the
\* code cannot tell those apart — which is the whole residual window.
\* `funding_txid IS NULL` needs no variable of its own: funding_txid and
\* funding_vout are written in the SAME UPDATE as the move out of
\* funding_onchain (:596-599, :587-590), so the column is a pure function of
\* the state — and that is itself the property that makes recoverFunding's
\* branch selection sound.  A Go rewrite that writes the txid in a separate
\* statement breaks this equivalence and needs the variable back.
CanSubmitFunding(w, s) ==
    \/ At(w, s, "fundCommitted")
    \/ (Saw(w, s, "funding_onchain") /\ fundConf[s] = 0)

\* IRREVERSIBLE.  Real Bitcoin leaves the solver's wallet, and neither backend
\* accepts an idempotency key (:544-556), so nothing except FundIsIdempotent
\* (A4) bounds how many times this fires.  The `fundOut >= 2` branch is the
\* model's counter cap, not a code behaviour: NoDoublePay has already failed
\* by then and the branch only exists so the action never becomes disabled and
\* fakes a livelock.
SubmitFunding(w, s) ==
    /\ CanSubmitFunding(w, s)
    /\ \/ /\ (FundIsIdempotent \/ fundOut[s] >= 2)
          /\ fundOut[s] >= 1
          /\ UNCHANGED fundOut
       \/ /\ ~(FundIsIdempotent /\ fundOut[s] >= 1)
          /\ fundOut[s] < 2
          /\ fundOut' = [fundOut EXCEPT ![s] = fundOut[s] + 1]
    /\ Advance(w, "fundCalled", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << chainTime, lockup, fundConf, l1 >>

\* funding_txid AND funding_vout are written in the SAME UPDATE as the state
\* change (:596-599), so a lost CAS records nothing — which is what leaves the
\* row re-drivable through recoverFunding rather than half-written.
RecordFunding(w, s) ==
    /\ At(w, s, "fundCalled")
    /\ \/ CasWon(s, "funding_onchain", "awaiting_claim")
       \/ CasLost(s, "funding_onchain")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* recoverFunding's happy path: ask the CHAIN what already happened rather
\* than trusting process memory, and adopt the txid/vout of an output for
\* exactly amountSats.  The amount filter is load-bearing anti-grief and is
\* abstracted here into "this is our own funding output" — see the header.
AdoptFunding(w, s) ==
    /\ Saw(w, s, "funding_onchain")
    /\ fundConf[s] >= 1
    /\ \/ CasWon(s, "funding_onchain", "awaiting_claim")
       \/ CasLost(s, "funding_onchain")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

(***** whenAwaitingClaim : src/send/onchainOrchestrator.ts:607-636 *********)

\* THE ONLY WAY THE SOLVER EVER LEARNS P ON THIS CORRIDOR.  The client's claim
\* spend carries the preimage on its witness; the row records it in the SAME
\* UPDATE as the move to `claiming`, so from there the Arkade claim needs
\* nothing external.  P is MONOTONE KNOWLEDGE — nothing can un-reveal it.
SeeClaim(w, s) ==
    /\ Saw(w, s, "awaiting_claim")
    /\ ClaimWitness(s)
    /\ \/ CasWon(s, "awaiting_claim", "claiming")
       \/ CasLost(s, "awaiting_claim")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* Nothing has spent the outpoint and the timeout has matured past the MTP
\* margin.  Entering refunding_onchain is a one-way door: LEGAL_EDGES has no
\* way back to awaiting_claim, which is why the re-check below matters so much.
ArmRefund(w, s) ==
    /\ Saw(w, s, "awaiting_claim")
    /\ ~WitnessSeen(s)
    /\ RefundArmed
    /\ \/ CasWon(s, "awaiting_claim", "refunding_onchain")
       \/ CasLost(s, "awaiting_claim")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

(***** whenClaiming : src/send/onchainOrchestrator.ts:638-662 **************)

\* arkade.claim() is submitted and the Arkade server co-signs it.  IRREVERSIBLE
\* AND IT HAPPENS BEFORE THE CAS (:651-652).  Two workers may both be in
\* `claiming` and both submit; the server accepts exactly one (SpendAccepted
\* requires conf = {}), which is why the double claim costs bookkeeping and
\* not money.
ArkadeClaimAccepted(w, s) ==
    /\ Saw(w, s, "claiming")
    /\ serverUp
    /\ conf[s] = {}
    /\ conf' = [conf EXCEPT ![s] = { "solverClaim" }]
    /\ Advance(w, "claimSent", "none")
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED OsVars

\* The ONLY edge into `claimed`, and it holds our own claim txid.  Its return
\* value is IGNORED in the TypeScript (:652), so a lost CAS silently discards
\* claim_ark_txid — modelled by CasLost simply passing.
RecordArkadeClaim(w, s) ==
    /\ At(w, s, "claimSent")
    /\ \/ CasWon(s, "claiming", "claimed")
       \/ CasLost(s, "claiming")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* THE DELIBERATE FALSE NEGATIVE.  arkade.findLockups() returned [].  "Empty"
\* is NOT "claimed": the read is spendableOnly (src/arkade/wallet.ts:133-136,
\* getVtxos({ spendableOnly: true })) and answers [] for a swept, renewed or
\* lagging vtxo exactly as it does after our own spend.  This corridor has NO
\* lockupProvablySpent second read here, unlike pushRefund
\* (onchainOrchestrator.ts:313-317) — so indexer lag alone can produce this
\* `stuck` row even without a crash.
\*
\* (A7) IS THE KNOB FOR EXACTLY THAT.  LockupReadIsReliable = TRUE keeps the
\* `Spent(s)` precondition, which is an IDEALISATION and not the TypeScript:
\* whenClaiming (:645-649) fails the row on the empty read alone, with no
\* second read and no spend test.  Setting it FALSE is the code, and
\* OnchainSend_LaggingLockupRead.cfg shows what that costs.
ClaimSeesEmpty(w, s) ==
    /\ Saw(w, s, "claiming")
    /\ (LockupReadIsReliable => Spent(s))
    /\ \/ CasWon(s, "claiming", "stuck")
       \/ CasLost(s, "claiming")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* arkade.claim() threw because the Arkade server will not co-sign.  STRICTLY
\* BEFORE refund_locktime the exception is RETHROWN with no transition and the
\* next sweep retries.  Past it, a persistently failing claim means the server
\* is censoring while the client's refund path is open and racing us, and this
\* service has no server-independent exit yet.
ClaimRefused(w, s) ==
    /\ Saw(w, s, "claiming")
    /\ ~serverUp
    /\ conf[s] = {}
    /\ IF clock >= RefundLocktime
         THEN \/ CasWon(s, "claiming", "stuck")
              \/ CasLost(s, "claiming")
         ELSE UNCHANGED st
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

(***** whenRefundingOnchain : src/send/onchainOrchestrator.ts:671-712 ******)

\* THE BACK EDGE, AND THE MOST IMPORTANT ACTION IN THIS MODULE.
\*
\* The client landed a valid claim after the solver had already committed to
\* refunding.  Losing the L1 race costs NOTHING: the winning claim hands the
\* solver P on its witness, which is exactly what the Arkade lockup needs.
\*
\* Without this re-read (BreakRefundRecheck = TRUE) the row retries a doomed
\* double-spend forever — LEGAL_EDGES offers no other way back to `claiming` —
\* P is never recovered, the Arkade lockup is never claimed, and the client
\* unilaterally refunds that same lockup once refund_locktime passes.  Net:
\* the solver pays out onchain AND loses the lockup.  That is the code's own
\* comment at :678-687, and OnchainSend_Broken.cfg reproduces it.
RefundSeesClaim(w, s) ==
    /\ Saw(w, s, "refunding_onchain")
    /\ ~BreakRefundRecheck
    /\ ClaimWitness(s)
    /\ \/ CasWon(s, "refunding_onchain", "claiming")
       \/ CasLost(s, "refunding_onchain")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* Spent by something that is not a recognisable claim — most likely our OWN
\* refund from an earlier attempt that broadcast successfully but crashed
\* before the transition recorded it.  Routed to a human, because witness
\* shape alone cannot tell that apart from anything else.
RefundSeesAlien(w, s) ==
    /\ Saw(w, s, "refunding_onchain")
    /\ ~BreakRefundRecheck
    /\ AlienWitness(s)
    /\ \/ CasWon(s, "refunding_onchain", "stuck")
       \/ CasLost(s, "refunding_onchain")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

\* IRREVERSIBLE AND IT HAPPENS BEFORE THE CAS.  A broadcast that the node
\* refuses (non-final, or conflicting with something already relayed) THROWS,
\* which the TypeScript treats as transient: the row stays in
\* refunding_onchain and the next tick's re-check is what recovers it.  That
\* is modelled by this action simply being disabled.
BroadcastRefund(w, s) ==
    /\ Saw(w, s, "refunding_onchain")
    /\ (BreakRefundRecheck \/ ~WitnessSeen(s))     \* the pre-broadcast re-read
    /\ RefundBroadcastable(s)
    /\ l1' = [l1 EXCEPT ![s] = IF l1[s] = "unspent" THEN "refundSeen"
                                                    ELSE "contested"]
    /\ Advance(w, "refundSent", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << chainTime, lockup, fundOut, fundConf >>

\* `refunded` RECORDS A BROADCAST, NOT A CONFIRMATION, and it is terminal and
\* absent from NON_TERMINAL, so findRecoverable() never returns the row again.
\* Whether that is safe is exactly the question MempoolExclusive (A3) settles.
RecordRefunded(w, s) ==
    /\ At(w, s, "refundSent")
    /\ \/ CasWon(s, "refunding_onchain", "refunded")
       \/ CasLost(s, "refunding_onchain")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED OsVars

--------------------------------------------------------------------------
(***************************************************************************)
(* THE NEXT-STATE RELATION                                                 *)
(***************************************************************************)

(***************************************************************************)
(* FAIRNESS GROUPS.                                                        *)
(*                                                                         *)
(* SwapCore's trap T3: TLC's ceiling on temporal actions is low, so        *)
(* fairness is stated over as few actions as is SOUND.  Soundness has a    *)
(* precise meaning (T2): SF on a group equals SF on each member ONLY IF no *)
(* member can be taken infinitely often WITHOUT the swap advancing.        *)
(*                                                                         *)
(* DriveRow: every member ends in a compare-and-swap and parks.  The one   *)
(*   member that can be a no-op is ClaimRefused before refund_locktime —   *)
(*   and in the state where it is enabled (~serverUp /\ conf = {}) it is   *)
(*   the only enabled member, the swap is not Urgent, so WF(Tick) advances *)
(*   the clock and the same action then reaches `stuck`.                   *)
(*                                                                         *)
(* SubmitFunding and RecordFunding MUST stay outside it and outside each   *)
(*   other, for the same reason LightningSend splits SubmitPay/RecordPay:  *)
(*   a worker that crashes at phase fundCalled leaves the row still in     *)
(*   funding_onchain, so SubmitFunding becomes enabled again and a shared  *)
(*   group would be discharged forever by re-funding.                      *)
(*                                                                         *)
(* RefundPush and ArkadePush may each be grouped, because their            *)
(*   irreversible member fires AT MOST ONCE per swap: after BroadcastRefund*)
(*   the outpoint has a broadcast spend, so RefundBroadcastable is false    *)
(*   forever; after ArkadeClaimAccepted, conf # {} forever.  Neither can    *)
(*   discharge its group infinitely often.                                 *)
(***************************************************************************)
DriveRow(w, s) ==
    \/ InsertQuote(w, s)
    \/ SeeLockup(w, s)        \/ RefuseQuoted(w, s)
    \/ FundGate(w, s)         \/ RefuseFund(w, s)
    \/ AdoptFunding(w, s)
    \/ SeeClaim(w, s)         \/ ArmRefund(w, s)
    \/ ClaimSeesEmpty(w, s)   \/ ClaimRefused(w, s)
    \/ RefundSeesClaim(w, s)  \/ RefundSeesAlien(w, s)

\* The two irreversible broadcasts and the two transitions that record them.
\* Grouped for fairness, and the grouping is sound for a stronger reason than
\* usual: EVERY member of this group fires a BOUNDED number of times per swap.
\* BroadcastRefund is disabled forever once l1 leaves "unspent"/"claimSeen";
\* ArkadeClaimAccepted is disabled forever once conf # {}; and the two Record*
\* actions need phases only those two can set.  A group that cannot be taken
\* infinitely often cannot discharge its own fairness obligation vacuously.
PushSpend(w, s) ==
    \/ BroadcastRefund(w, s)     \/ RecordRefunded(w, s)
    \/ ArkadeClaimAccepted(w, s) \/ RecordArkadeClaim(w, s)

\* Everything a worker can do to swap s other than reading it or giving up.
Progress(w, s) ==
    \/ DriveRow(w, s)
    \/ SubmitFunding(w, s) \/ RecordFunding(w, s)
    \/ PushSpend(w, s)

\* Grouped for fairness only; see the obligation table above.
ChainConfirms(s) == ConfirmFunding(s) \/ ConfirmL1(s)

Next ==
    \/ \E w \in Workers :
          \/ \E s \in Swaps : ReadSwap(w, s) \/ Progress(w, s)
          \/ GiveUp(w)
          \/ Crash(w)
    \/ \E s \in Swaps :
          ClientFunds(s) \/ ClientClaimsL1(s) \/ ChainConfirms(s)
            \/ ClientRefundLockup(s)
    \/ Censor
    \/ Tick
    \/ ChainTick

Init ==
    /\ InitCore("none")
    /\ chainTime = 0
    /\ lockup    = [s \in Swaps |-> FALSE]
    /\ fundOut   = [s \in Swaps |-> 0]
    /\ fundConf  = [s \in Swaps |-> 0]
    /\ l1        = [s \in Swaps |-> "unspent"]

(***************************************************************************)
(* FAIRNESS.  Copy this shape; do not simplify it.  SwapCore's T1 (a       *)
(* conjunction inside a quantifier body is SILENTLY DROPPED) and T2 (SF on *)
(* a disjunction is discharged by any disjunct) both bite here.  Crash,    *)
(* Censor, ClientFunds, ClientClaimsL1 and ClientRefundLockup are          *)
(* deliberately UNFAIR — the environment owes us nothing.                  *)
(***************************************************************************)
\* FOURTEEN conditions after expansion, which is already at SwapCore's trap
\* T3 ceiling: the first version of this block had EIGHTEEN and the JVM was
\* killed part-way through building the liveness graph on ~390,000 states.
\* Everything merged below fires a BOUNDED number of times per swap, so the
\* merge cannot discharge an obligation vacuously; nothing that can repeat
\* forever (ReadSwap, DriveRow, SubmitFunding, RecordFunding) is merged.
Fairness ==
    /\ \A w \in Workers : WF_vars(GiveUp(w))
    /\ WF_vars(\E s \in Swaps : ChainConfirms(s))
    /\ WF_vars(Tick \/ ChainTick)
    \* "some worker eventually does this for this swap".  The \E is over
    \* WORKERS, never over swaps: swaps must each be driven, workers are
    \* interchangeable.
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ReadSwap(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : DriveRow(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : SubmitFunding(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : RecordFunding(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : PushSpend(w, s))

Spec == Init /\ [][Next]_vars /\ Fairness

--------------------------------------------------------------------------
(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypeOK ==
    /\ TypeOKCore(AllSt)
    /\ chainTime \in 0..MaxClock
    /\ lockup    \in [Swaps -> BOOLEAN]
    /\ fundOut   \in [Swaps -> 0..2]
    /\ fundConf  \in [Swaps -> 0..MinConfirmations]
    /\ l1        \in [Swaps -> L1Status]

\* Every state change is an edge of LEGAL_EDGES.  An ACTION property.
ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars

\* The irreversible outbound side effect happens at most once per swap.
\* NOT guaranteed by the compare-and-swap: the CAS gates ENTRY into
\* funding_onchain, and the row stays there for the whole RPC.
NoDoublePay == \A s \in Swaps : fundOut[s] <= 1

\* BOTH contested outputs.  The Arkade lockup is claimed or refunded, never
\* both (SwapCore's set-valued `conf`).  The L1 HTLC is claimed or refunded,
\* never both — that half is the UTXO model rather than a policy choice, and
\* because L1Status encodes it as an enumeration the real content is that the
\* verdict is ABSORBING: once the chain has confirmed one spend, nothing —
\* not a competing broadcast, not a worker, not the clock — moves it.  An
\* ACTION property, so a fudged ConfirmL1 would be caught rather than assumed
\* away.
AtMostOneOutcome == AtMostOneOutcomeInv

L1OutcomeIsFinal ==
    [][ \A s \in Swaps : L1Settled(s) => l1'[s] = l1[s] ]_vars

ExposureBounded == ExposureBoundedBy(NonTerminal)

\* THE money invariant: if the client took the solver's L1 sats, the solver
\* has not collected the Arkade lockup, and the machine has stopped, then a
\* human is being paged.  On this corridor it reduces to one question, and it
\* is the sharpest one here: IS `refunded` A SAFE TERMINAL STATE?  `claimed`
\* implies Collected, and `refused`/`rejected` are unreachable once anything
\* was funded, so `refunded` is the only terminal that can violate it.
NoSilentLoss == NoSilentLossShape(PaidOut, Collected, Terminal, "stuck")

\* THE loss the pre-broadcast re-read exists to prevent, in the words of its
\* own comment: the solver pays out onchain AND loses the lockup.  This is the
\* invariant the mandated mutation breaks, and it bites while the row is still
\* NON-terminal, which is why NoSilentLoss alone would not catch it.
NoNetLoss == \A s \in Swaps : ~(ClientTookL1(s) /\ ClientTookLockup(s))

\* Structural consequence of the edge table that refundSweep depends on:
\* `refused` must be unreachable from every EXPOSED state, so the automatic
\* sweep (src/db/onchainSwaps.ts:396-404, state='refused' ONLY) can never
\* select a swap whose L1 sats have already gone out.  Asserted as a theorem
\* over the table rather than trusted.
RefusedUnreachableFromExposed ==
    \A x \in Exposed : "refused" \notin Edges[x]

\* Same table-assertion discipline, for the opposite direction: every EXPOSED
\* state must carry an escalation to `stuck` in the edge table, so
\* store.fail() from an exposed row always has somewhere legal to go.
\* transition() THROWS on a non-edge, so a missing one would surface as an
\* exception inside a tick rather than as a refusal.  The pin is about the
\* table itself: a future edit that drops a -> stuck edge from an exposed
\* row, or adds an exposed state without one, fails every cfg loudly.  (The
\* `-coverage` argument proves actions were TAKEN, not that stuck is
\* REACHABLE FROM every exposed state; see #218/#234.)
StuckReachableFromEveryExposed ==
    \A x \in Exposed : "stuck" \in Edges[x]

\* Median-time-past is monotone, never ahead of wall clock, and never further
\* behind than MtpLag.  (A1) as a checkable fact rather than a comment.
ChainTimeSane == chainTime <= clock /\ clock <= chainTime + MtpLag

Liveness == EventuallyTerminal(Terminal)

(***************************************************************************)
(* Swap ids and worker ids are interchangeable.  Symmetry would cut the    *)
(* state space by |Swaps|! * |Workers|! = 4, and is DELIBERATELY NOT USED: *)
(* SwapCore's trap T4 — TLC's symmetry reduction is unsound in the         *)
(* presence of per-swap fairness conditions.  `Perms` is defined only so   *)
(* the temptation is visible and refused in one place.                     *)
(***************************************************************************)
Perms == Permutations(Swaps) \cup Permutations(Workers)

(***************************************************************************)
(* MUTATION CHECKS — RESULTS                                               *)
(*                                                                         *)
(* A spec that passes because it is too weak to fail is worse than none.   *)
(* Six guards were broken one at a time, each by a single constant, each   *)
(* with its own .cfg.  FIVE produce a counterexample; the sixth is shipped *)
(* precisely BECAUSE it does not, and that is a finding about the guard    *)
(* rather than a hole in the invariants.                                   *)
(*                                                                         *)
(*   OnchainSend_Broken.cfg        BreakRefundRecheck = TRUE               *)
(*                                 -> NoNetLoss violated, 23 states, 5s    *)
(*   OnchainSend_MempoolRace.cfg   MempoolExclusive   = FALSE              *)
(*                                 -> NoSilentLoss violated, 24 states, 5s *)
(*   OnchainSend_DoubleFund.cfg    FundIsIdempotent   = FALSE              *)
(*                                 -> NoDoublePay violated, 11 states, 1s  *)
(*   OnchainSend_Overexposed.cfg   AtomicAdmission = FALSE, MaxExposed = 1 *)
(*                                 -> ExposureBounded violated, 5 states,1s*)
(*   OnchainSend_LaggingLockupRead.cfg                                     *)
(*                                 LockupReadIsReliable = FALSE   see (A7) *)
(*                                 -> NoNetLoss violated, 25 states, 6s    *)
(*   OnchainSend_RefundTiming.cfg  BreakRefundTiming  = TRUE               *)
(*                                 -> NO ERROR.  See below.                *)
(*                                                                         *)
(* Control: OnchainSend_OverexposedControl.cfg is the Overexposed model    *)
(* with AtomicAdmission = TRUE and is green, so folding the cap into the   *)
(* write that consumes it is proven SUFFICIENT, not merely plausible.      *)
(*                                                                         *)
(* THE MANDATED ONE, IN FULL.  OnchainSend_Broken.cfg removes only the     *)
(* pre-broadcast findSpendWitness re-read from whenRefundingOnchain        *)
(* (src/send/onchainOrchestrator.ts:678-704).  23 states:                  *)
(*                                                                         *)
(*   1-6   both swaps quoted at clock 0 (two workers, interleaved reads    *)
(*         and inserts)                                                    *)
(*   7     ClientFunds(s1)      the client locks up on Arkade              *)
(*   8     SeeLockup(s1)        quoted -> funded                           *)
(*   9-10  ReadSwap, FundGate   funded -> funding_onchain.  THE INTENT     *)
(*                              COMMIT: the CAS is won BEFORE the money    *)
(*                              moves, and only the winner proceeds.       *)
(*   11    SubmitFunding        onchain.fund.  fundOut[s1] = 1.  Real      *)
(*                              Bitcoin has left the solver's wallet.      *)
(*   12    RecordFunding        funding_onchain -> awaiting_claim, with    *)
(*                              funding_txid/vout in the same UPDATE       *)
(*   14    ConfirmFunding       the funding output reaches depth 1, which  *)
(*                              is the depth the quote promised the client *)
(*   15-17 Tick, ChainTick,     clock 0 -> 2, median-time-past 0 -> 1.     *)
(*         Tick                 Nothing is Urgent: the client has not      *)
(*                              claimed and the refund is not yet armed.   *)
(*   18    ArmRefund(s1)        clock 2 = HtlcLocktime 1 + margin 1, so    *)
(*                              awaiting_claim -> refunding_onchain.  A    *)
(*                              ONE-WAY DOOR: LEGAL_EDGES has no way back. *)
(*   19    ClientClaimsL1(s1)   THE CLAIM LEAF HAS NO TIMELOCK.  The       *)
(*                              client broadcasts a perfectly valid claim  *)
(*                              in the same instant, before the solver's   *)
(*                              refund goes out.                           *)
(*   20    ConfirmL1(s1)        the chain confirms the CLIENT's claim.     *)
(*                              l1[s1] = "claimed": the solver's L1 sats   *)
(*                              are gone and P is on that witness, in      *)
(*                              public, for anyone who looks.              *)
(*   21-22 ChainTick, Tick      clock 2 -> 3.  The solver's own refund can *)
(*                              never be broadcast now (the outpoint is    *)
(*                              spent), and WITHOUT THE RE-READ there is   *)
(*                              no action that can move the row: it is     *)
(*                              parked in refunding_onchain, retrying a    *)
(*                              double-spend that can never confirm.       *)
(*   23    ClientRefundLockup   clock 3 = RefundLocktime, so the client's  *)
(*                              refundWithoutReceiver leaf on the ARKADE   *)
(*                              side opens and the server co-signs it.     *)
(*                                                                         *)
(*   Final state: l1[s1] = "claimed" /\ conf[s1] = {"clientRefund"}        *)
(*   NoNetLoss violated.  The client has the solver's onchain sats AND     *)
(*   their own Arkade lockup back.  Both legs gone, which is word for word *)
(*   what the deleted code's comment says it exists to prevent.            *)
(*                                                                         *)
(*   Note what the counterexample does NOT need: no crash, no lost         *)
(*   compare-and-swap, no concurrent double-anything.  And note that       *)
(*   NoSilentLoss does not fire — the row never becomes terminal at all.   *)
(*   A spec that only asked about terminal states would have missed this,  *)
(*   which is why both money invariants are carried.                       *)
(*                                                                         *)
(* THE SECOND-SHARPEST ONE.  OnchainSend_MempoolRace.cfg, 24 states.  The  *)
(* first 18 are identical; then:                                           *)
(*                                                                         *)
(*   19-21 ReadSwap, ChainTick, the re-read finds NOTHING (l1 "unspent"),  *)
(*         BroadcastRefund      so the solver broadcasts its refund — but  *)
(*                              only once median-time-past has passed      *)
(*                              htlc_locktime STRICTLY (chainTime 2 >      *)
(*                              HtlcLocktime 1), which is the extra state. *)
(*   22    RecordRefunded       refunding_onchain -> `refunded`, TERMINAL. *)
(*                              findRecoverable() will never return this   *)
(*                              row again.                                 *)
(*   23    ClientClaimsL1       the client's claim is relayed anyway and   *)
(*                              REPLACES the refund — which is exactly     *)
(*                              what src/onchain/refund.ts invites by      *)
(*                              setting sequence 0xfffffffd (nLockTime     *)
(*                              enabled AND opt-in RBF; 0xfffffffe would   *)
(*                              enable the locktime without the second).   *)
(*   24    ConfirmL1            the chain confirms the CLAIM.              *)
(*                                                                         *)
(*   Final state: st[s1] = "refunded" /\ l1[s1] = "claimed" /\ conf = {}   *)
(*   NoSilentLoss violated.  The row says the solver refunded; the chain   *)
(*   says the client claimed.  P was revealed on a witness nobody will     *)
(*   ever read, the Arkade lockup is never claimed, and NOTHING PAGES A    *)
(*   HUMAN.  `refunded` records a broadcast, not a confirmation.           *)
(*                                                                         *)
(* THE ONE THAT STAYS GREEN, AND WHY THAT IS THE RIGHT ANSWER.             *)
(* OnchainSend_RefundTiming.cfg drops HTLC_REFUND_MTP_MARGIN and the       *)
(* htlc_locktime check entirely, so the solver may arm and try to          *)
(* broadcast its refund at any instant.  TLC completes with no error       *)
(* (499,382 distinct states in the safety-only configuration).  That is    *)
(* not a weak invariant; it is what the margin actually buys:              *)
(*                                                                         *)
(*   (1) transaction validity.  A refund whose nLockTime has not matured   *)
(*       against MTP is rejected by every mempool, which the TypeScript    *)
(*       treats as a TRANSIENT fault — the throw propagates, the row stays *)
(*       in refunding_onchain, and the next tick retries.  Modelled as     *)
(*       BroadcastRefund simply being disabled.  Costs retries, not money. *)
(*   (2) not colliding with a still-legitimate client claim.  Losing that  *)
(*       collision costs the CLIENT their swap and costs the solver        *)
(*       nothing, because the back-edge hands it P either way.             *)
(*                                                                         *)
(* So WITHIN THIS MODEL the margin is a validity-and-courtesy guard.  That *)
(* is a much weaker statement than "the margin is not a money guard", and  *)
(* the earlier draft of this block overclaimed it.  See (A2): `Urgent`     *)
(* forbids wall clock from advancing while a row sits in `claiming` with   *)
(* the lockup unspent, which makes the solver's Arkade claim take ZERO     *)
(* modelled time and so makes EVERY timing guard on this corridor          *)
(* unfalsifiable — not just this one.  The control for that reading is the *)
(* one measured in (A2): delete only the `claiming` disjunct of `Urgent`,  *)
(* leave every guard including this one in place, and NoNetLoss falls in   *)
(* 23 states.  A green BreakRefundTiming run is therefore evidence about   *)
(* (A2) and not about HTLC_REFUND_MTP_MARGIN.                              *)
(*                                                                         *)
(* WHAT DOES HOLD unconditionally: the two guards that produce             *)
(* counterexamples above — the pre-broadcast re-read and the terminality   *)
(* of `refunded` — protect the solver's money against an adversary with no *)
(* timing power at all, which is the stronger claim of the two.            *)
(*                                                                         *)
(* AUDIT ADDENDA (independent re-run, all cfgs reproduced as documented):  *)
(*                                                                         *)
(*   OnchainSend_LaggingLockupRead.cfg  LockupReadIsReliable = FALSE       *)
(*                                 -> NoNetLoss violated, 25 states.       *)
(*                                 (A7): the sixth mutation, and the only  *)
(*                                 one that needs neither a crash, a lost  *)
(*                                 CAS, nor two workers.                   *)
(*                                                                         *)
(*   FundGateOpen deleted from FundGate -> NO ERROR, 711,946 distinct.     *)
(*                                 Not shipped as a cfg because it is not  *)
(*                                 a finding about the guard; see (A2).    *)
(*                                                                         *)
(*   ClientClaimsL1 without its `fundConf >= MinConfirmations` wait — an   *)
(*                                 adversarial client claiming at zero     *)
(*                                 confirmations — is GREEN, so (A6)'s     *)
(*                                 restriction on the client is not        *)
(*                                 load-bearing for any invariant here.    *)
(*                                                                         *)
(*   VACUITY.  A -coverage run of OnchainSend.cfg reaches every action,    *)
(*   including RefundSeesClaim (32,480 times), but leaves FOUR             *)
(*   subexpressions at zero: the three `contested` branches (expected,     *)
(*   MempoolExclusive = TRUE, and marked as such on L1Status) and          *)
(*   InsertQuote's `ELSE ... "rejected"`.  That last one matters:          *)
(*   MaxExposed = 2 with two swaps of Amount = 1 makes                     *)
(*   Exposure(NonTerminal) <= 2 a THEOREM, so ExposureBounded cannot fail  *)
(*   in OnchainSend.cfg (nor in OnchainSend_Liveness.cfg, MaxExposed = 1   *)
(*   on one swap) and `rejected` is unreachable in both.  The invariant    *)
(*   earns its keep only in OnchainSend_Overexposed.cfg and its control;   *)
(*   it is left listed in the other cfgs as a regression guard, not as     *)
(*   evidence.                                                             *)
(***************************************************************************)
=============================================================================
