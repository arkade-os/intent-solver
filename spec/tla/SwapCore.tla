-------------------------------- MODULE SwapCore --------------------------------
(***************************************************************************)
(* SHARED VOCABULARY FOR THE FOUR SWAP CORRIDORS                           *)
(*                                                                         *)
(* WHAT THIS SPECIFIES                                                     *)
(*                                                                         *)
(* This module holds the machinery that is identical across all four       *)
(* corridors of the solver, so that a corridor module is mostly its edge   *)
(* table, its guards and its named actions.  It is the TLA+ counterpart of *)
(* the cross-cutting layer the TypeScript keeps in                         *)
(*                                                                         *)
(*   src/db/swaps.ts               transition() / patch() / fail()         *)
(*   src/db/receiveSwaps.ts        the same three, duplicated verbatim     *)
(*   src/db/onchainSwaps.ts        ditto                                   *)
(*   src/db/onchainReceiveSwaps.ts ditto                                   *)
(*   src/db/driver.ts              the SqlDriver seam (WAL, synchronous)   *)
(*   src/send/orchestrator.ts:314-326, 352-381   tick() / driveRows()      *)
(*   packages/solver-app/src/worker.ts:11-25           the queue fan-out and its safety claim  *)
(*                                                                         *)
(* THE CLAIM UNDER TEST                                                    *)
(*                                                                         *)
(* packages/solver-app/src/worker.ts:20-25 and src/send/orchestrator.ts:352-354 both assert    *)
(* that money-safety does NOT depend on the in-process `inFlight` Set, and *)
(* rests on the store's compare-and-swap alone.  A Go rewrite with N       *)
(* goroutines across M processes deletes `inFlight`.  Everything in this   *)
(* module is arranged so that assertion can be falsified rather than       *)
(* assumed:                                                                *)
(*                                                                         *)
(*   - `st` is THE DATABASE.  It is the only thing shared between workers. *)
(*   - `loc` is each worker's LOCAL snapshot of a row.  A worker must      *)
(*     ReadRow before it can act, and the read and the write are separate  *)
(*     steps, so another worker can always interleave between them.        *)
(*   - CasWon / CasLost are the ONLY way `st` may change.  CasWon fires    *)
(*     only if the row is still in the state the worker read; CasLost is   *)
(*     the silent `changes === 0` path the TypeScript takes.               *)
(*   - CrashCore(w) discards `loc` at any point, which is exactly what a   *)
(*     process death does to an in-memory row and an in-flight RPC result. *)
(*                                                                         *)
(* WHAT IS DELIBERATELY ABSTRACTED AWAY HERE                               *)
(*                                                                         *)
(*   - Amounts.  Every swap is for the same `Amount`, so exposure is       *)
(*     Amount * |live swaps| and needs no recursive sum.  The exposure cap *)
(*     bug is about COUNTING concurrent admissions, not about arithmetic.  *)
(*   - The event log (`send_swap_event`).  It is written outside the CAS's *)
(*     transaction and is therefore not authoritative; see the report.     *)
(*   - patch().  Modelled per corridor where it matters, as an unguarded   *)
(*     write with no state predicate, because that is what it is.          *)
(*   - Column allowlists, SQL injection, migrations.  Not money-safety.    *)
(*                                                                         *)
(* THE SEAM: WHAT A CORRIDOR MODULE MUST SUPPLY                            *)
(*                                                                         *)
(* TLA+ cannot let an extended module write UNCHANGED for variables it has *)
(* never heard of.  So this module deliberately exports FRAGMENTS (state   *)
(* predicates and primed-variable relations over the core variables only), *)
(* and each corridor composes them with its own updates and its own        *)
(* UNCHANGED clause.  That is a readable duplication, chosen over a clever *)
(* abstraction on purpose: an action in a corridor module should read like *)
(* the Go function it will become, with its UNCHANGED list visible.        *)
(*                                                                         *)
(* A corridor module must:                                                 *)
(*                                                                         *)
(*   1. EXTENDS SwapCore                                                   *)
(*   2. define its own state sets and edge table as plain definitions:     *)
(*        Row, AllSt, Edges, NonTerminal, Exposed, Terminal, Drivable      *)
(*   3. declare its own VARIABLES and define                               *)
(*        vars   == << clock, st, loc, conf, serverUp >> \o <corridor>     *)
(*        LsVars == << its own variables >>                                *)
(*   4. wrap the core actions with its own UNCHANGED, e.g.                 *)
(*        Crash(w) == CrashCore(w) /\ UNCHANGED LsVars                     *)
(*        Tick     == TickCore /\ <corridor liveness guards>               *)
(*                              /\ UNCHANGED LsVars                        *)
(*   5. define PaidOut(_) and Collected(_) — "the solver's money has       *)
(*      irreversibly left" and "the solver has irreversibly been made      *)
(*      whole" — and instantiate NoSilentLossShape with them.              *)
(*   6. supply Phases, Results and SpendKinds via cfg definition           *)
(*      overrides (CONSTANT Phases <- LSPhases).                           *)
(*                                                                         *)
(* FOUR TRAPS, ALL OF WHICH COST TIME IN LightningSend.  READ THESE.       *)
(*                                                                         *)
(*   T1  A fairness formula written as                                     *)
(*         \A w \in Workers : /\ WF_vars(A(w))                             *)
(*                            /\ WF_vars(B(w))                             *)
(*       is SILENTLY DROPPED by TLC's specification decomposition.  Keep   *)
(*       each quantifier body a single WF_/SF_ formula and repeat the      *)
(*       quantifier.  The symptom is a liveness counterexample in which a  *)
(*       worker plainly refuses to act.                                    *)
(*                                                                         *)
(*   T2  SF on a DISJUNCTION of actions is discharged by any one disjunct. *)
(*       Grouping actions to keep the fairness list short is fine, but the *)
(*       obligation is not "the members are pairwise disjoint" — it is     *)
(*       "no member can be taken infinitely often without the swap         *)
(*       advancing".  An action that samples something and parks (a        *)
(*       capacity read, a poll that finds nothing) fails that test and     *)
(*       must be folded into ReadRowWith or given its own SF.              *)
(*                                                                         *)
(*   T3  TLC's ceiling on temporal actions is low: about 13 WF/SF          *)
(*       conditions check comfortably, ~29 exhaust the default heap, ~70   *)
(*       abort the run with "Temporal formula is a tautology (its negation *)
(*       is unsatisfiable)".  Quantify fairness over SWAPS with an \E over *)
(*       WORKERS — "some worker eventually drives this swap" — rather than *)
(*       over every (worker, swap) pair.                                   *)
(*                                                                         *)
(*   T4  DO NOT declare SYMMETRY when checking liveness, however tempting: *)
(*       per-swap fairness conditions are not symmetric, and TLC will      *)
(*       report a liveness counterexample whose cycle exists only in the   *)
(*       quotient graph.  This was confirmed on LightningSend: identical   *)
(*       model, symmetry on -> bogus counterexample, symmetry off -> no    *)
(*       error.  Pay the 4x instead.                                       *)
(*                                                                         *)
(* WHAT A GO IMPLEMENTER MUST PRESERVE TO REMAIN A REFINEMENT              *)
(*                                                                         *)
(*   - Every write to the state column goes through one conditional UPDATE *)
(*     whose WHERE clause names the state the caller read (CasWon), and    *)
(*     whose rowcount is inspected (CasLost is a real outcome, not an      *)
(*     error).  Nothing else may write the state column.                   *)
(*   - A worker's decision must be a pure function of (row snapshot,       *)
(*     current clock, world reads).  It may not carry state between ticks. *)
(*   - Crashing between any two steps must leave the row re-drivable: the  *)
(*     recovery path is chosen from the ROW, never from process memory.    *)
(*   - The contested output has exactly one winner.  Model any concurrency *)
(*     control you add (a lease column, an advisory lock) as an ADDITIONAL *)
(*     constraint; it may narrow this spec's behaviours, never widen them. *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Swaps,        \* set of swap ids under test
    Workers,      \* set of concurrent drivers (goroutines / processes / isolates)
    MaxClock,     \* clock bound; keeps the state space finite
    Amount,       \* every swap is for this many sats (see abstraction note)
    MaxExposed,   \* MAX_EXPOSED_SATS, in the same units as Amount
    Phases,       \* worker-local phases; MUST contain "idle" and "read"
    Results,      \* worker-local RPC results; MUST contain "none"
    SpendKinds,   \* the competing spenders of the one contested output
    NoSwap,       \* model value: this worker holds no row
    NoState       \* model value: this worker has read no state

ASSUME "idle" \in Phases /\ "read" \in Phases
ASSUME "none" \in Results
ASSUME MaxClock \in Nat /\ Amount \in Nat /\ MaxExposed \in Nat

VARIABLES
    clock,        \* discrete time.  Advances only.  Bounded by MaxClock.
    st,           \* [Swaps -> state] .  THE DATABASE.  The only shared truth.
    loc,          \* [Workers -> worker-local snapshot of one row]
    conf,         \* [Swaps -> SUBSET SpendKinds] : confirmed spends of the lockup
    serverUp      \* the Arkade server will co-sign.  Monotone: TRUE -> FALSE.

CoreVars == << clock, st, loc, conf, serverUp >>

(***************************************************************************)
(* WORKER-LOCAL STATE                                                      *)
(*                                                                         *)
(* `seen` is the row state the worker read.  Every compare-and-swap it     *)
(* later attempts is predicated on `seen`, exactly as store.transition(id, *)
(* from, to) is predicated on the `from` its caller believed.  `phase`     *)
(* separates the read from the write, and separates an irreversible side   *)
(* effect from the transition that records it — which is where every       *)
(* interesting crash lives.                                                *)
(***************************************************************************)
IdleLoc == [ swap |-> NoSwap, seen |-> NoState, phase |-> "idle", res |-> "none" ]

LocType(rowStates) ==
    [ swap  : Swaps \cup {NoSwap},
      seen  : rowStates \cup {NoState},
      phase : Phases,
      res   : Results ]

Idle(w)           == loc[w] = IdleLoc
At(w, s, ph)      == loc[w].swap = s /\ loc[w].phase = ph
Saw(w, s, state)  == loc[w].swap = s /\ loc[w].phase = "read" /\ loc[w].seen = state
Park(w)           == loc' = [loc EXCEPT ![w] = IdleLoc]
Advance(w, ph, r) == loc' = [loc EXCEPT ![w].phase = ph, ![w].res = r]

(***************************************************************************)
(* THE DATABASE READ.  Models `await store.get(id)` inside tick()'s loop   *)
(* and findRecoverable()'s row list.  It is a separate step from every     *)
(* action that follows it, so another worker may always interleave.        *)
(***************************************************************************)
\* `r` is anything else the handler sampled in the same breath as the row —
\* quote() reads committedSats() alongside it, and that snapshot is what the
\* later INSERT trusts.  Pass "none" when the handler samples nothing.
ReadRowWith(w, s, drivable, r) ==
    /\ Idle(w)
    /\ st[s] \in drivable
    /\ loc' = [loc EXCEPT ![w] =
                 [swap |-> s, seen |-> st[s], phase |-> "read", res |-> r]]
    /\ UNCHANGED << clock, st, conf, serverUp >>

ReadRow(w, s, drivable) == ReadRowWith(w, s, drivable, "none")

(***************************************************************************)
(* CRASH.  A process death at any point.  Everything in memory is lost:    *)
(* the row snapshot, the phase, and any RPC result not yet written down.   *)
(* Recovery is whatever the next worker's ReadRow finds on disk.           *)
(***************************************************************************)
CrashCore(w) ==
    /\ ~Idle(w)
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>

(***************************************************************************)
(* THE COMPARE-AND-SWAP.                                                   *)
(*                                                                         *)
(*   UPDATE <t> SET state = to WHERE id = ? AND state = from               *)
(*   -> changes === 1                                                      *)
(*                                                                         *)
(* CasWon and CasLost are exhaustive and mutually exclusive, which is the  *)
(* whole content of the safety claim: at most one worker can move a row    *)
(* across any given edge.  Note what it does NOT bound — the number of     *)
(* RPCs issued while the row sits in one state.                            *)
(***************************************************************************)
CasWon(s, from, to) == st[s] = from /\ st' = [st EXCEPT ![s] = to]
CasLost(s, from)    == st[s] # from /\ UNCHANGED st

(***************************************************************************)
(* THE CONTESTED OUTPUT.                                                   *)
(*                                                                         *)
(* One output, several parties that may legally spend it, at most one      *)
(* winner ever.  On Arkade the arbiter is the Arkade server, which         *)
(* co-signs exactly one spend and refuses the rest outright — there is no  *)
(* mempool and no reorg, so acceptance and confirmation coincide.  On L1   *)
(* the arbiter is a miner and the corridor module must additionally model  *)
(* the broadcast/confirm gap; this module gives it the "at most one" part. *)
(***************************************************************************)
Spent(s)        == conf[s] # {}
SpentBy(s, k)   == k \in conf[s]
SpendAccepted(s, k) == conf[s] = {} /\ conf' = [conf EXCEPT ![s] = {k}]

(***************************************************************************)
(* CLOCK.  Small integers, not seconds.  Only the RELATIVE ORDERING of the *)
(* deadlines matters, because that ordering is all the guards compare.     *)
(***************************************************************************)
TickCore ==
    /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED << st, loc, conf, serverUp >>

(***************************************************************************)
(* THE ARKADE SERVER STOPS CO-SIGNING, permanently.                        *)
(*                                                                         *)
(* Deliberately monotone.  Both collaborative leaves — the solver's claim  *)
(* and the client's refundWithoutReceiver — need this signature, so a      *)
(* censoring server freezes BOTH sides, which is precisely why             *)
(* refundLocktimeFor carries the `unilateralBound` term                    *)
(* (src/core/send.ts:111-129).  A server that flaps and returns exactly    *)
(* inside the contested window is a real hazard that no guard in this      *)
(* codebase addresses (see TODO(unilateral-exit) in                        *)
(* src/send/orchestrator.ts:652-665); modelling it would only restate what *)
(* the code already concedes.  See the report.                             *)
(***************************************************************************)
CensorCore ==
    /\ serverUp
    /\ serverUp' = FALSE
    /\ UNCHANGED << clock, st, loc, conf >>

(***************************************************************************)
(* EXPOSURE ACCOUNTING.  committedSats() sums amount_sats over NON_TERMINAL *)
(* — deliberately wider than EXPOSED, because a quoted swap is capacity     *)
(* the provider may still have to honour (src/db/swaps.ts:510-527).        *)
(***************************************************************************)
LiveSwaps(nonTerminal) == { s \in Swaps : st[s] \in nonTerminal }
Exposure(nonTerminal)  == Amount * Cardinality(LiveSwaps(nonTerminal))

(***************************************************************************)
(* GENERIC INVARIANT SHAPES.  A corridor instantiates these with its own   *)
(* edge table and its own notion of paid-out / collected.                  *)
(***************************************************************************)
TypeOKCore(rowStates) ==
    /\ clock \in 0..MaxClock
    /\ st \in [Swaps -> rowStates]
    /\ loc \in [Workers -> LocType(rowStates)]
    /\ conf \in [Swaps -> SUBSET SpendKinds]
    /\ serverUp \in BOOLEAN

InitCore(initState) ==
    /\ clock = 0
    /\ st = [s \in Swaps |-> initState]
    /\ loc = [w \in Workers |-> IdleLoc]
    /\ conf = [s \in Swaps |-> {}]
    /\ serverUp = TRUE

\* ACTION property.  Use as: ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars
ForwardOnlyStep(edges) ==
    \A s \in Swaps : st'[s] = st[s] \/ st'[s] \in edges[st[s]]

ExposureBoundedBy(nonTerminal) == Exposure(nonTerminal) <= MaxExposed

AtMostOneOutcomeInv == \A s \in Swaps : Cardinality(conf[s]) <= 1

\* THE money invariant.  If the solver's sats have irreversibly left, and it
\* has not been made whole, and the machine has stopped, then a human is being
\* paged.  Anything else is a silent loss.
NoSilentLossShape(PaidOut(_), Collected(_), terminal, stuckState) ==
    \A s \in Swaps :
        (PaidOut(s) /\ ~Collected(s) /\ st[s] \in terminal) => st[s] = stuckState

EventuallyTerminal(terminal) == \A s \in Swaps : <>(st[s] \in terminal)
=============================================================================
