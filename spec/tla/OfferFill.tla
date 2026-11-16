------------------------------ MODULE OfferFill ------------------------------
(***************************************************************************)
(* THE OFFER FILL: one irreversible spend, a walk-back, and crash recovery *)
(*                                                                         *)
(* Both fill loops share this machine. The offer-packet loop calls the     *)
(* ready state `fillable`; the asset RFQ loop calls it `funded`.           *)
(*                                                                         *)
(*   packages/solver-app/src/                                              *)
(*     ops/assetOffers.ts       AssetOfferService.tickAllInner             *)
(*   packages/solver-corridors/src/                                        *)
(*     asset/assetRfqOrchestrator.ts  AssetRfqSwapService.whenFunded,      *)
(*                                    AssetRfqSwapService.whenFilling      *)
(*     db/offerFills.ts         OfferFillStore.transition, .fail,          *)
(*                              .markSubmitting, .revertUnsubmitted        *)
(*     db/assetRfqSwaps.ts      AssetRfqSwapStore, the same four           *)
(*   packages/solver-arkade/src/                                           *)
(*     arkade/offerFulfill.ts   fulfillOffer, OfferNotSubmittedError       *)
(*                                                                         *)
(*   Action         Code                                                   *)
(*   Claim          the `fillable -> filling` / `funded -> filling` CAS,   *)
(*                  stamping fill_phase = 'selecting'                      *)
(*   GuardFails     a plain throw from offerSettle / quotedOfferSettle     *)
(*   SelectRefused  OfferNotSubmittedError at coin selection               *)
(*   Mark           markSubmitting, which fulfillOffer awaits right        *)
(*                  before fillOffer: the latch                            *)
(*   Submit         fillOffer resolving                                    *)
(*   SubmitFails    fillOffer throwing, after it may have reached arkd     *)
(*   Defer          revertUnsubmitted from the loop, or fail() once the    *)
(*                  in-memory MAX_FILL_DEFERRALS is spent                  *)
(*   Recover        a sweep finding `filling` it did not start:            *)
(*                  revertUnsubmitted from 'selecting', fail() otherwise   *)
(*   Expire         a ready row refused: price, quote lapse, the § 9 gate  *)
(*                                                                         *)
(* `st` and `phase` are THE DATABASE. Every write to them is one           *)
(* conditional UPDATE, and each read sits in its own step, so any process  *)
(* can interleave between a read and the write it informs. A crash drops   *)
(* the process's local state and its in-memory deferral count.            *)
(*                                                                         *)
(* `subs` counts fills that may have reached arkd. The deposit can be      *)
(* spent only once, so arkd would refuse a second fill of it; the model    *)
(* holds the code to the stricter rule its own comments state instead:     *)
(* never submit twice.                                                     *)
(*                                                                         *)
(* Abstracted away: amounts, prices, which coins are picked, the pin       *)
(* ledger (PR #328 owns that race) and the event log, which is written     *)
(* after the CAS and is not authoritative.                                 *)
(*                                                                         *)
(* `Legacy` processes run the version before fill_phase existed: they      *)
(* claim without stamping a phase, submit without marking, skip a row      *)
(* they find `filling`, and park every throw as `stuck`. `LegacyRow`       *)
(* starts the row `filling` with no phase, as such a version leaves it,    *)
(* having submitted or not.                                                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Workers,              \* processes running a fill loop
    Legacy,               \* the subset of Workers running the version before fill_phase
    MaxCrashes,           \* bounded, or an endless crash loop is a counterexample
    MaxDeferrals,         \* MAX_FILL_DEFERRALS, held in memory per process
    LegacyRow,            \* the row starts `filling` with no phase
    Recovery,             \* a sweep resolves `filling` it did not start (FALSE = #331 as first pushed)
    BreakLatch,           \* markSubmitting no longer requires fill_phase = 'selecting'
    BreakRevertGuard,     \* revertUnsubmitted no longer requires fill_phase = 'selecting'
    BreakRevertReset,     \* revertUnsubmitted leaves fill_phase = 'selecting' instead of clearing it
    BreakLegacyReverted,  \* recovery walks back a `filling` row with NO phase too
    LateTyped             \* control: fillOffer's own failure arrives typed

VARIABLES st, phase, subs, pc, loc, defs, crashes
vars == <<st, phase, subs, pc, loc, defs, crashes>>

States == {"ready", "filling", "filled", "stuck", "refused"}
Phases == {"none", "selecting", "submitting"}

New(w) == w \notin Legacy

Init == /\ st = IF LegacyRow THEN "filling" ELSE "ready"
        /\ phase = "none"
        /\ subs \in IF LegacyRow THEN {0, 1} ELSE {0}
        /\ pc = [w \in Workers |-> "idle"]
        /\ loc = [w \in Workers |-> <<"none", "none">>]
        /\ defs = [w \in Workers |-> 0]
        /\ crashes = 0

Unsent(p) == p = "selecting" \/ (BreakLegacyReverted /\ p = "none")

\* revertUnsubmitted: UPDATE ... SET state = <ready>, fill_phase = NULL
\*                    WHERE state = 'filling' AND fill_phase = 'selecting'
RevertGuard == st = "filling" /\ (BreakRevertGuard \/ Unsent(phase))
RevertWrite == /\ st' = "ready"
               /\ phase' = IF BreakRevertReset THEN phase ELSE "none"

\* fail(row, 'filling', ...): WHERE state = 'filling', and nothing else.
StuckGuard == st = "filling"
StuckWrite == st' = "stuck" /\ UNCHANGED phase

Read(w) == /\ pc[w] = "idle"
           /\ loc' = [loc EXCEPT ![w] = <<st, phase>>]
           /\ pc' = [pc EXCEPT ![w] = "read"]
           /\ UNCHANGED <<st, phase, subs, defs, crashes>>

\* Nothing for this process to do with what it read.
Skip(w) == /\ pc[w] = "read"
           /\ \/ loc[w][1] \in {"filled", "stuck", "refused"}
              \/ loc[w][1] = "filling" /\ (~Recovery \/ ~New(w))
           /\ pc' = [pc EXCEPT ![w] = "idle"]
           /\ UNCHANGED <<st, phase, subs, loc, defs, crashes>>

Claim(w) == /\ pc[w] = "read"
            /\ loc[w][1] = "ready"
            /\ IF st = "ready"
               THEN /\ st' = "filling"
                    /\ phase' = IF New(w) THEN "selecting" ELSE phase
                    /\ pc' = [pc EXCEPT ![w] = "claimed"]
               ELSE /\ pc' = [pc EXCEPT ![w] = "idle"]
                    /\ UNCHANGED <<st, phase>>
            /\ UNCHANGED <<subs, loc, defs, crashes>>

Recover(w) == /\ pc[w] = "read"
              /\ Recovery
              /\ New(w)
              /\ loc[w][1] = "filling"
              /\ IF Unsent(loc[w][2])
                 THEN IF RevertGuard THEN RevertWrite ELSE UNCHANGED <<st, phase>>
                 ELSE IF StuckGuard THEN StuckWrite ELSE UNCHANGED <<st, phase>>
              /\ pc' = [pc EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<subs, loc, defs, crashes>>

GuardFails(w) == /\ pc[w] = "claimed"
                 /\ pc' = [pc EXCEPT ![w] = "failed"]
                 /\ UNCHANGED <<st, phase, subs, loc, defs, crashes>>

SelectRefused(w) == /\ pc[w] = "claimed"
                    /\ pc' = [pc EXCEPT ![w] = IF New(w) THEN "typed" ELSE "failed"]
                    /\ UNCHANGED <<st, phase, subs, loc, defs, crashes>>

\* A legacy process goes straight to the submission: it has no latch.
SelectOk(w) == /\ pc[w] = "claimed"
               /\ pc' = [pc EXCEPT ![w] = IF New(w) THEN "selected" ELSE "marked"]
               /\ UNCHANGED <<st, phase, subs, loc, defs, crashes>>

\* markSubmitting: UPDATE ... SET fill_phase = 'submitting'
\*                 WHERE state = 'filling' AND fill_phase = 'selecting'.
\* Losing it means someone else moved the row: fulfillOffer refuses, typed, unsent.
Mark(w) == /\ pc[w] = "selected"
           /\ IF st = "filling" /\ (BreakLatch \/ phase = "selecting")
              THEN /\ phase' = "submitting"
                   /\ pc' = [pc EXCEPT ![w] = "marked"]
              ELSE /\ pc' = [pc EXCEPT ![w] = "typed"]
                   /\ UNCHANGED phase
           /\ UNCHANGED <<st, subs, loc, defs, crashes>>

Submit(w) == /\ pc[w] = "marked"
             /\ subs' = subs + 1
             /\ pc' = [pc EXCEPT ![w] = "sent"]
             /\ UNCHANGED <<st, phase, loc, defs, crashes>>

SubmitFails(w) == /\ pc[w] = "marked"
                  /\ subs' \in {subs, subs + 1}
                  /\ pc' = [pc EXCEPT ![w] = IF LateTyped /\ New(w) THEN "typed" ELSE "failed"]
                  /\ UNCHANGED <<st, phase, loc, defs, crashes>>

\* transition(row, 'filling', 'filled'): WHERE state = 'filling'.
Finish(w) == /\ pc[w] = "sent"
             /\ IF st = "filling" THEN st' = "filled" ELSE UNCHANGED st
             /\ pc' = [pc EXCEPT ![w] = "idle"]
             /\ UNCHANGED <<phase, subs, loc, defs, crashes>>

FailRow(w) == /\ pc[w] = "failed"
              /\ IF StuckGuard THEN StuckWrite ELSE UNCHANGED <<st, phase>>
              /\ pc' = [pc EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<subs, loc, defs, crashes>>

\* A deferral is counted only when the walk-back moved the row.
Defer(w) == /\ pc[w] = "typed"
            /\ IF defs[w] < MaxDeferrals
               THEN IF RevertGuard
                    THEN RevertWrite /\ defs' = [defs EXCEPT ![w] = @ + 1]
                    ELSE UNCHANGED <<st, phase, defs>>
               ELSE /\ IF StuckGuard THEN StuckWrite ELSE UNCHANGED <<st, phase>>
                    /\ UNCHANGED defs
            /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<subs, loc, crashes>>

Crash(w) == /\ pc[w] # "idle"
            /\ crashes < MaxCrashes
            /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ defs' = [defs EXCEPT ![w] = 0]
            /\ crashes' = crashes + 1
            /\ UNCHANGED <<st, phase, subs, loc>>

Expire == /\ st = "ready"
          /\ st' = "refused"
          /\ UNCHANGED <<phase, subs, pc, loc, defs, crashes>>

Step(w) == \/ Read(w) \/ Skip(w) \/ Claim(w) \/ Recover(w) \/ GuardFails(w)
           \/ SelectRefused(w) \/ SelectOk(w) \/ Mark(w) \/ Submit(w)
           \/ SubmitFails(w) \/ Finish(w) \/ FailRow(w) \/ Defer(w)

Next == Expire \/ \E w \in Workers : Step(w) \/ Crash(w)

\* One WF per quantifier body (SwapCore trap T1). Expire carries none: no refusal is owed.
Spec == Init /\ [][Next]_vars /\ \A w \in Workers : WF_vars(Step(w))

TypeOK == /\ st \in States
          /\ phase \in Phases
          /\ subs \in Nat
          /\ pc \in [Workers -> {"idle", "read", "claimed", "selected", "marked", "sent", "typed", "failed"}]
          /\ loc \in [Workers -> (States \cup {"none"}) \X Phases]
          /\ defs \in [Workers -> 0..MaxDeferrals]
          /\ crashes \in 0..MaxCrashes

\* The promise: the maker is never paid twice out of the solver's float.
NoDoubleFill == subs <= 1

\* A row that may have sent is never offered to a fill again.
LatchedNeverReady == phase = "submitting" => st # "ready"

FilledMeansSent == st = "filled" => subs >= 1

\* What this module was written for: no crash leaves a row `filling` for good.
FillingResolves == [](st = "filling" => <>(st # "filling"))

(***************************************************************************)
(* CHECKPOINT (TLC2 2.19, tla2tools v1.7.4, -workers 2)                    *)
(*                                                                         *)
(*   OfferFill.cfg                      GREEN  4,323 distinct, depth 24    *)
(*   OfferFill_LateTypedControl.cfg     GREEN  4,477 distinct, depth 24    *)
(*   OfferFill_RevertResetControl.cfg   GREEN  1,266 distinct, depth 16    *)
(*   OfferFill_Upgrade.cfg              GREEN     88 distinct, depth 7     *)
(*   OfferFill_NoLatch.cfg              NoDoubleFill                       *)
(*   OfferFill_RevertGuard.cfg          NoDoubleFill                       *)
(*   OfferFill_RevertReset.cfg          NoDoubleFill                       *)
(*   OfferFill_LegacyReverted.cfg       NoDoubleFill                       *)
(*   OfferFill_NoRecovery.cfg           FillingResolves (temporal)         *)
(*   OfferFill_Sim.cfg                  20,000 traces, depth 100, clean    *)
(*                                                                         *)
(* The green runs check FillingResolves as well as the invariants.         *)
(***************************************************************************)
=============================================================================
