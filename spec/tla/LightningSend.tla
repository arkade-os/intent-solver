----------------------------- MODULE LightningSend -----------------------------
(***************************************************************************)
(* LIGHTNING SEND CORRIDOR   arkade:BTC -> lightning:BTC                   *)
(*                                                                         *)
(* WHICH TYPESCRIPT THIS SPECIFIES                                         *)
(*                                                                         *)
(*   packages/solver-corridors/src/                                        *)
(*     db/swaps.ts           the durable row, LEGAL_EDGES, transition(),   *)
(*                           patch(), fail(), committedSats()              *)
(*     send/orchestrator.ts  the whole state machine: step(), whenQuoted,  *)
(*                           whenFunded, whenPaying, submitPayment,        *)
(*                           claimWithPreimage, whenPaid,                  *)
(*                           settleFromBackend, whenClaiming, tick(),      *)
(*                           tickAll(), tickHot(), driveRows()             *)
(*     send/arkadeOps.ts     claim() and assertScriptMatchesRow            *)
(*   packages/solver-core/src/                                             *)
(*     core/send.ts          MIN_INVOICE_WINDOW, MIN_CLAIM_WINDOW,         *)
(*                           DEFAULT_LOCKUP_TIMEOUT, evaluateSendPayment,  *)
(*                           refundLocktimeFor, worstCaseHtlcBlocks        *)
(*     core/timelocks.ts     absoluteLocktimeSeconds, the height-typed     *)
(*                           deadline's conversion to wall seconds         *)
(*   packages/solver-rails-lnd/src/                                        *)
(*     ln/lnd/adapter.ts     FAILED_PAYMENT_REASONS — the terminal-failure *)
(*                           ALLOWLIST that decides what "failed" means    *)
(*   packages/solver-app/src/                                              *)
(*     worker.ts             the queue fan-out and its safety claim        *)
(*     ops/claims.ts         claimNow, the operator's stuck -> claiming    *)
(*     ops/refunds.ts        refundNow, the operator's stuck -> refused    *)
(*                                                                         *)
(* AUTHORITY FOR THE EDGE TABLE                                            *)
(*                                                                         *)
(* LEGAL_EDGES in db/swaps.ts, verbatim:                                   *)
(*                                                                         *)
(*   quoted:   ['funded', 'refused']                                       *)
(*   funded:   ['paying', 'claiming', 'refused']                           *)
(*   paying:   ['paid', 'stuck', 'refused']                                *)
(*   paid:     ['claiming', 'stuck', 'refused']                            *)
(*   claiming: ['claimed', 'stuck']                                        *)
(*   claimed:  []                                                          *)
(*   refused:  []                                                          *)
(*   stuck:    ['claiming', 'refused']                                     *)
(*                                                                         *)
(* plus NON_TERMINAL and EXPOSED, declared just above it                   *)
(*   NON_TERMINAL = quoted funded paying paid claiming                     *)
(*   EXPOSED      = paying paid claiming                                   *)
(*                                                                         *)
(* `Edges` below adds exactly two edges the TypeScript does not have —     *)
(* none -> {quoted, rejected} and rejected -> {} — which model quote()'s   *)
(* INSERT-or-refuse.  In the TypeScript that is a row appearing or not     *)
(* appearing, not a transition.  They are marked in the definition.        *)
(* Everything else is diffable line for line against LEGAL_EDGES.          *)
(*                                                                         *)
(* THE STRUCTURAL FACT THIS CORRIDOR IS DEFINED BY                         *)
(*                                                                         *)
(* There is no `refunding` state here, and that is not an omission.  The   *)
(* solver never refunds a swap it has paid: findRefundable in db/swaps.ts  *)
(* selects state='refused' only.  That used to be made safe by the SHAPE   *)
(* of the table — `refused` was unreachable from every EXPOSED state — and *)
(* it is not any more.  LEGAL_EDGES' `paying` and `paid` rows, and the     *)
(* proof comment above them, added paying/paid -> refused behind PROOF     *)
(* that the sats never left, so what keeps findRefundable safe is now the  *)
(* proof and not the shape.  It is checked as `RefusedNeverPaid` over the  *)
(* payment variable rather than asserted over `Edges`; see                 *)
(* ProofSatsNeverLeft.                                                     *)
(*                                                                         *)
(* The competing spend is EXTERNALISED — the client's own                  *)
(* refundWithoutReceiver leaf races the solver's claim leaf after          *)
(* refund_locktime — and the solver's defence is temporal                  *)
(* (MIN_CLAIM_WINDOW), not a transition.  That race is                     *)
(* `ClientRefundLockup` below, and MIN_CLAIM_WINDOW is the guard the       *)
(* mutation check breaks.                                                  *)
(*                                                                         *)
(* WHAT IS DELIBERATELY ABSTRACTED AWAY                                    *)
(*                                                                         *)
(*  - Amounts and overfunding.  Every swap is `Amount` sats and a lockup   *)
(*    is exactly right or absent.  The overfund refusal                    *)
(*    (orchestrator.ts:468-471) protects the CLIENT, not the solver's      *)
(*    money invariant, so it is out of scope here.                         *)
(*  - The preimage column.  The code writes P in the SAME UPDATE as        *)
(*    paid->claiming, so `st[s] = "claiming"` already means "P is on disk  *)
(*    and the claim needs nothing external".  A separate variable would    *)
(*    only be able to disagree with the state, which the code prevents.    *)
(*  - preimageMatchesHash.  A backend that returns a preimage which does   *)
(*    not hash to the payment hash is a compromised backend; the code      *)
(*    routes it to `stuck`.  Modelling it adds a paid-and-uncollected      *)
(*    terminal that `stuck` already covers, and adds a loss no guard in    *)
(*    this corridor addresses.  See the report.                            *)
(*  - The payInvoice-response preimage shortcut (orchestrator.ts:574).     *)
(*    It is a latency optimisation over the getPayment poll; both are      *)
(*    LearnPreimage here.                                                  *)
(*  - The event log, column allowlists, the idempotency-key STRING.  The   *)
(*    key is DERIVED from the payment hash, so every process computes it   *)
(*    identically; what matters is whether the BACKEND honours it, which   *)
(*    is the constant BackendHonoursIdempotency.                           *)
(*                                                                         *)
(* MODELLING DECISIONS THAT ARE ASSUMPTIONS, NOT FACTS                     *)
(*                                                                         *)
(*  (A1) HtlcMaxLifetime.  An in-flight Lightning payment must resolve     *)
(*       within HtlcMaxLifetime ticks.  This is not charity: it is         *)
(*       maxCltvBlocks = worstCaseHtlcBlocks(minFinalCltv) which LND       *)
(*       ENFORCES as max_timeout_height (src/ln/lnd/adapter.ts:194-205),   *)
(*       and it is the same number refundLocktimeFor priced the deadline   *)
(*       against (src/core/send.ts:111-129).  ASSUME below requires        *)
(*       HtlcMaxLifetime < MinClaimWindow, which IS the design constraint. *)
(*       On a backend with no way to express that ceiling, the assumption  *)
(*       is only a hope, and that is a finding, not a model bug.           *)
(*                                                                         *)
(*  (A2) The drive loop keeps up.  `Tick` is disabled while any swap has   *)
(*       an immediately-completable solver step outstanding (`Urgent`).    *)
(*       Without this, "the solver stopped for 90 minutes" is a trace and  *)
(*       every timing guard looks broken.  A stopped solver loses money    *)
(*       regardless of any guard; that is an operational property, not a   *)
(*       protocol one.  Crucially this does NOT weaken the concurrency     *)
(*       model: workers still race, crash mid-action, lose CASes and       *)
(*       double-broadcast — all of that happens WITHIN a frozen tick.      *)
(*                                                                         *)
(*  (A3) The Arkade server is either cooperative or permanently censoring  *)
(*       (SwapCore!CensorCore).  See that module's comment.                *)
(*                                                                         *)
(*  (A4) The client's covenant refund becomes possible at exactly          *)
(*       RefundLocktime on the model clock.  In reality it matures against *)
(*       median-time-past, which LAGS wall clock by ~1h — so the real      *)
(*       client can only be LATER than this.  Modelling the earliest       *)
(*       legal instant is the conservative direction for the solver.       *)
(*       MIN_CLAIM_WINDOW is 90 minutes precisely to cover that lag        *)
(*       (src/core/send.ts:38-44); the model collapses the lag into the    *)
(*       constant ordering HtlcMaxLifetime < MinClaimWindow.               *)
(*                                                                         *)
(* WHAT A GO IMPLEMENTER MUST PRESERVE                                     *)
(*                                                                         *)
(*  1. funded -> paying is committed BEFORE ln.payInvoice, and the         *)
(*     idempotency key is written in the SAME UPDATE.  See PayGate.        *)
(*  2. The recovery branch is chosen from the ROW (`payment_id IS NULL`),  *)
(*     never from process memory.  See SubmitPay's two entry points.       *)
(*  3. claiming -> claimed is the ONLY edge that records success, and it   *)
(*     requires the solver's own claim txid.  An empty indexer read is     *)
(*     never evidence of anything good.  See ClaimSeesEmpty.               *)
(*  4. The exposure cap must be enforced by the same write that consumes   *)
(*     it.  See AtomicAdmission and LightningSend_Overexposed.cfg.         *)
(*  5. Backend idempotency is load-bearing and is NOT provided by the      *)
(*     database.  See BackendHonoursIdempotency and                        *)
(*     LightningSend_DoublePay.cfg.                                        *)
(*  6. paying/paid -> refused is legal ONLY on proof the sats never left,  *)
(*     and the payment id must land in the SAME step, because that is what *)
(*     shuts whenPaying's recovery branch against a row just refused.  See *)
(*     RecordPay and RefusedNeverPaid.                                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC, SwapCore

CONSTANTS
    RefundLocktime,             \* refund_locktime: the client's refund path opens
    MinClaimWindow,             \* MIN_CLAIM_WINDOW      (90 min)
    MinInvoiceWindow,           \* MIN_INVOICE_WINDOW    (2 min)
    InvoiceExpiry,              \* invoice_expires_at
    LockupDeadline,             \* created_at + DEFAULT_LOCKUP_TIMEOUT (15 min)
    HtlcMaxLifetime,            \* see (A1)
    BreakClaimWindow,           \* MUTATION: drop the MIN_CLAIM_WINDOW conjunct
    BackendHonoursIdempotency,  \* MUTATION: the Lightning backend dedups by key
    AtomicAdmission,            \* MUTATION: quote() is one conditional INSERT
    IndexerNeverLies            \* MUTATION: findLockups may report [] for a live lockup

(***************************************************************************)
(* The constant ordering is the whole content of the timing guards.        *)
(* HtlcMaxLifetime < MinClaimWindow is the design constraint (A1).         *)
(***************************************************************************)
ASSUME HtlcMaxLifetime < MinClaimWindow   \* (A1): the design constraint
ASSUME MinClaimWindow <= RefundLocktime
ASSUME RefundLocktime <= MaxClock
\* The model realises HtlcMaxLifetime as exactly one tick (the `payAged` flag),
\* which keeps the clock dimension out of the payment variables.  The constant
\* is kept so the ordering above stays visible and checkable; raising it means
\* raising MinClaimWindow with it.
ASSUME HtlcMaxLifetime = 1

VARIABLES
    lockup,     \* [Swaps -> BOOLEAN] the client's Arkade lockup exists at pk_script
    pay,        \* [Swaps -> "none"|"inflight"|"succeeded"|"failed"] the LN payment.
                \* This is the BACKEND's authoritative answer for the swap's derived
                \* idempotency key, not one call's return value.
    payAged,    \* [Swaps -> BOOLEAN] a tick has passed since the payment went in
                \* flight.  This is HtlcMaxLifetime = 1 tick; see (A1).
    payMoney,   \* [Swaps -> 0..2] payments the BACKEND actually created. >1 == double pay.
    payIdRec    \* [Swaps -> BOOLEAN] payment_id is on the row (patch(), unguarded)

LsVars == << lockup, pay, payAged, payMoney, payIdRec >>
vars   == << clock, st, loc, conf, serverUp,
             lockup, pay, payAged, payMoney, payIdRec >>

(***************************************************************************)
(* SwapCore constants supplied by cfg definition override.                 *)
(***************************************************************************)
LSPhases     == { "idle", "read", "payCommitted", "payCalled", "claimSent" }
LSResults    == { "none", "capOk", "capFull", "inflight", "failed" }
LSSpendKinds == { "solverClaim", "clientRefund" }

(***************************************************************************)
(* THE EDGE TABLE.  Diff this against LEGAL_EDGES in db/swaps.ts.          *)
(*                                                                         *)
(* Five of these are not the ordinary forward path, and each carries a     *)
(* guard in the TypeScript that is modelled below rather than assumed:     *)
(*                                                                         *)
(*   funded -> claiming   CollectCoupled           the COUPLED path        *)
(*   paying -> refused    RecordPay's failed arm   proof (1), the          *)
(*   paid -> refused      RefuseProvenSelfPayment  self-payment probe      *)
(*   stuck -> claiming    OperatorClaimStuck       the operator holds P    *)
(*   stuck -> refused     OperatorRefundStuck      the refund landed       *)
(***************************************************************************)
Row   == { "quoted", "funded", "paying", "paid", "claiming",
           "claimed", "refused", "stuck" }
AllSt == Row \cup { "none", "rejected" }   \* the two spec-only pre-row markers

Edges == [ x \in AllSt |->
    CASE x = "none"     -> { "quoted", "rejected" }  \* SPEC ONLY: quote() inserts or refuses
      [] x = "rejected" -> { }                       \* SPEC ONLY: no row was ever created
      [] x = "quoted"   -> { "funded", "refused" }
      [] x = "funded"   -> { "paying", "claiming", "refused" }
      [] x = "paying"   -> { "paid", "stuck", "refused" }
      [] x = "paid"     -> { "claiming", "stuck", "refused" }
      [] x = "claiming" -> { "claimed", "stuck" }
      [] x = "claimed"  -> { }
      [] x = "refused"  -> { }
      [] x = "stuck"    -> { "claiming", "refused" } ]

NonTerminal == { "quoted", "funded", "paying", "paid", "claiming" }
Exposed     == { "paying", "paid", "claiming" }
\* WHERE THE AUTOMATIC MACHINE STOPS, which is what every property below
\* means by terminal — not "has no outgoing edge".  `stuck` keeps its two
\* operator edges and still belongs here, because it stays out of
\* NON_TERMINAL (db/swaps.ts, restated in LEGAL_EDGES' `stuck` row) so no
\* sweep ever walks a row a human parked.  Only a deliberate operator action
\* moves one.
Terminal    == { "claimed", "refused", "stuck", "rejected" }
Drivable    == NonTerminal \cup { "none" }   \* findRecoverable(), plus the quote handler

(***************************************************************************)
(* MONEY.  These two predicates are the seam SwapCore's NoSilentLossShape  *)
(* is instantiated with.                                                   *)
(***************************************************************************)
PaidOut(s)          == pay[s] = "succeeded"          \* the sats irreversibly left
Collected(s)        == SpentBy(s, "solverClaim")     \* the lockup is ours
ClientTookLockup(s) == SpentBy(s, "clientRefund")    \* the client pulled it back

(***************************************************************************)
(* THE PROOF THAT LICENSES paying/paid -> refused.                         *)
(*                                                                         *)
(* The comment above LEGAL_EDGES' `paying` and `paid` rows in db/swaps.ts  *)
(* permits those two edges only on PROOF the sats never left, and names    *)
(* two facts that count.  Both read the BACKEND's own record for the hash  *)
(* rather than one call's return value — which is exactly what `pay` is    *)
(* here — so both land on the same two values:                             *)
(*                                                                         *)
(*   "none"    (2) the route-deadline refusal that never reached           *)
(*             payInvoice, with getSendHtlcState answering that the        *)
(*             backend holds nothing for the hash: submitPayment's         *)
(*             `nothingCommitted` parameter, in send/orchestrator.ts.  A   *)
(*             backend with no such probe has proved nothing and parks.    *)
(*   "failed"  (1) the self-payment exception (refundProvenSelfPayment in  *)
(*             send/orchestrator.ts).  The invoice is one our own          *)
(*             node minted, and the payee — the one place the sats could   *)
(*             have ended up — says it was never paid.  `pay` IS that      *)
(*             payee record here, so "failed" is the probe's               *)
(*             pending/cancelled answer; an armed or settled htlc means    *)
(*             money may still be in play and still goes to `stuck`.       *)
(*                                                                         *)
(* MODELLED AS THE RECORD FACT, NOT THE DEADLINE THAT OCCASIONS IT.  The   *)
(* shipped gates in front of payInvoice are clock-bound, and (A2) freezes  *)
(* the clock while a row is Urgent, so a deadline-shaped guard would make  *)
(* both edges unreachable and the check would be dead spec.  What that     *)
(* leaves unmodelled is recorded in the RESULTS block.                     *)
(***************************************************************************)
ProofSatsNeverLeft(s) == pay[s] \in { "none", "failed" }

--------------------------------------------------------------------------
(***************************************************************************)
(* GUARDS.  Evaluated on the CURRENT clock against the worker's SNAPSHOT   *)
(* of the row — which is exactly what whenFunded does: it re-evaluates     *)
(* evaluateSendPayment at the instant before the money moves, never at     *)
(* quote time and never when the lockup was first seen.                    *)
(***************************************************************************)

\* evaluateSendPayment, src/core/send.ts:225-251.
\* Subtraction is written as addition throughout so Naturals never goes negative.
PayGateOpen ==
    /\ clock < InvoiceExpiry                                \* invoice_expired
    /\ clock + MinInvoiceWindow <= InvoiceExpiry            \* invoice_expires_too_soon
    /\ ( BreakClaimWindow                                   \* <<< THE MUTATION
         \/ clock + MinClaimWindow <= RefundLocktime )      \* claim_window_too_short

\* whenQuoted's two deadlines, src/send/orchestrator.ts:459, 483-503.
LockupTimedOut == clock >= LockupDeadline \/ clock >= InvoiceExpiry

--------------------------------------------------------------------------
(***************************************************************************)
(* ENVIRONMENT.  An adversary within physical limits.                      *)
(***************************************************************************)

\* The client locks up the exact amount.  May be on time or late; a late one
\* must be refused, never paid (orchestrator.ts:483-503).
ClientFunds(s) ==
    /\ st[s] = "quoted"
    /\ ~lockup[s]
    /\ lockup' = [lockup EXCEPT ![s] = TRUE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << pay, payAged, payMoney, payIdRec >>

\* The Lightning payment resolves.  THREE outcomes exist in the code, not two:
\* "succeeded", "failed" (only on the adapter's terminal allowlist), and
\* "inflight" — everything unrecognised, every timeout, every dropped
\* connection stays pending, because calling a live payment dead is the costly
\* direction (src/ln/lnd/adapter.ts:55-63).  "inflight" persists across ticks;
\* see (A1) for why it cannot persist forever.
ResolvePayment(s) ==
    /\ pay[s] = "inflight"
    /\ \/ pay' = [pay EXCEPT ![s] = "succeeded"]
       \/ pay' = [pay EXCEPT ![s] = "failed"]
    /\ payAged' = [payAged EXCEPT ![s] = FALSE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << lockup, payMoney, payIdRec >>

\* THE ADVERSARIAL SPEND.  The client's own refundWithoutReceiver leaf, open
\* from refund_locktime and needing the Arkade server's co-signature.  This
\* action also models refundSweep()'s push on a `refused` row, and refundNow's
\* push in ops/refunds.ts, because the covenant refund can only ever pay the
\* client's committed address, so all three have the identical effect on the
\* contested output.
\*
\* The DEADLINE is an under-approximation for those last two: the RFQ family's
\* non-interactive leaf carries no timelock, so both can push the moment the
\* row is refusable (findRefundable in db/swaps.ts).  Modelling the early push
\* would mean modelling an operator refunding a row they can see is paid, and
\* the code answers that with friction rather than with a guard, so the
\* earliest legal client instant is kept as the one deadline here.  Recorded
\* as a residual in the RESULTS block rather than left implicit.
ClientRefundLockup(s) ==
    /\ lockup[s]
    /\ serverUp
    /\ clock >= RefundLocktime
    /\ SpendAccepted(s, "clientRefund")
    /\ UNCHANGED << clock, st, loc, serverUp >>
    /\ UNCHANGED LsVars

(***************************************************************************)
(* OPERATOR RECOVERY OUT OF `stuck`.                                       *)
(*                                                                         *)
(* `stuck` is not absorbing in the shipped table (LEGAL_EDGES' `stuck` row *)
(* in db/swaps.ts): a human who has read a parked row can take it either   *)
(* way.  Both edges are DELIBERATELY UNFAIR — a person reading a queue is  *)
(* not a fairness assumption — and neither is a worker action: the CLI and *)
(* the console CAS the row themselves, outside tick().                     *)
(*                                                                         *)
(* This does NOT make `stuck` non-Terminal above.  Terminal here means the *)
(* automatic machine has stopped, `stuck` stays out of NON_TERMINAL, and   *)
(* these two actions are the human answering the page NoSilentLoss exists  *)
(* to raise — not the sweep walking the row on.                            *)
(***************************************************************************)

\* claimNow (ops/claims.ts).  THE PREIMAGE IS THE GUARD: possessing P for
\* this invoice proves the payee revealed it, and only a settled payment
\* reveals — the check is preimageOpens, in the same file — so the operator
\* can hold one exactly when the payment succeeded.
\*
\* `~Spent(s)` is the model's own restriction, not the code's: claimNow does
\* not look at the lockup.  The edge exists to put a row back on the ordinary
\* claim path and there is nothing left to claim once the output is gone, and
\* without it the model admits an operator re-claiming an already-claimed row
\* forever — which holds `Urgent` true, freezes the clock under (A2) and
\* turns into a liveness counterexample about nothing.
OperatorClaimStuck(s) ==
    /\ st[s] = "stuck"
    /\ pay[s] = "succeeded"
    /\ ~Spent(s)
    /\ st' = [st EXCEPT ![s] = "claiming"]
    /\ UNCHANGED << clock, loc, conf, serverUp >>
    /\ UNCHANGED LsVars

\* refundNow (ops/refunds.ts).  It pushes the covenant refund FIRST, returns
\* `skipped` on its NOTHING_AT_SCRIPT early return when there is nothing at
\* the script, and only then closes the row — so this edge RECORDS a refund
\* that has already landed rather than authorising one.  ClientTookLockup(s)
\* is that landing, which is why the money question is settled before this
\* fires and not by it.
\*
\* THE GUARD DOES NOT ESTABLISH RefusedNeverPaid ON ITS OWN.  Writing `refused`
\* here needs ClientTookLockup(s) => ProofSatsNeverLeft(s), and neither
\* conjunct above says that.  It comes from two places outside this action:
\* NoNetLoss rules out "succeeded", and BackendHonoursIdempotency rules out
\* "inflight" by keeping it out of `stuck` at all.  Break either and this
\* action walks a paid-out row into `refused`; RefusedNeverPaid has both
\* measurements.
OperatorRefundStuck(s) ==
    /\ st[s] = "stuck"
    /\ ClientTookLockup(s)
    /\ st' = [st EXCEPT ![s] = "refused"]
    /\ UNCHANGED << clock, loc, conf, serverUp >>
    /\ UNCHANGED LsVars

Censor == CensorCore /\ UNCHANGED LsVars

\* (A2): the clock does not advance while the solver has work it could finish
\* right now on an exposed row, nor past a payment's enforced CLTV ceiling.
PaymentOverdue == \E s \in Swaps : pay[s] = "inflight" /\ payAged[s]

Urgent(s) ==
    \/ st[s] = "none"                          \* admission settles at clock 0
    \/ st[s] = "funded"                        \* whenFunded pays or refuses now
    \/ (st[s] = "paying" /\ ~payIdRec[s])      \* submitPayment must (re)issue
    \/ ( st[s] \in {"paying", "paid"}
         /\ payIdRec[s]
         /\ pay[s] \in {"succeeded", "failed"} )
    \/ (st[s] = "claiming" /\ conf[s] = {} /\ serverUp)   \* the claim can be pushed
    \/ (st[s] = "claiming" /\ conf[s] # {})               \* the verdict must be recorded

SolverBehind == \E s \in Swaps : Urgent(s)

\* An inflight payment that survives a tick has used up its CLTV budget, so no
\* further tick may pass until the backend answers.
Tick ==
    /\ TickCore
    /\ ~PaymentOverdue
    /\ ~SolverBehind
    /\ payAged' = [s \in Swaps |-> pay[s] = "inflight"]
    /\ UNCHANGED << lockup, pay, payMoney, payIdRec >>

--------------------------------------------------------------------------
(***************************************************************************)
(* WORKER ACTIONS.  One named operator per orchestrator function, so the   *)
(* Go rewrite can be diffed against them one for one.                      *)
(***************************************************************************)

\* store.get(id) / findRecoverable(), and — when the handler is quote() rather
\* than a tick — `await store.committedSats()` in the same breath.  ALWAYS a
\* separate step from the write that follows it, which is the whole point:
\* every await in the TypeScript yields the event loop, and every goroutine
\* boundary in Go yields the scheduler.
ReadSwap(w, s) ==
    /\ ReadRowWith(w, s, Drivable,
           IF st[s] = "none"
             THEN (IF Exposure(NonTerminal) + Amount <= MaxExposed
                     THEN "capOk" ELSE "capFull")
             ELSE "none")
    /\ UNCHANGED LsVars

\* step() returned false with nothing to do, or the CAS was lost silently.
GiveUp(w) ==
    /\ loc[w].phase = "read"
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED LsVars

Crash(w) == CrashCore(w) /\ UNCHANGED LsVars

(***** quote() : src/send/orchestrator.ts:210-304 **************************)

\* insertQuote().  The partial UNIQUE index on payment_hash makes the INSERT
\* itself single-winner, which is modelled by the CAS on "none".  There is NO
\* equivalent backstop for the exposure cap: with AtomicAdmission = FALSE the
\* insert trusts the snapshot verdict, which is today's TypeScript.  With TRUE
\* the cap is re-checked by the write that consumes it, which is what a Go
\* rewrite must do.
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
    /\ UNCHANGED LsVars

(***** whenQuoted : src/send/orchestrator.ts:454-503 ***********************)

\* arkade.findLockups() saw the exact amount, in time.  Note the indexer is
\* allowed to LAG: a worker may simply not take this action even though
\* lockup[s] holds (it takes GiveUp instead).  It may never fire without
\* lockup[s] — the indexer never invents an output.
SeeLockup(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ lockup[s]
    /\ ~LockupTimedOut
    /\ \/ CasWon(s, "quoted", "funded")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* Nothing arrived, or a full lockup arrived too late.  Late funding is
\* REFUSED, never paid: refund_locktime was anchored at quote time.
RefuseQuoted(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ LockupTimedOut
    /\ \/ CasWon(s, "quoted", "refused")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

(***** whenFunded : src/send/orchestrator.ts:506-531 ***********************)

\* THE INTENT COMMIT.  The one edge that decides who spends money.  The CAS
\* runs BEFORE ln.payInvoice, and pay_attempted_at + idempotency_key land in
\* the SAME UPDATE, so there is no window where state='paying' and no key
\* exists.  A worker that wins moves to phase "payCommitted"; a crash there is
\* crash point 3 (nothing has moved, the row alone records the intent).
PayGate(w, s) ==
    /\ Saw(w, s, "funded")
    /\ PayGateOpen
    /\ \/ /\ CasWon(s, "funded", "paying")
          /\ Advance(w, "payCommitted", "none")
       \/ /\ CasLost(s, "funded")
          /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* evaluateSendPayment declined.  Nothing has been paid, so this is a refusal,
\* not an incident: `funded` is not EXPOSED, so this edge carries no proof
\* obligation and never did.  The two that DO are RecordPay's failed arm and
\* RefuseProvenSelfPayment below.
RefusePay(w, s) ==
    /\ Saw(w, s, "funded")
    /\ ~PayGateOpen
    /\ \/ CasWon(s, "funded", "refused")
       \/ CasLost(s, "funded")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* THE COUPLED PATH, and nothing else (whenFunded, send/orchestrator.ts).  A
\* swap whose hash belongs to our own live receive row can never be paid over
\* Lightning — one node cannot pay its own invoice — so it skips `paying` and
\* `paid` and claims on the preimage the client revealed by claiming our
\* payout.  Answered BEFORE evaluateSendPayment, because every gate in there
\* decides whether to PAY and the answer on this path is "never".
\*
\* The coupling fact itself — this hash matches a live receive row — is not
\* carried by this model, so the guard is the consequence the money
\* invariants turn on: nothing was ever submitted for the hash, and this edge
\* submits nothing, so `pay[s]` stays "none" and PaidOut(s) stays FALSE for
\* the whole behaviour.  The payout that IS made on the coupled leg belongs
\* to the RECEIVE corridor and is out of scope here.
CollectCoupled(w, s) ==
    /\ Saw(w, s, "funded")
    /\ pay[s] = "none"
    /\ payMoney[s] = 0
    /\ \/ CasWon(s, "funded", "claiming")
       \/ CasLost(s, "funded")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

(***** submitPayment : src/send/orchestrator.ts:543-576 ********************)

\* TWO ENTRY POINTS, and this is the race the CAS does NOT cover.
\*   (a) the funded->paying winner, straight from whenFunded;
\*   (b) whenPaying's `!row.paymentId` recovery branch — which any worker may
\*       take, at any time, while the row sits in `paying`.
\* The CAS gates the STATE CHANGE, not the RPC.  Two workers can be here at
\* once.  Safety then rests ENTIRELY on the Lightning backend honouring the
\* derived idempotency key, which is a property of that backend, not of SQLite.
CanSubmit(w, s) ==
    \/ At(w, s, "payCommitted")
    \/ (Saw(w, s, "paying") /\ ~payIdRec[s])

\* BackendHonoursIdempotency means something STRONGER than "no duplicate
\* payment", and the difference costs real money.  It means the backend gives
\* ONE AUTHORITATIVE ANSWER PER KEY: repeated or concurrent calls with the
\* same key return the same payment AND the same verdict.  A backend that
\* merely avoids concurrent duplicates — LND will happily let you retry a
\* payment hash after a terminal failure — can answer "failed" to one caller
\* and accept a fresh payment from another.  The code then CASes the row to
\* `stuck` on the first answer while the second payment is live.  See the
\* report; that is a real trace TLC found before this branch was tightened.
SubmitPay(w, s) ==
    /\ CanSubmit(w, s)
    /\ \/ \* the key already has an answer; the backend repeats it verbatim.
          \* payMoney[s] >= 2 is the model's counter cap, not a code behaviour:
          \* NoDoublePay has already failed by then and the branch only exists
          \* so the action never becomes disabled and fakes a livelock.
          /\ (BackendHonoursIdempotency \/ payMoney[s] >= 2)
          /\ pay[s] # "none"
          /\ Advance(w, "payCalled",
                     IF pay[s] = "failed" THEN "failed" ELSE "inflight")
          /\ UNCHANGED << pay, payAged, payMoney >>
       \/ \* a payment is created.  If one already existed and the backend did
          \* NOT dedup, this is the second one: payMoney reaches 2.
          /\ ~(BackendHonoursIdempotency /\ pay[s] # "none")
          /\ payMoney[s] < 2
          /\ pay'      = [pay      EXCEPT ![s] = "inflight"]
          /\ payAged'  = [payAged  EXCEPT ![s] = FALSE]
          /\ payMoney' = [payMoney EXCEPT ![s] = payMoney[s] + 1]
          /\ Advance(w, "payCalled", "inflight")
       \/ \* terminal failure per the adapter's allowlist: the sats did not
          \* leave, and that verdict now belongs to the key.
          /\ pay[s] = "none"
          /\ pay' = [pay EXCEPT ![s] = "failed"]
          /\ Advance(w, "payCalled", "failed")
          /\ UNCHANGED << payAged, payMoney >>
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << lockup, payIdRec >>

(***************************************************************************)
(* PROOF (2) IS NOT MODELLED, AND THAT IS A DECISION, NOT AN OVERSIGHT.    *)
(*                                                                         *)
(* The `nothingCommitted` refusal — submitPayment's two gated branches and *)
(* refuseUnsubmittedPayment, in send/orchestrator.ts — fires from inside   *)
(* submitPayment with payment_id still NULL, so whenPaying's recovery      *)
(* branch is still open to every other worker.  Modelled as a per-worker   *)
(* choice it yields a trace where one worker refuses while a second pays,  *)
(* and TLC finds it at once.  Whether that trace is REAL turns on whether  *)
(* two concurrent submitPayment calls on one row can disagree, and the     *)
(* answer differs by deployment:                                           *)
(*                                                                         *)
(*   refund_locktime in SECONDS — they cannot.  refundDeadlineSeconds      *)
(*   (send/orchestrator.ts) returns the row's own field unchanged, so      *)
(*   refundWithoutReceiverDelayCovers (core/send.ts) is a function of row  *)
(*   fields alone, and deadlineContainsHtlc (same file) only ever closes   *)
(*   as `now` advances.  The later caller cannot pass a gate the earlier   *)
(*   one failed.                                                           *)
(*                                                                         *)
(*   refund_locktime in BLOCK HEIGHTS — they can.  The deadline is         *)
(*   recomputed per call as now + (locktime - tip) * NOMINAL_BLOCK_SECONDS *)
(*   (absoluteLocktimeSeconds, core/timelocks.ts), so a block arriving     *)
(*   between two callers drops it by about 600s while `now` moves by far   *)
(*   less — which RELAXES refundWithoutReceiverDelayCovers for the LATER   *)
(*   caller.  It could then pay where the earlier one refused, leaving a   *)
(*   `refused` row with a live payment for findRefundable to refund.       *)
(*                                                                         *)
(* The second case is a real hazard and it is NOT modelled here: the chain *)
(* tip is not a variable in this module.  It is (R1), and it wants a model *)
(* that carries a tip before it can be called either way.  A               *)
(* nondeterministic gate is not that model — it would fire on both         *)
(* deployments alike and prove nothing about either.                       *)
(***************************************************************************)

\* patch(payment_id) then the paying->paid CAS.  The patch is a BLIND write:
\* `UPDATE ... WHERE id = ?`, no state predicate, no CAS, return value ignored
\* (src/db/swaps.ts:635-645).  It runs even when the payment failed, and even
\* when the row has already moved on.  A crash between SubmitPay and here is
\* THE UNKNOWN-RESULT CASE: the sats may or may not have left and the row
\* cannot tell, which is exactly why the recovery path re-issues under the
\* same key rather than trying to poll.
\*
\* PROOF (1) LIVES HERE, on the failed branch.  refundProvenSelfPayment runs
\* inside submitPayment's terminal-failure arm, AFTER the patch() that puts
\* payment_id on the row and before anything else touches it, so `refused` and
\* `stuck` are the two outcomes of one step — the probe is the only thing that
\* chooses between them.
\*
\* `res = "failed"` IS A SNAPSHOT, NOT THE LIVE VERDICT, and that distinction
\* is the whole safety argument.  It records what the backend told THIS worker
\* back at SubmitPay; `pay[s]` can move between that step and this one, because
\* a second worker holding the same row may submit in between.  What keeps the
\* two agreeing is BackendHonoursIdempotency: a key that has once answered
\* "failed" goes on answering it, so the snapshot is still the proof.
\*
\* Without idempotency they part, and this arm refuses on a stale verdict while
\* the other worker's payment is live.  That is not hypothetical:
\* LightningSend_DoublePay reaches `refused` with pay = "inflight" in twelve
\* states.  RefusedNeverPaid below carries the measurement and the rest of the
\* chain.
RecordPay(w, s) ==
    /\ At(w, s, "payCalled")
    /\ payIdRec' = [payIdRec EXCEPT ![s] = TRUE]
    /\ IF loc[w].res = "failed"
         THEN \/ CasWon(s, "paying", "stuck")     \* fail() from an EXPOSED state
              \/ CasWon(s, "paying", "refused")   \* the self-payment probe proved it
              \/ CasLost(s, "paying")
         ELSE \/ CasWon(s, "paying", "paid")
              \/ CasLost(s, "paying")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << lockup, pay, payAged, payMoney >>

(***** settleFromBackend / whenPaid : orchestrator.ts:603-623 **************)

PollToPaid(w, s) ==
    /\ Saw(w, s, "paying")
    /\ payIdRec[s]
    /\ pay[s] # "failed"
    /\ \/ CasWon(s, "paying", "paid")
       \/ CasLost(s, "paying")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* The adapter's allowlist said the payment is terminally dead.  fail() routes
\* to `stuck` rather than `refused` because both `paying` and `paid` are
\* EXPOSED, and a terminal verdict from the PAYER side alone is not proof the
\* sats never left.  This is still what every failure without the payee-side
\* probe does — "every other terminal failure keeps the old edges".
PollFailed(w, s) ==
    /\ \/ Saw(w, s, "paying")
       \/ Saw(w, s, "paid")
    /\ payIdRec[s]
    /\ pay[s] = "failed"
    /\ \/ CasWon(s, loc[w].seen, "stuck")
       \/ CasLost(s, loc[w].seen)
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* PROOF (1) on the polled side: settleFromBackend (send/orchestrator.ts)
\* reaches the same probe for a row already in `paid`, where the payment went
\* in flight and died a tick later rather than inside payInvoice.
\*
\* Same enabling state as PollFailed and deliberately so: with the probe the
\* row is refused, without it the row parks.  Which of the two fires is the
\* whole content of the exception, and TLC takes both.
RefuseProvenSelfPayment(w, s) ==
    /\ Saw(w, s, "paid")
    /\ payIdRec[s]
    /\ pay[s] = "failed"
    /\ \/ CasWon(s, "paid", "refused")
       \/ CasLost(s, "paid")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* claimWithPreimage: paid -> claiming with P in the SAME UPDATE.  From here
\* the claim needs nothing external — the script rebuilds from the row and the
\* claim leaf never expires.
LearnPreimage(w, s) ==
    /\ Saw(w, s, "paid")
    /\ pay[s] = "succeeded"
    /\ \/ CasWon(s, "paid", "claiming")
       \/ CasLost(s, "paid")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

(***** whenClaiming : src/send/orchestrator.ts:625-665 *********************)

\* THE DELIBERATE FALSE NEGATIVE.  findLockups returned [].  "Empty" is NOT
\* "claimed": the read is spendableOnly and answers [] for a swept, renewed or
\* lagging vtxo exactly as it does after our own spend.  Recording success
\* here would bury a full-amount loss as `claimed`, so it routes to `stuck` at
\* ANY clock.  A false `stuck` costs a glance; a false `claimed` costs funds.
\*
\* With IndexerNeverLies the read is only empty when the output really is
\* spent.  With it FALSE the indexer may report [] for a live lockup, which
\* strands a claimable swap in `stuck` — see the report.
ClaimSeesEmpty(w, s) ==
    /\ Saw(w, s, "claiming")
    /\ (Spent(s) \/ ~IndexerNeverLies)
    /\ \/ CasWon(s, "claiming", "stuck")
       \/ CasLost(s, "claiming")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* arkade.claim() is submitted and the Arkade server co-signs it.  IRREVERSIBLE
\* AND IT HAPPENS BEFORE THE CAS.  Two workers may both be in `claiming` and
\* both submit; the server accepts exactly one (SpendAccepted requires
\* conf = {}), which is why the double claim costs bookkeeping and not money.
ClaimAccepted(w, s) ==
    /\ Saw(w, s, "claiming")
    /\ serverUp
    /\ conf[s] = {}
    /\ conf' = [conf EXCEPT ![s] = { "solverClaim" }]
    /\ Advance(w, "claimSent", "none")
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED LsVars

\* arkade.claim() threw because the Arkade server will not co-sign.  STRICTLY
\* BEFORE the deadline the exception is rethrown with no transition and the
\* next sweep retries — the failure is presumed transient.  Past the deadline
\* a persistently failing claim means the server is censoring while the
\* client's refund path is open and racing us, and this service has no
\* server-independent exit (TODO(unilateral-exit)), so escalate to a human.
\*
\* `conf[s] = {}` is a deliberate collapse.  In the TypeScript, a stale
\* indexer read that still shows an already-spent lockup also lands in this
\* catch.  Modelling that separately would only reach `stuck` one tick later
\* than ClaimSeesEmpty does, with identical money consequences, and it would
\* break the disjointness that lets the fairness conditions be grouped.
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
    /\ UNCHANGED LsVars

\* The ONLY edge into `claimed`, and it holds our own claim txid.  Its return
\* value is IGNORED in the TypeScript (orchestrator.ts:649-650), so a lost CAS
\* silently discards claim_ark_txid — modelled by CasLost simply passing.
RecordClaim(w, s) ==
    /\ At(w, s, "claimSent")
    /\ \/ CasWon(s, "claiming", "claimed")
       \/ CasLost(s, "claiming")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

--------------------------------------------------------------------------
(***************************************************************************)
(* THE NEXT-STATE RELATION                                                 *)
(***************************************************************************)

(***************************************************************************)
(* FAIRNESS GROUPS.                                                        *)
(*                                                                         *)
(* TLC has a low ceiling on how many WF/SF conditions it will build a      *)
(* tableau for: ~13 works, ~29 exhausts the default heap, ~70 aborts with  *)
(* "Temporal formula is a tautology".  So fairness is stated over as few   *)
(* actions as is SOUND, and soundness here has a precise meaning:          *)
(*                                                                         *)
(*   SF on a group is equivalent to SF on each member ONLY IF no member    *)
(*   can be taken infinitely often WITHOUT the swap advancing.  Pairwise   *)
(*   disjointness is NOT enough — that was the first bug in this spec: the *)
(*   old CheckCapacity was disjoint from InsertQuote yet could repeat      *)
(*   forever via read/give-up, discharging the group's fairness while the  *)
(*   row never got inserted.  It has since been folded into ReadSwap.      *)
(*                                                                         *)
(* DriveRow: every member ends in a compare-and-swap and parks.  If it     *)
(*   wins, the row moved; if it loses, the row had already moved, and the  *)
(*   worker's next read sees the new state.  The one member that can be a  *)
(*   no-op is ClaimRefused before the deadline — and in the state where it *)
(*   is enabled (~serverUp /\ conf = {}) it is the ONLY enabled member,    *)
(*   the swap is not Urgent, so WF(Tick) advances the clock and the very   *)
(*   same action then reaches `stuck`.                                     *)
(*                                                                         *)
(* SubmitPay and RecordPay MUST stay outside it and outside each other.    *)
(*   A worker that crashes at phase payCalled leaves payIdRec FALSE, so    *)
(*   SubmitPay becomes enabled again; a group containing both would be     *)
(*   discharged forever by re-submitting and the payment id would never be *)
(*   written down.  Splitting them forces the write.                       *)
(***************************************************************************)
DriveRow(w, s) ==
    \/ InsertQuote(w, s)
    \/ SeeLockup(w, s)      \/ RefuseQuoted(w, s)
    \/ PayGate(w, s)        \/ RefusePay(w, s)    \/ CollectCoupled(w, s)
    \/ PollToPaid(w, s)     \/ PollFailed(w, s)   \/ LearnPreimage(w, s)
    \/ RefuseProvenSelfPayment(w, s)
    \/ ClaimSeesEmpty(w, s) \/ ClaimAccepted(w, s)
    \/ ClaimRefused(w, s)   \/ RecordClaim(w, s)

\* Everything a worker can do to swap s other than reading it or giving up.
Progress(w, s) == DriveRow(w, s) \/ SubmitPay(w, s) \/ RecordPay(w, s)

Next ==
    \/ \E w \in Workers :
          \/ \E s \in Swaps : ReadSwap(w, s) \/ Progress(w, s)
          \/ GiveUp(w)
          \/ Crash(w)
    \/ \E s \in Swaps : ClientFunds(s) \/ ResolvePayment(s) \/ ClientRefundLockup(s)
    \/ \E s \in Swaps : OperatorClaimStuck(s) \/ OperatorRefundStuck(s)
    \/ Censor
    \/ Tick

Init ==
    /\ InitCore("none")
    /\ lockup   = [s \in Swaps |-> FALSE]
    /\ pay      = [s \in Swaps |-> "none"]
    /\ payAged  = [s \in Swaps |-> FALSE]
    /\ payMoney = [s \in Swaps |-> 0]
    /\ payIdRec = [s \in Swaps |-> FALSE]

(***************************************************************************)
(* FAIRNESS.  Strong fairness per (worker, swap, action): a worker that    *)
(* repeatedly reads a row and finds an applicable step must eventually     *)
(* take it.  Weak fairness would be satisfied by an endless read/give-up   *)
(* loop.  Crash, Censor, ClientFunds, ClientRefundLockup and the two       *)
(* Operator* actions are deliberately UNFAIR — neither the environment nor *)
(* a human on a queue owes us anything.                                    *)
(***************************************************************************)
\* TWO TRAPS HERE, both of which produced bogus counterexamples before they
\* were fixed.  Corridor authors: copy this shape, do not simplify it.
\*
\*  1. Keep each `\A` body a SINGLE fairness formula.  TLC's specification
\*     decomposition silently drops a conjunction written inside a quantifier
\*     body; the symptom is a worker that simply never acts.
\*  2. Fairness may NOT go on the whole `Progress` disjunction.  SF on a
\*     disjunction is discharged by ANY disjunct, so a worker could satisfy it
\*     forever by re-reading capacity and never inserting the row.  It goes on
\*     the Drive* groups instead, which are pairwise disjoint by construction
\*     (see the obligation table above them) — per-action SF would be exact
\*     but overruns TLC's ceiling on temporal actions and aborts the run with
\*     "Temporal formula is a tautology (its negation is unsatisfiable)".
Fairness ==
    /\ \A w \in Workers : WF_vars(GiveUp(w))
    /\ \A s \in Swaps  : WF_vars(ResolvePayment(s))
    /\ WF_vars(Tick)
    \* "some worker eventually does this for this swap".  The \E is over
    \* WORKERS, never over swaps: swaps must each be driven, workers are
    \* interchangeable.
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ReadSwap(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : DriveRow(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : SubmitPay(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : RecordPay(w, s))

Spec == Init /\ [][Next]_vars /\ Fairness

--------------------------------------------------------------------------
(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypeOK ==
    /\ TypeOKCore(AllSt)
    /\ lockup   \in [Swaps -> BOOLEAN]
    /\ pay      \in [Swaps -> { "none", "inflight", "succeeded", "failed" }]
    /\ payAged  \in [Swaps -> BOOLEAN]
    /\ payMoney \in [Swaps -> 0..2]
    /\ payIdRec \in [Swaps -> BOOLEAN]

\* Every state change is an edge of LEGAL_EDGES.  An ACTION property.
ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars

\* The irreversible outbound side effect happens at most once per swap.
\* NOT guaranteed by the compare-and-swap: two workers can legitimately both
\* be in `paying` with payment_id NULL.  Guaranteed only by the backend.
NoDoublePay == \A s \in Swaps : payMoney[s] <= 1

\* The contested output is claimed or refunded, never both.
AtMostOneOutcome == AtMostOneOutcomeInv

ExposureBounded == ExposureBoundedBy(NonTerminal)

\* THE money invariant: if the solver has paid out, has not collected, and the
\* machine has stopped, a human is being paged.
NoSilentLoss == NoSilentLossShape(PaidOut, Collected, Terminal, "stuck")

\* THE loss MIN_CLAIM_WINDOW exists to prevent: the solver paid the invoice
\* AND the client pulled the lockup back.  Both legs of the swap gone.
\* This is the invariant the mutation check breaks.
NoNetLoss == \A s \in Swaps : ~(PaidOut(s) /\ ClientTookLockup(s))

\* WHAT RefusedUnreachableFromExposed BECAME, and why it had to move.
\*
\* That invariant read `\A x \in Exposed : "refused" \notin Edges[x]`.  It was
\* a predicate over the table alone, and LEGAL_EDGES' `paying` and `paid` rows
\* have since added the two edges it forbids, so as written it is false of the
\* shipped system by construction — it passed only because `Edges` lagged
\* LEGAL_EDGES.  Deleting it would drop an assertion without adding a check,
\* on the one thing in this corridor that decides whether a refund can land
\* on a swap that paid.
\*
\* So it is restated over the variable the guarantee is actually about.
\* findRefundable selects `refused` rows and the covenant refund pays the
\* client, so what must hold is that a `refused` row is one the sats never
\* left — which is exactly the proof db/swaps.ts demands for the new edges.
\*
\* "inflight" fails it deliberately.  A refused row whose payment is still
\* live is already lost: the sweep can push the refund now and the payment can
\* settle afterwards, and waiting for it to resolve would only hide the window
\* the invariant exists to catch.  Checked in EVERY state, so a payment that
\* settles after the refusal fails it too.
\*
\* IT IS A CONDITIONAL INVARIANT, AND THE CONDITIONS ARE NOT LOCAL TO IT.
\* No action that writes `refused` establishes it on its own; two assumptions
\* elsewhere carry it, one per route in, and each is separately falsifiable:
\*
\*   BackendHonoursIdempotency carries RecordPay's refused arm.  That arm
\*   fires on `res = "failed"`, which is a snapshot, and only idempotency
\*   keeps the snapshot equal to the live `pay[s]`.  With it FALSE the row
\*   reaches `refused` while a concurrent submit is still inflight, at
\*   depth 12.
\*
\*   NoNetLoss carries OperatorRefundStuck.  That guard supplies only
\*   ClientTookLockup, so `~PaidOut` has to come from NoNetLoss; with
\*   NoNetLoss broken the operator edge walks a paid-out row into `refused`,
\*   at depth 22 — in LightningSend_Broken and LightningSend_StaleIndexer
\*   alike, neither of which mutates idempotency.
\*
\* So this invariant is FALSE in three of the four mutation cfgs.  Each still
\* reports the invariant its own header names, because that one violates
\* shallower; verified stable over five runs each (TLC 2.19, -workers 16).
\* On a violating cfg only the invariant NAME and the depth reproduce, never
\* the state counts.  LightningSend_Overexposed and the green cfg hold it over
\* the complete state graph.
\*
\* The table-assertion discipline this replaces has not gone: it lives on in
\* StuckReachableFromEveryExposed below, which is still a claim about `Edges`.
RefusedNeverPaid ==
    \A s \in Swaps : st[s] = "refused" => ProofSatsNeverLeft(s)

\* Same table-assertion discipline, for the opposite direction: every EXPOSED
\* state must carry an escalation to `stuck` in the edge table, so
\* store.fail() from an exposed row always has somewhere legal to go.
\* transition() THROWS on a non-edge, so a missing one would surface as an
\* exception inside a tick rather than as a refusal.  The pin is about the
\* table itself: a future edit that drops a -> stuck edge from an exposed
\* row, or adds an exposed state without one, fails every cfg loudly.  (The
\* `-coverage` argument proves actions were TAKEN, not that stuck is
\* REACHABLE FROM every exposed state.)
StuckReachableFromEveryExposed ==
    \A x \in Exposed : "stuck" \in Edges[x]

Liveness == EventuallyTerminal(Terminal)

(***************************************************************************)
(* Swap ids and worker ids are interchangeable: no action names one, every *)
(* invariant is a \A over them, and `Perms` is therefore definable — but   *)
(* SYMMETRY IS NOT USED BY ANY CFG.  TLC's symmetry reduction is unsound   *)
(* with the per-swap fairness conditions: with `SYMMETRY Perms` this exact *)
(* model INVENTS a liveness counterexample whose cycle exists only in the  *)
(* quotient graph (SwapCore trap T4, confirmed here).  LightningSend.cfg   *)
(* checks Liveness itself, on the full two-swap model, symmetry off.       *)
(***************************************************************************)
Perms == Permutations(Swaps) \cup Permutations(Workers)

(***************************************************************************)
(* MUTATION CHECKS — RESULTS                                               *)
(*                                                                         *)
(* A spec that passes because it is too weak to fail is worse than none.   *)
(* Four guards were broken one at a time, each by a single constant, each  *)
(* with its own .cfg.  All four produce a counterexample.                  *)
(*                                                                         *)
(* Every run here is TLC 2.19 (08 Aug 2024) on Temurin 25, -workers 16.    *)
(* Record the version and the worker count with anything added here: TLC   *)
(* defaults to ONE worker, and several of these do not finish on it.       *)
(*                                                                         *)
(* WHICH FIGURES ARE REPRODUCIBLE, because it is not the obvious answer.   *)
(* A GREEN run explores the whole state graph, so its distinct count and   *)
(* depth are properties of the graph and come out the same every time.  A  *)
(* run that HALTS at the first violation does not: with N workers the      *)
(* discovery order varies, and three runs of _Broken here gave 24,273 /    *)
(* 24,005 / 23,796 distinct, three of _Overexposed gave 308 / 164 / 194 at *)
(* depth 8 / 7 / 8.  So the mutation rows below record the INVARIANT,      *)
(* which is stable, and no counts.  An earlier version of this block       *)
(* carried "92,422 states" for _Broken; that was one sample of a number    *)
(* that moves.                                                             *)
(*                                                                         *)
(*   LightningSend.cfg               GREEN                                 *)
(*                                   278,482 distinct, depth 42, 14m41s    *)
(*   LightningSend_Broken.cfg        BreakClaimWindow=TRUE                 *)
(*                                   -> NoNetLoss violated, ~1s            *)
(*   LightningSend_DoublePay.cfg     BackendHonoursIdempotency=FALSE       *)
(*                                   -> NoDoublePay violated, ~1s          *)
(*   LightningSend_Overexposed.cfg   AtomicAdmission=FALSE, MaxExposed=1   *)
(*                                   -> ExposureBounded violated, <1s      *)
(*   LightningSend_StaleIndexer.cfg  IndexerNeverLies=FALSE                *)
(*                                   -> NoNetLoss violated, ~1s            *)
(*                                                                         *)
(* Three of those four ALSO break RefusedNeverPaid, deeper, so TLC never   *)
(* reports it.  That is documented at the invariant, not here; the reason  *)
(* it matters to a sweep is that the headers stay accurate only because    *)
(* the named violation is the shallower one.                               *)
(*                                                                         *)
(* COVERAGE, from that same green run with -coverage 1 — the check that    *)
(* the five reconciled edges are not dead spec.  The pair is TLC's         *)
(* distinct:total successors; a leading 0 means the action was taken but   *)
(* reached nothing another path also reaches.                              *)
(*                                                                         *)
(*   funded -> claiming   CollectCoupled            1641:15456             *)
(*   paid -> refused      RefuseProvenSelfPayment   1773:12944             *)
(*   stuck -> claiming    OperatorClaimStuck             0:2400            *)
(*   stuck -> refused     OperatorRefundStuck            0:9664            *)
(*   paying -> refused    RecordPay's refused arm, 36,232 firings          *)
(*                                                                         *)
(* The last row's format differs because TLC's output does: it prints one  *)
(* distinct:total line per named ACTION, and `paying -> refused` is an arm *)
(* inside RecordPay rather than an action of its own, so it gets only a    *)
(* bare sub-expression count.  RecordPay's single action line covers all   *)
(* three of its arms together, at 5249:120512.  Nothing is meant by the    *)
(* difference.                                                             *)
(*                                                                         *)
(* THE EDGE RECONCILIATION, AND WHAT IT MOVED                              *)
(*                                                                         *)
(* `Edges` now matches LEGAL_EDGES exactly.  Five edges were added, across *)
(* funded, paying, paid and stuck; until then TLC had never taken any of   *)
(* them, so the guards in front of them had never been checked at all.     *)
(* Every cfg keeps the verdict AND the invariant NAME it had before — the  *)
(* thing to check first after touching this table: TLC stops at the first  *)
(* violation, and a changed name hides inside an unchanged verdict.        *)
(*                                                                         *)
(* RefusedUnreachableFromExposed is now RefusedNeverPaid; the argument is  *)
(* at its definition.  It has teeth, and that was measured rather than     *)
(* assumed: an earlier draft modelled proof (2) as a per-worker choice,    *)
(* and this invariant caught it in two cfgs at depth 11, before NoNetLoss  *)
(* saw anything.  That trace is (R1).                                      *)
(*                                                                         *)
(* `stuck` stays in Terminal and NO LIVENESS PROPERTY MOVED: reaching      *)
(* `stuck` still discharges EventuallyTerminal, and the two operator edges *)
(* are unfair, so nothing depends on a human acting.                       *)
(*                                                                         *)
(* TWO RESIDUALS, both deliberate:                                         *)
(*                                                                         *)
(*  (R1) Proof (2), submitPayment's `nothingCommitted`, is not modelled,   *)
(*       and on a HEIGHT-TYPED refund_locktime the refuse-while-paying     *)
(*       race it guards may be real: the deadline is recomputed per call   *)
(*       against a live chain tip, which this module does not carry.  The  *)
(*       block above RecordPay has the derivation.  Worth its own issue.   *)
(*  (R2) The EARLY refund push is not modelled.  refundNow and             *)
(*       findRefundable can both spend the non-interactive leaf before     *)
(*       refund_locktime — findRefundable's own doc in db/swaps.ts sets    *)
(*       out why — and ClientRefundLockup gates on the deadline.  Closing  *)
(*       it means modelling an operator refunding a row they can see is    *)
(*       paid, which the code answers with friction rather than with a     *)
(*       guard.                                                            *)
(*                                                                         *)
(* THE MANDATED ONE, IN FULL.  LightningSend_Broken.cfg removes only the   *)
(* MIN_CLAIM_WINDOW conjunct from evaluateSendPayment.  TLC finds it at    *)
(* depth 17 — the one figure that held across all three sample runs — in   *)
(* about a second.  Constants: RefundLocktime 3, MinClaimWindow 2,         *)
(* LockupDeadline 3, HtlcMaxLifetime 1.                                    *)
(*                                                                         *)
(*   1-6   both swaps quoted at clock 0 (two workers, interleaved reads    *)
(*         and inserts; the second insert loses nothing because each       *)
(*         worker holds its own row)                                       *)
(*   7     ClientFunds(s1)    the client locks up at clock 0               *)
(*   8-9   Tick, Tick         clock 0 -> 2.  Nothing is Urgent: the        *)
(*                            indexer has not reported the lockup yet.     *)
(*   10    SeeLockup(s1)      quoted -> funded at clock 2                  *)
(*   11-12 ReadSwap, PayGate  funded -> paying.  <<< THE MUTATION.  With   *)
(*                            the real guard this edge is DISABLED here:   *)
(*                            clock 2 + MinClaimWindow 2 = 4 > 3, so       *)
(*                            evaluateSendPayment returns                  *)
(*                            claim_window_too_short and the row goes to   *)
(*                            `refused` instead.                           *)
(*   13    SubmitPay          ln.payInvoice.  payMoney[s1] = 1, the        *)
(*                            payment is in flight.  IRREVERSIBLE.         *)
(*   14    RecordPay          paying -> paid                               *)
(*   15    Tick               clock 2 -> 3.  The payment has now used its  *)
(*                            whole CLTV budget (payAged), so no further   *)
(*                            tick may pass until the backend answers.     *)
(*   16    ResolvePayment     the payment SUCCEEDS.  The solver's sats are *)
(*                            gone.  The row is still `paid` — it has not  *)
(*                            even reached `claiming` yet.                 *)
(*   17    ClientRefundLockup clock 3 = RefundLocktime, so the client's    *)
(*                            refundWithoutReceiver leaf is now open, and  *)
(*                            the Arkade server co-signs it.  The lockup   *)
(*                            is gone.                                     *)
(*                                                                         *)
(*   Final state: pay[s1] = "succeeded"  /\  conf[s1] = {"clientRefund"}   *)
(*   NoNetLoss violated.  The solver paid the BOLT11 and the client took   *)
(*   the lockup back.  Both legs of the swap are gone and the row still    *)
(*   reads `paid`, so the operator does not even learn about it until the  *)
(*   next tick routes it to `stuck`.                                       *)
(*                                                                         *)
(* Note what the counterexample does NOT need: no crash, no lost           *)
(* compare-and-swap, no concurrent double-anything.  MIN_CLAIM_WINDOW is   *)
(* not a concurrency guard — it is a bound on how late the solver may      *)
(* start a payment whose resolution it cannot hurry.  That is why removing *)
(* it is caught by a money invariant and not by ForwardOnly or NoDoublePay.*)
(***************************************************************************)
=============================================================================
