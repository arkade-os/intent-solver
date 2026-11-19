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
(*   SelectRefused  OfferNotSubmittedError above fillOffer: selection, or  *)
(*                  either adapter's deposit-liveness guard                *)
(*   Mark           markSubmitting, which fulfillOffer awaits right        *)
(*                  before fillOffer: the latch                            *)
(*   Submit         fillOffer resolving                                    *)
(*   SubmitFails    fillOffer throwing, after it may have reached arkd     *)
(*   SubmitRejected a fill that reached no chain from below the latch:     *)
(*                  arkd refusing it, or fillOffer's own resolveDeposit    *)
(*                  refusing to build it. Either is unsent.                *)
(*   ResolveRejected refuseRejectedSubmit / loseRejectedSubmit where the   *)
(*                  deposit was spent elsewhere, revertRejectedSubmit      *)
(*                  where one of our own coins was                         *)
(*   Defer          revertUnsubmitted from the loop, or fail() once the    *)
(*                  in-memory MAX_FILL_DEFERRALS is spent                  *)
(*   Recover        a sweep finding `filling` it did not start:            *)
(*                  revertUnsubmitted from 'selecting', fail() otherwise   *)
(*   AbsentAbove    the adapter liveness guard finding the deposit gone,   *)
(*                  above `fulfill`, then PROBING the indexer              *)
(*   AbsentBelow    resolveDeposit finding it gone under the latch, same   *)
(*                  probe. Neither built anything, so `subs` is unmoved    *)
(*   EndGone        loseRejectedSubmit on a probe that NAMED a foreign     *)
(*                  spender: `lost` on the packet path, and the only exit  *)
(*                  here that rests on more than "nothing was sent"        *)
(*   Expire         a ready row refused: price, quote lapse, the § 9 gate  *)
(*                  — which is also how a walked-back row whose deposit is *)
(*                  really gone ENDS, off the gate's own fresh read        *)
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
    BreakProbeProof,      \* the probe answers "gone" without the indexer naming a spender
    BreakRejectedProof,   \* a rejection is classified over a submission arkd may have TAKEN
    BreakRejectedGuard,   \* the rejected exits no longer require fill_phase = 'submitting'
    BreakRevertReset,     \* revertUnsubmitted leaves fill_phase = 'selecting' instead of clearing it
    BreakLegacyReverted,  \* recovery walks back a `filling` row with NO phase too
    LateTyped             \* control: fillOffer's own failure arrives typed

\* `gone` is THE FACT, not a reading of it: whether a transaction of someone
\* else's has taken the deposit. Fixed per behaviour, because within one row's
\* life it either happened before this fill or it did not. An absence READ is
\* available whether or not it holds — that gap is the whole reason for a probe.
VARIABLES st, phase, subs, pc, loc, defs, crashes, gone
vars == <<st, phase, subs, pc, loc, defs, crashes, gone>>

\* `lost` is the deposit-gone terminal: `lost` on the packet path, and `refused`
\* carrying DEPOSIT_SPENT_REASON on the RFQ one. Kept apart from `refused` here
\* so LostOnlyWhenGone can say which terminal it means.
States == {"ready", "filling", "filled", "stuck", "refused", "lost"}
Phases == {"none", "selecting", "submitting"}

New(w) == w \notin Legacy

Init == /\ gone \in BOOLEAN
        /\ st = IF LegacyRow THEN "filling" ELSE "ready"
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
           /\ UNCHANGED <<st, phase, subs, defs, crashes, gone>>

\* Nothing for this process to do with what it read.
Skip(w) == /\ pc[w] = "read"
           /\ \/ loc[w][1] \in {"filled", "stuck", "refused"}
              \/ loc[w][1] = "filling" /\ (~Recovery \/ ~New(w))
           /\ pc' = [pc EXCEPT ![w] = "idle"]
           /\ UNCHANGED <<st, phase, subs, loc, defs, crashes, gone>>

Claim(w) == /\ pc[w] = "read"
            /\ loc[w][1] = "ready"
            /\ IF st = "ready"
               THEN /\ st' = "filling"
                    /\ phase' = IF New(w) THEN "selecting" ELSE phase
                    /\ pc' = [pc EXCEPT ![w] = "claimed"]
               ELSE /\ pc' = [pc EXCEPT ![w] = "idle"]
                    /\ UNCHANGED <<st, phase>>
            /\ UNCHANGED <<subs, loc, defs, crashes, gone>>

Recover(w) == /\ pc[w] = "read"
              /\ Recovery
              /\ New(w)
              /\ loc[w][1] = "filling"
              /\ IF Unsent(loc[w][2])
                 THEN IF RevertGuard THEN RevertWrite ELSE UNCHANGED <<st, phase>>
                 ELSE IF StuckGuard THEN StuckWrite ELSE UNCHANGED <<st, phase>>
              /\ pc' = [pc EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<subs, loc, defs, crashes, gone>>

GuardFails(w) == /\ pc[w] = "claimed"
                 /\ pc' = [pc EXCEPT ![w] = "failed"]
                 /\ UNCHANGED <<st, phase, subs, loc, defs, crashes, gone>>

SelectRefused(w) == /\ pc[w] = "claimed"
                    /\ pc' = [pc EXCEPT ![w] = IF New(w) THEN "typed" ELSE "failed"]
                    /\ UNCHANGED <<st, phase, subs, loc, defs, crashes, gone>>

\* A legacy process goes straight to the submission: it has no latch.
SelectOk(w) == /\ pc[w] = "claimed"
               /\ pc' = [pc EXCEPT ![w] = IF New(w) THEN "selected" ELSE "marked"]
               /\ UNCHANGED <<st, phase, subs, loc, defs, crashes, gone>>

\* markSubmitting: UPDATE ... SET fill_phase = 'submitting'
\*                 WHERE state = 'filling' AND fill_phase = 'selecting'.
\* Losing it means someone else moved the row: fulfillOffer refuses, typed, unsent.
Mark(w) == /\ pc[w] = "selected"
           /\ IF st = "filling" /\ (BreakLatch \/ phase = "selecting")
              THEN /\ phase' = "submitting"
                   /\ pc' = [pc EXCEPT ![w] = "marked"]
              ELSE /\ pc' = [pc EXCEPT ![w] = "typed"]
                   /\ UNCHANGED phase
           /\ UNCHANGED <<st, subs, loc, defs, crashes, gone>>

\* `~gone` because arkd cannot accept a spend of a deposit already taken: with
\* the deposit gone the only ways out of `marked` are a refusal or a failure.
Submit(w) == /\ pc[w] = "marked"
             /\ ~gone
             /\ subs' = subs + 1
             /\ pc' = [pc EXCEPT ![w] = "sent"]
             /\ UNCHANGED <<st, phase, loc, defs, crashes, gone>>

SubmitFails(w) == /\ pc[w] = "marked"
                  /\ subs' \in {subs, subs + 1}
                  /\ pc' = [pc EXCEPT ![w] = IF LateTyped /\ New(w) THEN "typed" ELSE "failed"]
                  /\ UNCHANGED <<st, phase, loc, defs, crashes, gone>>

\* arkd refusing the fill, or resolveDeposit refusing to build it: either accepts
\* nothing, so `subs` does not move. The premise BreakRejectedProof drops.
SubmitRejected(w) == /\ pc[w] = "marked"
                     /\ New(w)
                     /\ subs' = IF BreakRejectedProof THEN subs + 1 ELSE subs
                     /\ pc' = [pc EXCEPT ![w] = "rejected"]
                     /\ UNCHANGED <<st, phase, loc, defs, crashes, gone>>

\* Both exits: WHERE state = 'filling' AND fill_phase = 'submitting'.
RejectedGuard == st = "filling" /\ (BreakRejectedGuard \/ phase = "submitting")

\* The deposit spent elsewhere ends the row; anything else re-selects. A lost CAS
\* writes nothing: another writer moved the row.
ResolveRejected(w) == /\ pc[w] = "rejected"
                      /\ IF RejectedGuard
                         THEN \/ st' = "refused" /\ phase' = "none"
                              \/ st' = "ready" /\ phase' = "none"
                         ELSE UNCHANGED <<st, phase>>
                      /\ pc' = [pc EXCEPT ![w] = "idle"]
                      /\ UNCHANGED <<subs, loc, defs, crashes, gone>>

\* transition(row, 'filling', 'filled'): WHERE state = 'filling'.
Finish(w) == /\ pc[w] = "sent"
             /\ IF st = "filling" THEN st' = "filled" ELSE UNCHANGED st
             /\ pc' = [pc EXCEPT ![w] = "idle"]
             /\ UNCHANGED <<phase, subs, loc, defs, crashes, gone>>

FailRow(w) == /\ pc[w] = "failed"
              /\ IF StuckGuard THEN StuckWrite ELSE UNCHANGED <<st, phase>>
              /\ pc' = [pc EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<subs, loc, defs, crashes, gone>>

\* A deferral is counted only when the walk-back moved the row.
Defer(w) == /\ pc[w] = "typed"
            /\ IF defs[w] < MaxDeferrals
               THEN IF RevertGuard
                    THEN RevertWrite /\ defs' = [defs EXCEPT ![w] = @ + 1]
                    ELSE UNCHANGED <<st, phase, defs>>
               ELSE /\ IF StuckGuard THEN StuckWrite ELSE UNCHANGED <<st, phase>>
                    /\ UNCHANGED defs
            /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ UNCHANGED <<subs, loc, crashes, gone>>

Crash(w) == /\ pc[w] # "idle"
            /\ crashes < MaxCrashes
            /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ defs' = [defs EXCEPT ![w] = 0]
            /\ crashes' = crashes + 1
            /\ UNCHANGED <<st, phase, subs, loc, gone>>

Expire == /\ st = "ready"
          /\ st' = "refused"
          /\ UNCHANGED <<phase, subs, pc, loc, defs, crashes, gone>>

\* THE PROBE, at the two points absence is seen. It may answer "gone" only when
\* the deposit really is — that is the premise, and BreakProbeProof drops it. The
\* second disjunct is always open: a throw, a timeout, or a spend the indexer
\* reports with no spender named all leave the walk-back in charge.
Probed == gone \/ BreakProbeProof

\* Above `fulfill`, phase `selecting`: offerSettle's liveness guard.
AbsentAbove(w) == /\ pc[w] = "claimed"
                  /\ New(w)
                  /\ \/ /\ Probed
                        /\ pc' = [pc EXCEPT ![w] = "gone"]
                     \/ pc' = [pc EXCEPT ![w] = "typed"]
                  /\ UNCHANGED <<st, phase, subs, loc, defs, crashes, gone>>

\* Under the latch, phase `submitting`: fillOffer's own resolveDeposit. Nothing
\* was built, so `subs` does not move.
AbsentBelow(w) == /\ pc[w] = "marked"
                  /\ New(w)
                  /\ \/ /\ Probed
                        /\ pc' = [pc EXCEPT ![w] = "gone"]
                     \/ pc' = [pc EXCEPT ![w] = "rejected"]
                  /\ UNCHANGED <<st, phase, subs, loc, defs, crashes, gone>>

\* loseRejectedSubmit: WHERE state = 'filling' AND fill_phase IN both, because a
\* named foreign spender is the proof here, not the phase.
GoneGuard == st = "filling" /\ phase \in {"selecting", "submitting"}

EndGone(w) == /\ pc[w] = "gone"
              /\ IF GoneGuard THEN st' = "lost" /\ phase' = "none" ELSE UNCHANGED <<st, phase>>
              /\ pc' = [pc EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<subs, loc, defs, crashes, gone>>

Step(w) == \/ Read(w) \/ Skip(w) \/ Claim(w) \/ Recover(w) \/ GuardFails(w)
           \/ SelectRefused(w) \/ SelectOk(w) \/ Mark(w) \/ Submit(w)
           \/ SubmitFails(w) \/ SubmitRejected(w) \/ ResolveRejected(w)
           \/ AbsentAbove(w) \/ AbsentBelow(w) \/ EndGone(w)
           \/ Finish(w) \/ FailRow(w) \/ Defer(w)

Next == Expire \/ \E w \in Workers : Step(w) \/ Crash(w)

\* One WF per quantifier body (SwapCore trap T1). Expire carries none: no refusal is owed.
Spec == Init /\ [][Next]_vars /\ \A w \in Workers : WF_vars(Step(w))

TypeOK == /\ st \in States
          /\ phase \in Phases
          /\ gone \in BOOLEAN
          /\ subs \in Nat
          /\ pc \in [Workers -> {"idle", "read", "claimed", "selected", "marked", "sent", "typed", "failed",
                                "rejected", "gone"}]
          /\ loc \in [Workers -> (States \cup {"none"}) \X Phases]
          /\ defs \in [Workers -> 0..MaxDeferrals]
          /\ crashes \in 0..MaxCrashes

\* The promise: the maker is never paid twice out of the solver's float.
NoDoubleFill == subs <= 1

\* A row that may have sent is never offered to a fill again.
LatchedNeverReady == phase = "submitting" => st # "ready"

FilledMeansSent == st = "filled" => subs >= 1

\* THE PROBE'S PROMISE. A deposit still fillable is never written off: the only
\* way into `lost` is a probe that named a foreign spender, so absence alone can
\* never end a row. BreakProbeProof is exactly this invariant failing.
LostOnlyWhenGone == st = "lost" => gone

\* What this module was written for: no crash leaves a row `filling` for good.
FillingResolves == [](st = "filling" => <>(st # "filling"))

(***************************************************************************)
(* CHECKPOINT (TLC2 2.19, tla2tools v1.7.4, -workers 2)                    *)
(*                                                                         *)
(*   OfferFill.cfg                      GREEN 10,902 distinct, depth 25    *)
(*   OfferFill_LateTypedControl.cfg     GREEN 11,266 distinct, depth 25    *)
(*   OfferFill_RevertResetControl.cfg   GREEN  2,731 distinct, depth 20    *)
(*   OfferFill_RejectedGuardControl.cfg GREEN 10,902 distinct, depth 25    *)
(*   OfferFill_Upgrade.cfg              GREEN    176 distinct, depth 7     *)
(*   OfferFill_NoLatch.cfg              NoDoubleFill                       *)
(*   OfferFill_RevertGuard.cfg          NoDoubleFill                       *)
(*   OfferFill_RevertReset.cfg          NoDoubleFill                       *)
(*   OfferFill_LegacyReverted.cfg       NoDoubleFill                       *)
(*   OfferFill_RejectedProof.cfg        NoDoubleFill                       *)
(*   OfferFill_ProbeProof.cfg           LostOnlyWhenGone                   *)
(*   OfferFill_NoRecovery.cfg           FillingResolves (temporal)         *)
(*   OfferFill_Sim.cfg                  20,000 traces, depth 100, clean    *)
(*                                                                         *)
(* The green runs check FillingResolves as well as the invariants.         *)
(***************************************************************************)
=============================================================================
