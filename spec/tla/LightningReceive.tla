---------------------------- MODULE LightningReceive ----------------------------
(***************************************************************************)
(* LIGHTNING RECEIVE CORRIDOR   lightning:BTC -> arkade:BTC                *)
(*                                                                         *)
(* WHICH TYPESCRIPT THIS SPECIFIES                                         *)
(*                                                                         *)
(*   src/db/receiveSwaps.ts      the durable row, LEGAL_EDGES, transition(),*)
(*                               patch(), fail(), committedSats()          *)
(*   src/receive/orchestrator.ts the whole state machine: step(),          *)
(*                               whenQuoted, whenArmed, whenFunded,        *)
(*                               whenClaimed, whenRefunding, tick(),       *)
(*                               tickAll(), EMPTY_LOCKUP_GRACE             *)
(*   src/core/receive.ts         MIN_SETTLE_WINDOW, SETTLE_SAFETY_MARGIN,  *)
(*                               UNILATERAL_RECOURSE_MARGIN (gate (d)),    *)
(*                               MAX_REFUND_HORIZON, HTLC_SECONDS_PER_BLOCK,*)
(*                               evaluateReceiveFunding                    *)
(*   src/receive/arkadeOps.ts    refundWithoutReceiverSwapScript and       *)
(*                               assertScriptMatchesRow                    *)
(*   src/receive/fundLockup.ts   the funding send and its coin reservation *)
(*   src/receive/covclaimd.ts    the optional autonomous claimer           *)
(*   src/arkade/wallet.ts        findLockups (spendableOnly) and           *)
(*                               findClaimPreimage (hash-verified)         *)
(*   src/worker.ts               the queue fan-out and its safety claim    *)
(*                                                                         *)
(* AUTHORITY FOR THE EDGE TABLE                                            *)
(*                                                                         *)
(* src/db/receiveSwaps.ts lines 40-50, verbatim:                           *)
(*                                                                         *)
(*   quoted:    ['armed', 'refused']                                       *)
(*   armed:     ['funded', 'refused']                                      *)
(*   funded:    ['claimed', 'refunding', 'stuck']                          *)
(*   claimed:   ['settled', 'stuck']                                       *)
(*   refunding: ['refunded', 'claimed', 'stuck']                           *)
(*   settled:   []                                                         *)
(*   refunded:  []                                                         *)
(*   refused:   []                                                         *)
(*   stuck:     []                                                         *)
(*                                                                         *)
(* plus src/db/receiveSwaps.ts:36-38                                       *)
(*   NON_TERMINAL = quoted armed funded claimed refunding                  *)
(*   EXPOSED      = funded claimed refunding                               *)
(*                                                                         *)
(* `Edges` below adds exactly the same two spec-only edges LightningSend    *)
(* adds — none -> {quoted, rejected} and rejected -> {} — modelling         *)
(* quote()'s INSERT-or-refuse, which in the TypeScript is a row appearing   *)
(* rather than a transition.  They are marked in the definition.  Every     *)
(* other entry diffs line for line against LEGAL_EDGES.                     *)
(*                                                                         *)
(* THE STRUCTURAL FACT THIS CORRIDOR IS DEFINED BY                         *)
(*                                                                         *)
(* THE SOLVER PAYS OUT OF ITS OWN FLOAT BEFORE IT HAS BEEN PAID.  The      *)
(* send corridor's exposure is a Lightning payment against a lockup the    *)
(* CLIENT funded; here the solver funds the Arkade lockup itself, against  *)
(* an inbound HTLC it merely HOLDS.  Three consequences shape everything:  *)
(*                                                                         *)
(*  1. `refunding` exists, and `refunding -> claimed` is a real edge.  The  *)
(*     solver's refundWithoutReceiver leaf and the counterparty's two claim *)
(*     leaves are COMPETING SPENDS OF ONE ARKADE OUTPUT, arbitrated by the  *)
(*     Arkade server, which co-signs exactly one.  `RefundAccepted` and     *)
(*     `ClientClaims` both go through SwapCore!SpendAccepted, so at most    *)
(*     one ever lands.  Losing that race is a RECOVERY, not a failure: the  *)
(*     winning claim hands the solver P, which is what it needed to settle. *)
(*     A spec that models refund as unconditionally succeeding erases this  *)
(*     whole edge and is worthless.                                         *)
(*                                                                         *)
(*  2. THE CLAIM LEAVES CARRY NO TIMELOCK.  `ClientClaims` below has no     *)
(*     clock guard at all — it is enabled from the instant the lockup is    *)
(*     funded and stays enabled forever, including after E and after        *)
(*     refund_locktime.  Only the solver's refund leaf is gated.  A spec    *)
(*     that lets the client's claim expire cannot find the loss             *)
(*     SETTLE_SAFETY_MARGIN exists to prevent.                              *)
(*                                                                         *)
(*  3. E, the held HTLC's settle deadline, is a FIRST-CLASS CLOCK BOUND     *)
(*     chosen by the ENVIRONMENT (the payer's route picks the CLTV), not by *)
(*     this service.  `htlcE` is picked nondeterministically from EChoices  *)
(*     when the HTLC arms.  MIN_SETTLE_WINDOW bounds E from `now`;          *)
(*     SETTLE_SAFETY_MARGIN bounds refund_locktime — fixed at QUOTE time —  *)
(*     from E.  Gate (b) does not imply gate (c), which is exactly why both *)
(*     exist (src/core/receive.ts:190-198), and why EChoices contains a     *)
(*     value that passes (b) and fails (c).                                 *)
(*                                                                         *)
(* WHAT IS DELIBERATELY ABSTRACTED AWAY                                     *)
(*                                                                         *)
(*  - Amounts.  Every swap is `Amount` sats; a lockup output is exactly     *)
(*    right or absent.  The exact-value adoption filter                     *)
(*    (orchestrator.ts:379) protects against stray dust, which is a         *)
(*    client-facing and grief concern, not the money invariant here.        *)
(*  - The preimage column.  P is written in the SAME UPDATE as              *)
(*    funded->claimed / refunding->claimed, so `st[s] = "claimed"` already  *)
(*    means "a hash-verified P is on disk".  findClaimPreimage never        *)
(*    returns an unverified witness (src/arkade/wallet.ts:188-227), so a    *)
(*    separate variable could only disagree with the state.                 *)
(*  - covclaimd.  `revealed_at` is a data fact, not a state, reveal() is    *)
(*    idempotent, and the shipped cli.ts passes no covclaimd at all.        *)
(*    WHO spent the lockup is invisible to whenFunded — it recovers P from  *)
(*    whatever witness it finds — so covclaimd and the client's own claim   *)
(*    are one action, `ClientClaims`.                                       *)
(*  - The reservation ledger (src/arkade/reservations.ts) and the coin      *)
(*    selection in fundLockup.ts.  Those are a liveness concern (a settle   *)
(*    racing a funding fails one with VTXO_ALREADY_SPENT) and a second      *)
(*    in-process guard the Go rewrite must replace; they do not change the  *)
(*    money invariant.  Reported rather than modelled.                      *)
(*  - The world reads inside whenFunded and whenRefunding are evaluated at  *)
(*    ACTION time, not snapshotted at row-read time.  The one place the     *)
(*    snapshot is load-bearing IS modelled: whenArmed's `alreadyFunded`     *)
(*    read is carried in loc[w].res ("sawFunded" / "sawEmpty"), because     *)
(*    that stale read is what makes two workers both call arkade.fund().    *)
(*    For the refund the snapshot costs nothing, because SpendAccepted      *)
(*    already refuses a second spend of the contested output.               *)
(*  - The event log, patch(), column allowlists, refund_locktime            *)
(*    immutability.  The last is enforced by TRANSITION_COLUMNS omitting    *)
(*    the column; here refund_locktime is simply the constant               *)
(*    RefundLocktime, which no action may write.                            *)
(*                                                                         *)
(* MODELLING DECISIONS THAT ARE ASSUMPTIONS, NOT FACTS                      *)
(*                                                                         *)
(*  (A1) E is written once, at quoted->armed, and the fresh re-poll at the  *)
(*       funding edge (orchestrator.ts:356-359) returns the SAME value.  In *)
(*       reality there are TWO values: E_stored, written once and never     *)
(*       refreshed, and E_fresh, re-derived on every read — for LND from a  *)
(*       block HEIGHT via htlcDeadlineFromHeight, so it moves as the tip    *)
(*       advances.  The funding gate uses E_fresh; whenClaimed's            *)
(*       past-E escalation uses E_stored.  Collapsing them is safe here     *)
(*       ONLY because HTLC_SECONDS_PER_BLOCK is deliberately a FLOOR        *)
(*       (src/core/receive.ts:43-71), so E_fresh can only be an             *)
(*       under-estimate.  A Go rewrite that changes that constant, or that  *)
(*       caches E, breaks the assumption.  See the report.                  *)
(*                                                                         *)
(*  (A2) The drive loop keeps up.  `Tick` is disabled while any swap has an *)
(*       immediately-completable solver step outstanding (`Urgent`).        *)
(*       Without it, "the solver stopped for 90 minutes" is a valid trace   *)
(*       and every timing guard looks broken.  It does NOT weaken the       *)
(*       concurrency model: workers still race, crash mid-action, lose      *)
(*       CASes and double-broadcast, all inside a frozen tick.  ONE         *)
(*       DELIBERATE HOLE IS LEFT IN IT: an `armed` row whose float is       *)
(*       already out is urgent only AFTER one tick has passed.  That is not *)
(*       a modelling convenience — it is the bug.  `armed` is NOT in        *)
(*       EXPOSED (receiveSwaps.ts:38), so a row in that window is invisible *)
(*       to every exposure-accounting read and the solver does not know it  *)
(*       must hurry.  One tick is the recovery-sweep interval a crash       *)
(*       costs.  See FundGateOneShot and LightningReceive_Stranded.cfg.     *)
(*                                                                         *)
(*       WHAT GATE (a) IS WORTH HERE, RECORDED BY AUDIT 2026-08-10.  The    *)
(*       gap evaluateReceiveFunding exists for — "arming and funding can be *)
(*       minutes apart, and every input here is a function of the clock"    *)
(*       (src/core/receive.ts:156-159) — IS representable, but only through *)
(*       a LAGGING `quoted` ROW: `quoted` is not Urgent, so the clock can   *)
(*       advance between ArmHtlc and SeeArmed.  Once a row is `armed` with  *)
(*       funds = 0 the global clock freezes, so the gap is never exercised  *)
(*       from `armed` itself.                                              *)
(*                                                                         *)
(*       Gate (a) does reach states nothing else reaches — deleting `clock  *)
(*       < InvoiceExpiry` from FundGateOpen grows the graph from 110,310 to *)
(*       151,067 distinct states — and STILL produces no counterexample,    *)
(*       because THE HAZARD IT GUARDS IS NOT MODELLED.  Per                 *)
(*       src/core/receive.ts:170-172 an expired BOLT11 "can be failed back  *)
(*       by the payer or any hop on the route"; this module has no action   *)
(*       by which the held HTLC dies before E — HtlcExpired is `clock >=    *)
(*       htlcE[s]` and nothing else.  Giving gate (a) teeth needs an unfair *)
(*       environment action failing the hold back once InvoiceExpiry has    *)
(*       passed.  Deliberately NOT added: such an action also fires against *)
(*       swaps funded legally at clock 0-1, whose recourse does not open    *)
(*       until RefundLocktime, so adding it asserts a loss in the SHIPPED   *)
(*       design.  That is a claim to make with evidence about the backend's *)
(*       real fail-back timing, not by fiat inside a model.  See the report.*)
(*                                                                         *)
(*  (A3) The indexer's lag is shorter than EMPTY_LOCKUP_GRACE.  After a     *)
(*       claim lands, findLockups (spendableOnly) reports the lockup gone   *)
(*       IMMEDIATELY while findClaimPreimage must still see spentBy/settledBy*)
(*       populated and fetch the spending virtual tx back.  That skew is    *)
(*       modelled exactly: `ClientClaims` sets conf, `IndexerCatchUp` later *)
(*       sets claimReadable.  `Tick` is disabled while the skew is          *)
(*       outstanding, which is the formal content of "120 seconds of grace  *)
(*       against seconds of read lag" (orchestrator.ts:76-94).  The skew is *)
(*       still fully explored WITHIN a frozen tick, which is where          *)
(*       BreakEmptyGrace finds its counterexample.                          *)
(*                                                                         *)
(*  (A4) The Arkade server is cooperative.  `Censor` is present but         *)
(*       disabled by default (ServerMayCensor = FALSE): with only the       *)
(*       co-signed leaves the corridor had no escalation — whenRefunding's  *)
(*       arkade.refund() throws, tickAll records it, the row retries        *)
(*       `refunding` forever — and Censored.cfg reported the Liveness       *)
(*       violation that was the F5 finding.  With the solo exit modelled    *)
(*       (gate (d), 2026-08) the corridor HAS an escalation the covenant    *)
(*       always carried: once fundedAt + UnilateralDelay arrives the        *)
(*       solver can spend the lockup alone, and LightningReceive_Censored   *)
(*       .cfg now reports GREEN (safety + Liveness) whenever gate (d)       *)
(*       holds.  What is STILL true of the shipped TypeScript: no src/      *)
(*       code spends the solo leaf yet (TODO(unilateral-exit) in            *)
(*       src/arkade/covenant.ts), so the F5 finding survives as a           *)
(*       statement about shipped code, not the covenant.                    *)
(*                                                                         *)
(*  (A5) The refund's absolute CLTV matures against the chain tip's         *)
(*       timestamp, not wall clock, so a push at exactly refund_locktime    *)
(*       can be refused with FORFEIT_CLOSURE_LOCKED until the next block.   *)
(*       That is modelled as `RefundAccepted` simply not being taken yet —  *)
(*       the worker parks via GiveUp and the next tick retries, which is    *)
(*       literally what the TypeScript does.  The refund is NEVER modelled  *)
(*       as unconditionally succeeding: it can also lose outright to a      *)
(*       claim (SpendAccepted), which is the whole point of the corridor.   *)
(*                                                                         *)
(* WHAT A GO IMPLEMENTER MUST PRESERVE                                      *)
(*                                                                         *)
(*  1. arkade.fund() must be single-shot per swap NO MATTER HOW MANY        *)
(*     GOROUTINES CALL IT.  Today nothing durable provides that: the CAS    *)
(*     runs AFTER the money moves (orchestrator.ts:381 then :391), and only *)
(*     the in-process `inFlight` Set at :291 serialises callers.  See        *)
(*     ArkadeHonoursFundKey and LightningReceive_DoubleFund.cfg.            *)
(*  2. The funding gate must be ONE-SHOT.  Re-running                       *)
(*     evaluateReceiveFunding on a retry after the float is already out can *)
(*     drive the row to terminal `refused` — a state with no outgoing edge  *)
(*     and no refund sweep on this corridor.  See FundGateOneShot and       *)
(*     LightningReceive_Stranded.cfg.                                       *)
(*  3. The late-claim recheck must run BEFORE every refund push, on every   *)
(*     tick.  See RefundingSeesClaim.                                       *)
(*  4. `stuck` must never be entered on a single observation of an empty    *)
(*     lockup.  See RefundingEmpty and LightningReceive_Grace.cfg.          *)
(*  5. The exposure cap must be enforced by the same write that consumes    *)
(*     it.  See AtomicAdmission and LightningReceive_Overexposed.cfg.       *)
(*  6. The solver's solo refund leaf must be implemented                    *)
(*     (FundedSoloRefund, RefundingSoloRefund): it is the only              *)
(*     recovery path that survives an Arkade server outage once             *)
(*     the co-signed refund is unavailable, and                             *)
(*     LightningReceive_Censored.cfg's GREEN result applies to the          *)
(*     covenant alone until it ships — the F5 finding is about the          *)
(*     solver software.  See gate (d) and TODO(unilateral-exit) in          *)
(*     src/arkade/covenant.ts.                                              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC, SwapCore

CONSTANTS
    RefundLocktime,        \* refund_locktime = quote time + MAX_REFUND_HORIZON.
                           \* Fixed at insert, IMMUTABLE: the covenant pkScript is
                           \* derived from it (receiveSwaps.ts:52-63, 96-101).
    InvoiceExpiry,         \* invoice_expires_at = quote time + DEFAULT_HOLD_INVOICE_WINDOW
    MinSettleWindow,       \* MIN_SETTLE_WINDOW      (90 min)  gate (b)
    SettleSafetyMargin,    \* SETTLE_SAFETY_MARGIN   (15 min)  gate (c)
    EmptyLockupGrace,      \* EMPTY_LOCKUP_GRACE     (120 s)   see ASSUME below
    EChoices,              \* the values of E the environment may pick when the HTLC arms
    UnilateralDelay,       \* the CSV delay on the solver's SOLO refund leaf, from
                           \* funding confirmation.  Gate (d) prices it against E.
    RecourseMargin,        \* UNILATERAL_RECOURSE_MARGIN (30 min): operator time to
                           \* run the solo exit between the leaf opening and E
    BreakSettleMargin,     \* MUTATION: drop gate (c) — the MANDATED mutation check
    BreakRecourseMargin,   \* MUTATION: drop gate (d) — the #69 both-sides window
    BreakEmptyGrace,       \* MUTATION: escalate to `stuck` on ONE empty read
    ArkadeHonoursFundKey,  \* MUTATION: arkade.fund is idempotent per swap key
    FundGateOneShot,       \* MUTATION: the funding gate is re-evaluated after funding
    AtomicAdmission,       \* MUTATION: quote() is one conditional INSERT
    SettleIsIdempotent,    \* settleHold on an already-settled hold is a no-op, not a throw
    ServerMayCensor        \* let the Arkade server stop co-signing (see (A4))

(***************************************************************************)
(* THE CONSTANT ORDERING IS THE WHOLE CONTENT OF THE TIMING GUARDS.        *)
(*                                                                         *)
(* The one that matters is gate (c): funding is admissible only when       *)
(*                                                                         *)
(*     RefundLocktime + SettleSafetyMargin <= E                            *)
(*                                                                         *)(*                                                                         *)
(* i.e. the solver's own recourse opens STRICTLY BEFORE the inbound HTLC   *)
(* dies.  EChoices must therefore contain at least one value satisfying it *)
(* and at least one violating it while still satisfying gate (b), because  *)
(* "gate (b) does not imply gate (c)" is the reason gate (c) exists.       *)
(***************************************************************************)
ASSUME InvoiceExpiry <= RefundLocktime          \* the hold window is far shorter than
                                                \* MAX_REFUND_HORIZON (600 s vs 7200 s)
ASSUME RefundLocktime <= MaxClock
ASSUME EChoices \subseteq 1..MaxClock
ASSUME \E e \in EChoices : RefundLocktime + SettleSafetyMargin <= e   \* gate (c) can pass
ASSUME \E e \in EChoices : RefundLocktime + SettleSafetyMargin > e    \* gate (c) can fail
\* Gate (d) deliberately has NO such ASSUME pair: like gate (b), whether it
\* can pass and fail on its own is a property of each cfg's constant tuning,
\* not of the module — the green cfg below refuses E = 4 on gate (d) alone,
\* and LightningReceive_RecourseMargin.cfg isolates the guard.  An ASSUME
\* here would force every mutation cfg to carry constants in which gate (d)
\* is live even when the mutation under test has nothing to do with it.
\* The model realises EMPTY_LOCKUP_GRACE as exactly one tick (the `aged` flag),
\* which keeps the clock dimension out of the refunding variables.  The constant
\* is kept so the relation to (A3) stays visible: the grace must exceed the
\* indexer skew, and (A3) is the formal statement that it does.
ASSUME EmptyLockupGrace = 1

VARIABLES
    funds,          \* [Swaps -> 0..2] amount-sized outputs the SOLVER paid into the
                    \* lockup script out of its own float.  >1 is a real double
                    \* payment: the covenant claim leaf sweeps WHOLE vtxos, so a
                    \* client claims one and the other is invisible to the row forever.
    htlcE,          \* [Swaps -> {0} \cup EChoices]  E, the held HTLC's settle deadline.
                    \* 0 == not armed.  Chosen by the ENVIRONMENT at arm time; written
                    \* once by quoted->armed and never refreshed (orchestrator.ts:342).
    settled,        \* [Swaps -> BOOLEAN] ln.settleHold(P) succeeded — the solver COLLECTED
    claimReadable,  \* [Swaps -> BOOLEAN] findClaimPreimage can now recover P from the
                    \* spending virtual tx.  Trails conf; see (A3).
    aged,            \* [Swaps -> BOOLEAN] a tick has passed while the row sat in
                    \* `refunding` (EMPTY_LOCKUP_GRACE) or sat in `armed` with the
                    \* solver's float already out (the recovery-sweep interval, (A2)).
    fundedAt         \* [Swaps -> 0..MaxClock] the +1-shifted clock tick at which the
                    \* armed->funded CAS landed; 0 = not yet funded.  The solo
                    \* leaves' CSVs run from FUNDING CONFIRMATION and the +1 is the
                    \* confirm tick.  Gate (d) and SoloMatured both read it.

LrVars == << funds, htlcE, settled, claimReadable, aged, fundedAt >>
vars   == << clock, st, loc, conf, serverUp,
             funds, htlcE, settled, claimReadable, aged, fundedAt >>

(***************************************************************************)
(* SwapCore constants supplied by cfg definition override.                 *)
(***************************************************************************)
LRPhases     == { "idle", "read", "fundSent", "settleSent", "refundSent" }
LRResults    == { "none", "capOk", "capFull", "sawFunded", "sawEmpty" }
LRSpendKinds == { "clientClaim", "solverRefund" }

(***************************************************************************)
(* THE EDGE TABLE.  Diff this against src/db/receiveSwaps.ts:40-50 — with  *)
(* ONE deliberate addition: funded -> refunded, the solo exit no shipped   *)
(* code spends yet (TODO(unilateral-exit) in src/arkade/covenant.ts).  The *)
(* edge exists here because gate (d)'s protection is unverifiable without  *)
(* the leaf it prices — the same contract-first stance as                  *)
(* ArkadeHonoursFundKey.  The shipped table gains this edge when the solo  *)
(* exit ships; until then transition() would throw on it in production.    *)
(***************************************************************************)
Row   == { "quoted", "armed", "funded", "claimed", "settled",
           "refunding", "refunded", "refused", "stuck" }
AllSt == Row \cup { "none", "rejected" }   \* the two spec-only pre-row markers

Edges == [ x \in AllSt |->
    CASE x = "none"      -> { "quoted", "rejected" } \* SPEC ONLY: quote() inserts or refuses
      [] x = "rejected"  -> { }                      \* SPEC ONLY: no row was ever created
      [] x = "quoted"    -> { "armed", "refused" }
      [] x = "armed"     -> { "funded", "refused" }
      [] x = "funded"    -> { "claimed", "refunding", "refunded", "stuck" }
      [] x = "claimed"   -> { "settled", "stuck" }
      [] x = "refunding" -> { "refunded", "claimed", "stuck" }
      [] x = "settled"   -> { }
      [] x = "refunded"  -> { }
      [] x = "refused"   -> { }
      [] x = "stuck"     -> { } ]

NonTerminal == { "quoted", "armed", "funded", "claimed", "refunding" }
Exposed     == { "funded", "claimed", "refunding" }
Terminal    == { "settled", "refunded", "refused", "stuck", "rejected" }
Drivable    == NonTerminal \cup { "none" }   \* findRecoverable(), plus the quote handler

(***************************************************************************)
(* MONEY.  These two predicates are the seam SwapCore's NoSilentLossShape  *)
(* is instantiated with.                                                   *)
(*                                                                         *)
(* Note the inversion relative to LightningSend: there PaidOut was a       *)
(* Lightning payment and Collected was an Arkade claim.  Here PaidOut is   *)
(* the ARKADE funding out of the solver's own float, and the solver is     *)
(* made whole either by settling the held HTLC (the swap succeeded) or by  *)
(* winning the refund race (the swap failed but the float came back).      *)
(***************************************************************************)
PaidOut(s)          == funds[s] > 0
Collected(s)        == settled[s] \/ SpentBy(s, "solverRefund")
ClientTookLockup(s) == SpentBy(s, "clientClaim")

\* The inbound HTLC is dead.  There is deliberately no cancelHold: past E the
\* backend fails a stale hold back on its own (orchestrator.ts:488-489), so
\* this is a one-way door with no action of ours behind it.
HtlcExpired(s) == htlcE[s] # 0 /\ clock >= htlcE[s]
HtlcLost(s)    == HtlcExpired(s) /\ ~settled[s]

--------------------------------------------------------------------------
(***************************************************************************)
(* GUARDS.  Evaluated on the CURRENT clock, at the instant before the      *)
(* money moves — evaluateReceiveFunding "MUST be called immediately before *)
(* funding, never at arming time" (src/core/receive.ts:152-160), because   *)
(* arming and funding can be minutes apart and every input is a function   *)
(* of the clock.                                                           *)
(***************************************************************************)

\* evaluateReceiveFunding, src/core/receive.ts:167-201.  Subtraction is written
\* as addition throughout so Naturals never goes negative.
\*
\* AUDIT FINDING, 2026-08-10 — GATE (b) IS DEAD CODE, IN THE MODEL AND IN THE
\* SHIPPED TYPESCRIPT.  Gate (a) and gate (c) together IMPLY gate (b), so
\* `settle_window_too_short` is a refusal reason that can never be reached:
\*
\*   refund_locktime  = T + MAX_REFUND_HORIZON        (orchestrator.ts:234)
\*   invoice_expires  = T + DEFAULT_HOLD_INVOICE_WINDOW (orchestrator.ts:249,262)
\*   (a) holds  =>  now < T + 600
\*   (c) holds  =>  E  >= refund_locktime + 900 = T + 8100
\*   (b) needs  =>  E  >= now + 5400,  and now + 5400 < T + 6000 <= T + 8100 <= E
\*
\* i.e. MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN - DEFAULT_HOLD_INVOICE_WINDOW
\* = 7500 s already exceeds MIN_SETTLE_WINDOW = 5400 s.  Deleting the (b)
\* conjunct below reproduces LightningReceive.cfg's state graph EXACTLY
\* (681,074 states, 110,310 distinct, no error), so this spec gives
\* MIN_SETTLE_WINDOW no teeth AND CANNOT — the constant is currently carried by
\* MAX_REFUND_HORIZON, not by itself.  A Go rewrite that shortens
\* MAX_REFUND_HORIZON, or lengthens DEFAULT_HOLD_INVOICE_WINDOW, makes gate (b)
\* live again; at that point this model must be re-tuned to exercise it.
\* RE-AUDITED 2026-08-30 on the gate-(d) model: deleting the (b) conjunct
\* still reproduces the green cfg's reachable set exactly (283,813 distinct
\* states, 0 left on queue, no error) — at these constants gate (d) subsumes
\* (b), so MIN_SETTLE_WINDOW is still carried by MAX_REFUND_HORIZON alone.
\*
\* GATE (d) ARRIVED LATER (2026-08, the #69 fix) and is modelled below as the
\* BreakRecourseMargin conjunct, together with the two solo leaves it prices:
\* the trader's unilateral claim (the #69 attacker, modelled for the first
\* time — it needs NO server) and the solver's solo refund leaf (shipped in
\* the covenant, spendable by NO src/ code yet — TODO(unilateral-exit) in
\* src/arkade/covenant.ts — so the action below is the requirement the Go
\* rewrite must meet, the same way ArkadeHonoursFundKey states a property the
\* current process-level Set merely stands in for).
FundGateOpen(s) ==
    /\ clock < InvoiceExpiry                              \* (a) invoice_expired
    /\ htlcE[s] # 0                                       \*     htlc_not_armed
    /\ clock < htlcE[s]                                   \*     (a stale hold is not armed)
    /\ clock + MinSettleWindow <= htlcE[s]                \* (b) settle_window_too_short
    /\ ( BreakSettleMargin                                \* <<< THE MANDATED MUTATION
         \/ RefundLocktime + SettleSafetyMargin <= htlcE[s] )  \* (c) refund_deadline_too_late
    /\ ( BreakRecourseMargin                              \* <<< MUTATION: the #69 window
         \/ clock + UnilateralDelay + RecourseMargin <= htlcE[s] )  \* (d) unilateral_recourse_after_htlc

\* The solver's SOLO refund leaf opened: fundedAt + UnilateralDelay has arrived.
\* Shipped as gate (d) at src/core/receive.ts:188-195 with
\* UNILATERAL_RECOURSE_MARGIN, after #69: with the Arkade server gone the
\* trader's unilateralClaim opens first, and a swap funded into the window
\* where E passes before OUR leaf opens pays out and cannot be recovered —
\* the counterparty takes the payout AND keeps their HTLC.  The shipped gate
\* has an operator knob, acceptUnilateralGap, that declines the check; the
\* model covers the default, acceptUnilateralGap = FALSE.
\*
\* Note the model's UnilateralDelay is measured from the +1-shifted fundedAt,
\* i.e. from confirmation, exactly like the shipped constant; the gate above
\* evaluates at the fund tick, which is the same instant the shipped gate
\* runs ("MUST be called immediately before funding").
SoloMatured(s) == fundedAt[s] # 0 /\ clock >= fundedAt[s] + UnilateralDelay

\* THE GATE'S SCOPE.  With FundGateOneShot the gate is asked once, at the
\* decision to fund, and everything after the fund call is unconditional —
\* which is what a Go rewrite must do.  Without it (today's TypeScript) the
\* gate is re-run on EVERY armed tick, including a retry after arkade.fund()
\* already succeeded, so the guard whose whole job is protecting money can be
\* the thing that discards the recourse.
GateAdmits(s) == FundGateOpen(s) \/ (FundGateOneShot /\ funds[s] > 0)

\* arkade.findLockups(pkScript) is getVtxos({spendableOnly: true}), so it goes
\* empty the instant ANY spend lands.  "Empty" therefore conflates "never
\* funded" with "already claimed" — which is exactly why the crash-recovery
\* adoption read at orchestrator.ts:379 is incomplete.
IndexerShowsFunded(s) == funds[s] > 0 /\ ~Spent(s)

\* arkade.findClaimPreimage(outpoint, H) — returns a value ONLY when it hashes
\* to the payment hash (src/arkade/wallet.ts:188-227).  Trails findLockups; see (A3).
ClaimReadable(s) == SpentBy(s, "clientClaim") /\ claimReadable[s]

\* EMPTY_LOCKUP_GRACE.  Realised as one tick; see the ASSUME above.
GraceElapsed(s) == BreakEmptyGrace \/ aged[s]      \* <<< MUTATION POINT

--------------------------------------------------------------------------
(***************************************************************************)
(* ENVIRONMENT.  An adversary within physical limits.                      *)
(***************************************************************************)

\* A payer's HTLC arms against the hold invoice, and the BACKEND — not this
\* service — picks E.  `evaluateReceiveFunding`'s own comment says it plainly:
\* "The backend picks this value and may pick one shorter than its documented
\* norm; a hardcoded guess that runs long is exactly the case where the
\* provider pays out and cannot collect" (src/core/receive.ts:126-131).
ArmHtlc(s, e) ==
    /\ htlcE[s] = 0
    /\ st[s] \notin { "none", "rejected" }      \* the invoice exists once the row does
    /\ clock < InvoiceExpiry                    \* a lapsed BOLT11 cannot be paid
    /\ e \in EChoices
    /\ htlcE' = [htlcE EXCEPT ![s] = e]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << funds, settled, claimReadable, aged, fundedAt >>

\* THE ADVERSARIAL SPEND.  Either the client's own `claim` leaf (P + receiver +
\* server) or covclaimd's `nonInteractiveClaim` leaf (server + emulator, pinned
\* to the client's payout script).  NEITHER CARRIES A TIMELOCK: both are
\* spendable from the instant the lockup is funded and remain spendable
\* forever, including after E and after refund_locktime.  That unbounded
\* window is the asymmetry SETTLE_SAFETY_MARGIN exists to survive.
\*
\* SpendAccepted requires conf = {}: the Arkade server is in the signer set of
\* all three leaves and co-signs exactly one spend of the vtxo.  There is no
\* mempool and no reorg, so acceptance and confirmation coincide.
ClientClaims(s) ==
    /\ funds[s] > 0
    /\ serverUp
    /\ SpendAccepted(s, "clientClaim")
    /\ UNCHANGED << clock, st, loc, serverUp >>
    /\ UNCHANGED LrVars

\* The trader's SOLO claim leaf — the #69 attacker, modelled here for the
\* first time.  Standard Arkade client tooling spends the payout lockup
\* ALONE once its own CSV matures, which the shipped covenant arranges to
\* happen well before the solver's without-receiver leaf opens — that
\* asymmetry is the whole content of gate (d).  Solo spends forfeit to L1,
\* so a censoring Arkade server does NOT disable this action the way it
\* disables ClientClaims: it needs ~serverUp, not serverUp.
\*
\* "Matured" is abstracted as "the held HTLC is dead": before E, claiming
\* the lockup still costs the client their HTLC, so taking both sides is
\* possible only from E on — the first instant the claim is free money.
\* The guard is deliberately row-state-blind: the client's leaf does not
\* care whether our row reads `funded` or `refunding`, and neither should
\* the model.  Consequence: under censorship a row that reaches either
\* state with E un-passed-but-coming can lose the lockup — see
\* LightningReceive_Censored.cfg, whose "safety is untouched" narrative
\* predates this action and no longer holds.
ClientUnilateralClaim(s) ==
    /\ ~serverUp
    /\ funds[s] > 0
    /\ HtlcExpired(s)
    /\ SpendAccepted(s, "clientClaim")
    /\ UNCHANGED << clock, st, loc, serverUp >>
    /\ UNCHANGED LrVars

\* The spending virtual transaction becomes fetchable, so findClaimPreimage can
\* finally recover P.  This is the SECOND of the two Arkade reads and it always
\* trails the first; the gap between them is what EMPTY_LOCKUP_GRACE covers.
IndexerCatchUp(s) ==
    /\ SpentBy(s, "clientClaim")
    /\ ~claimReadable[s]
    /\ claimReadable' = [claimReadable EXCEPT ![s] = TRUE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, aged, fundedAt >>

Censor == ServerMayCensor /\ CensorCore /\ UNCHANGED LrVars

(***************************************************************************)
(* (A2)/(A3): the clock does not advance while the solver has work it could *)
(* finish right now, nor while the indexer skew of (A3) is outstanding.     *)
(***************************************************************************)
LagOutstanding == \E s \in Swaps : SpentBy(s, "clientClaim") /\ ~claimReadable[s]

Urgent(s) ==
    \/ st[s] = "none"                                       \* admission settles at clock 0
    \* whenArmed funds or refuses NOW — EXCEPT in the one window where the
    \* solver does not know it is exposed: float out, row still `armed`, which
    \* is NOT in EXPOSED.  One tick (a recovery-sweep interval) may pass there.
    \/ (st[s] = "armed" /\ (funds[s] = 0 \/ aged[s]))
    \/ (st[s] = "funded" /\ ClaimReadable(s))               \* record the claim, then settle
    \* The refund deadline is up.  (A2) freezes the clock only while the solver
    \* has work it could finish RIGHT NOW: with the server up that is the
    \* co-signed refund, with it down the solo leaf once matured.  If NEITHER
    \* exists — server censoring, solo leaf not open yet — no recovery action
    \* is available at all, so real time passes: Tick must run, or the #69
    \* window this gate family exists for could never be reached.
    \/ (st[s] = "funded" /\ clock >= RefundLocktime /\ (serverUp \/ SoloMatured(s)))
    \/ (st[s] = "claimed" /\ ~settled[s])                   \* settle before E
    \* Same for the solo exit from a `refunding` row: with the Arkade server
    \* down a matured solo leaf is work the solver could finish RIGHT NOW, and
    \* without this conjunct the (A2) relaxation above would let the clock run
    \* from maturity to E in two ticks — faster than the read -> act -> record
    \* chain the exit needs — and hand the trader's solo claim the race by
    \* default (the RecourseControl counterexample).
    \/ (st[s] = "refunding" /\ ~Spent(s) /\ SoloMatured(s))
    \/ (st[s] = "refunding" /\ ClaimReadable(s))            \* the late-claim recovery
    \/ (st[s] = "refunding" /\ ~Spent(s) /\ serverUp)       \* push the refund

SolverBehind == \E s \in Swaps : Urgent(s)

Tick ==
    /\ TickCore
    /\ ~SolverBehind
    /\ ~LagOutstanding
    /\ aged' = [s \in Swaps |-> \/ st[s] = "refunding"
                                \/ (st[s] = "armed" /\ funds[s] > 0)]
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, fundedAt >>

--------------------------------------------------------------------------
(***************************************************************************)
(* WORKER ACTIONS.  One named operator per orchestrator function, so the   *)
(* Go rewrite can be diffed against them one for one.                      *)
(***************************************************************************)

\* store.get(id) / findRecoverable(), and — in the same breath — whatever else
\* the handler samples before it acts.  For a `none` row that is
\* committedSats(); for an `armed` row it is whenArmed's `alreadyFunded` read
\* (orchestrator.ts:379), which is THE snapshot two concurrent funders both
\* trust.  ALWAYS a separate step from the write that follows it.
ReadSwap(w, s) ==
    /\ ReadRowWith(w, s, Drivable,
           CASE st[s] = "none"  ->
                    IF Exposure(NonTerminal) + Amount <= MaxExposed
                      THEN "capOk" ELSE "capFull"
             [] st[s] = "armed" ->
                    IF IndexerShowsFunded(s) THEN "sawFunded" ELSE "sawEmpty"
             [] OTHER -> "none")
    /\ UNCHANGED LrVars

\* step() returned false with nothing to do, or the CAS was lost silently, or
\* the RPC threw and the exception propagated out of tick() into tickAll's
\* onTickError.  (A5) rides on this one: a refund refused with
\* FORFEIT_CLOSURE_LOCKED leaves the row in `refunding` and retries next tick.
GiveUp(w) ==
    /\ loc[w].phase = "read"
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED LrVars

Crash(w) == CrashCore(w) /\ UNCHANGED LrVars

(***** quote() : src/receive/orchestrator.ts:196-286 ***********************)

\* insertQuote().  The partial UNIQUE index on payment_hash
\* (receiveSwaps.ts:136-138) makes the INSERT itself single-winner, modelled
\* by the CAS on "none".  There is NO equivalent backstop for the exposure
\* cap: with AtomicAdmission = FALSE the insert trusts the snapshot verdict,
\* which is today's TypeScript (orchestrator.ts:217-219 then :257).
\*
\* Note the corridor's own ordering quirk is invisible here on purpose:
\* ln.createHoldInvoice is minted BEFORE the row is persisted, uniquely among
\* the four quote()s.  A crash in between leaves an orphaned hold nobody can
\* pay — the BOLT11 never left the process — so it moves no money and needs no
\* state.
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
    /\ UNCHANGED LrVars

(***** whenQuoted : src/receive/orchestrator.ts:338-348 ********************)

\* ln.getHoldState(H).status === 'armed'.  THE ONLY WRITE OF E ANYWHERE IN THE
\* CORRIDOR (orchestrator.ts:342) — no later transition refreshes it.  The
\* column lands in the SAME UPDATE as the state change, which is why `armed`
\* always carries an E and whenClaimed's null-E guard is unreachable.
SeeArmed(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ htlcE[s] # 0
    /\ clock < htlcE[s]                     \* a hold past E no longer reports 'armed'
    /\ IF st[s] = "quoted"
         THEN /\ st'   = [st   EXCEPT ![s] = "armed"]
              /\ aged' = [aged EXCEPT ![s] = FALSE]
         ELSE /\ UNCHANGED st
              /\ UNCHANGED aged
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, fundedAt >>

\* Nothing ever armed and the hold invoice has lapsed.  store.fail routes to
\* `refused` because `quoted` is not in EXPOSED.  No capital was ever out.
RefuseQuoted(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ ~(htlcE[s] # 0 /\ clock < htlcE[s])
    /\ clock >= InvoiceExpiry
    /\ \/ CasWon(s, "quoted", "refused")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

(***** whenArmed : src/receive/orchestrator.ts:350-396 *********************)

\* evaluateReceiveFunding declined.  THE CORRIDOR'S SHARPEST HOLE LIVES HERE.
\* store.fail(id, 'armed', ...) routes to `refused` because `armed` is not in
\* EXPOSED (receiveSwaps.ts:38) — and `refused` is terminal, has no outgoing
\* edge, and this corridor has NO refundSweep.  If the solver's float is
\* already in the lockup when this fires, it is stranded permanently.
\* FundGateOneShot is what closes it: with the gate asked once, ~GateAdmits
\* implies funds = 0 here.
RefuseArmed(w, s) ==
    /\ Saw(w, s, "armed")
    /\ ~GateAdmits(s)
    /\ \/ CasWon(s, "armed", "refused")
       \/ CasLost(s, "armed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* THE IRREVERSIBLE ACT, AND IT HAPPENS BEFORE THE CAS.
\* arkade.fund(lockupAddress, amountSats) -> fundLockup -> wallet.sendBitcoin,
\* at orchestrator.ts:381; the compare-and-swap that records it is at :391.
\* There is no intent-commit state and NO IDEMPOTENCY KEY OF ANY KIND — the
\* send corridor's `funded -> paying` CAS-before-payInvoice has no counterpart
\* here.  Two workers whose `alreadyFunded` snapshots both read empty both call
\* fund(), and the CAS then decides only which of the two broadcasts gets its
\* outpoint recorded.  ArkadeHonoursFundKey is the property a Go rewrite must
\* supply; today only the in-process `inFlight` Set stands in for it.
FundLockup(w, s) ==
    /\ Saw(w, s, "armed")
    /\ loc[w].res = "sawEmpty"          \* the SNAPSHOT, not a fresh read
    /\ GateAdmits(s)
    /\ \/ \* the key already owns a funding; the backend repeats it.
          \* funds[s] >= 2 is the model's counter cap, not a code behaviour:
          \* NoDoubleFund has already failed by then and the branch exists only
          \* so the action never becomes disabled and fakes a livelock.
          /\ (ArkadeHonoursFundKey \/ funds[s] >= 2)
          /\ funds[s] > 0
          /\ UNCHANGED funds
          /\ UNCHANGED fundedAt
       \/ \* a funding is created.  If one already existed and there is no key,
          \* this is the second one: the solver has paid amountSats twice.
          /\ ~(ArkadeHonoursFundKey /\ funds[s] > 0)
          /\ funds[s] < 2
          /\ funds' = [funds EXCEPT ![s] = funds[s] + 1]
          \* The confirmation tick the solo leaves' CSVs run from is decided by
          \* the ACT, not the later record CAS: a worker may crash between them
          \* and the recovered row must not inherit the RECOVERY's clock as its
          \* funding time (that was the RecourseControl counterexample: a late
          \* record pushed maturity past E).  funds[s] = 0 is the only writer.
          /\ IF funds[s] = 0
               THEN fundedAt' = [fundedAt EXCEPT ![s] = clock + 1]
               ELSE UNCHANGED fundedAt
    /\ Advance(w, "fundSent", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << htlcE, settled, claimReadable, aged >>
\* The crash-recovery adoption branch: an exact-value output is already at the
\* script, so fund() is skipped entirely (orchestrator.ts:379-382).  This is
\* what makes a crash between the send and the CAS free — but only while the
\* lockup is still SPENDABLE, which is why `sawEmpty` after a claim sends the
\* solver back through FundLockup instead.  funds AND fundedAt both survive
\* the crash (they are world state, not worker state), so the funding time —
\* and with it the solo leaves' maturity — is the ORIGINAL act's, not the
\* adoption's clock.
FundAdopt(w, s) ==
    /\ Saw(w, s, "armed")
    /\ loc[w].res = "sawFunded"
    /\ GateAdmits(s)
    /\ Advance(w, "fundSent", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED LrVars

\* The armed->funded compare-and-swap, carrying the funded outpoint
\* (orchestrator.ts:391-395).  A crash before this leaves the float out on a
\* row that reads `armed` — not EXPOSED, invisible to committedSats().
\* fundedAt was already written by the fund ACT (see FundLockup); the record
\* only lands the row state.
RecordFund(w, s) ==
    /\ At(w, s, "fundSent")
    /\ \/ CasWon(s, "armed", "funded")
       \/ CasLost(s, "armed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, aged, fundedAt >>

(***** whenFunded : src/receive/orchestrator.ts:398-444 ********************)

\* orchestrator.ts:411-412.  The refund-deadline check runs BEFORE the reveal
\* attempt on purpose: revealToCovclaimd can throw, and a check placed after it
\* would never be reached while covclaimd stays down, silently defeating the
\* whole reason SETTLE_SAFETY_MARGIN exists.
FundedToRefunding(w, s) ==
    /\ Saw(w, s, "funded")
    /\ ~Spent(s)                            \* findLockups returned outputs
    /\ clock >= RefundLocktime
    /\ IF st[s] = "funded"
         THEN /\ st'   = [st   EXCEPT ![s] = "refunding"]
              /\ aged' = [aged EXCEPT ![s] = FALSE]   \* the grace clock starts here
         ELSE /\ UNCHANGED st
              /\ UNCHANGED aged
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, fundedAt >>

\* orchestrator.ts:429-434.  Someone spent the lockup and findClaimPreimage
\* recovered a HASH-VERIFIED P.  This service does not care WHO — the client,
\* covclaimd, or nobody at all — which is precisely why the corridor is correct
\* with covclaimd absent.
FundedSeesClaim(w, s) ==
    /\ Saw(w, s, "funded")
    /\ Spent(s)                             \* findLockups returned []
    /\ ClaimReadable(s)
    /\ \/ CasWon(s, "funded", "claimed")    \* P lands in the SAME UPDATE
       \/ CasLost(s, "funded")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* orchestrator.ts:436-442.  The lockup is gone and nothing is provable yet.
\* Before the deadline this branch returns false and keeps waiting, because it
\* is indistinguishable from ordinary read lag; `refunding`'s own recheck
\* covers it resolving a moment later.
FundedEmptyToRefunding(w, s) ==
    /\ Saw(w, s, "funded")
    /\ Spent(s)
    /\ ~ClaimReadable(s)
    /\ clock >= RefundLocktime
    /\ IF st[s] = "funded"
         THEN /\ st'   = [st   EXCEPT ![s] = "refunding"]
              /\ aged' = [aged EXCEPT ![s] = FALSE]
         ELSE /\ UNCHANGED st
              /\ UNCHANGED aged
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, fundedAt >>

\* THE SOLVER'S SOLO REFUND LEAF.  The covenant's unilateral exit
\* (client=solver alone, no Arkade server) — the recourse gate (d) prices,
\* and the ONLY one that survives censorship.  Nothing in src/ spends this
\* leaf yet: TODO(unilateral-exit) in src/arkade/covenant.ts.  The action is
\* therefore the requirement the Go rewrite must meet, exactly the way
\* ArkadeHonoursFundKey states a property the in-process inFlight Set merely
\* stands in for today; restricting it to ~serverUp keeps the green model
\* honest (with the server up the co-signed RefundAccepted is the shipped
\* path) and loses nothing, since the solo leaf only decides outcomes the
\* co-signed path cannot reach.
\*
\* Fair with the other acts: it is the solver's own recovery software.  An
\* unfair solver could skip the refund forever and gate (d) would be
\* unverifiable — the mutation's counterexample exists only because this is
\* fair and the trader's claim is not.
FundedSoloRefund(w, s) ==
    /\ Saw(w, s, "funded")
    /\ ~serverUp
    /\ SoloMatured(s)
    /\ ~Spent(s)
    /\ SpendAccepted(s, "solverRefund")
    /\ Advance(w, "refundSent", "none")
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, aged, fundedAt >>

\* The solo refund's record step, split from the act by the ActStep/RecordStep
\* discipline: a crash between them must not be able to re-pay or lose the
\* spend.  The row is `funded`, not `refunding`, so RecordRefund's CAS does
\* not apply — this is the funded->refunded recording the solo exit needs.
\* It requires st = "funded" outright (the only state the solo act left
\* behind): if the row moved on meanwhile (FundedEmptyToRefunding can race
\* it), RecordRefund's CasLost branch parks the worker instead, and the
\* refunding/recovery paths take over.
\* Note for the Go rewrite: through that race the recovery paths can
\* park the row in `stuck` with the solo-refund spend already Collected
\* — `stuck` denoting a completed solo refund there, not only an
\* anomaly (raised in review of the gate-(d) PR; NoSilentLoss treats the
\* row as loud because Collected holds).  The spend itself is already Collected
\* either way.
FundedSoloRecord(w, s) ==
    /\ At(w, s, "refundSent")
    /\ st[s] = "funded"
    /\ CasWon(s, "funded", "refunded")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, aged, fundedAt >>

\* The same solo exit from a `refunding` row.  The row state is bookkeeping:
\* the covenant leaf the solver can spend alone is the same vtxo from either
\* state, and a row that reached `refunding` before the server started
\* censoring (the shipped FundedToRefunding path) must not lose the recourse
\* gate (d) promised it.  The record reuses RecordRefund — refunding ->
\* refunded IS a shipped edge, so no edge-table addition is needed here.
RefundingSoloRefund(w, s) ==
    /\ Saw(w, s, "refunding")
    /\ ~serverUp
    /\ SoloMatured(s)
    /\ ~Spent(s)
    /\ SpendAccepted(s, "solverRefund")
    /\ Advance(w, "refundSent", "none")
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED << funds, htlcE, settled, claimReadable, aged, fundedAt >>

(***** whenClaimed : src/receive/orchestrator.ts:467-497 *******************)

\* ln.settleHold(P).  IRREVERSIBLE AND PRE-CAS (orchestrator.ts:474-475):
\* this is the instant the solver finally collects, and a crash between it and
\* the transition leaves a row saying `claimed` on money already received.
SettleHold(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ ~settled[s]
    /\ clock < htlcE[s]                     \* past E the hold is gone; nothing to settle
    /\ settled' = [settled EXCEPT ![s] = TRUE]
    /\ Advance(w, "settleSent", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED << funds, htlcE, claimReadable, aged, fundedAt >>

\* The crash-recovery retry.  There is no `settled_at` data fact analogous to
\* `revealed_at`, so a resumed process CANNOT tell "settle not yet attempted"
\* from "settle already succeeded".  Whether re-settling an already-settled
\* hold is a no-op or an error is a property of the BACKEND, not of the row.
SettleRetry(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ settled[s]
    /\ SettleIsIdempotent
    /\ Advance(w, "settleSent", "none")
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED LrVars

RecordSettle(w, s) ==
    /\ At(w, s, "settleSent")
    /\ \/ CasWon(s, "claimed", "settled")
       \/ CasLost(s, "claimed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* orchestrator.ts:490-493.  Past E the held HTLC is gone regardless — there is
\* no cancelHold and the backend fails a stale hold back on its own — so
\* nothing could still succeed by retrying.  A settle failure BEFORE E is
\* re-thrown instead (modelled by GiveUp), leaving the row `claimed`.
\*
\* With SettleIsIdempotent FALSE this is also a FALSE-NEGATIVE `stuck`: the
\* solver was in fact paid, the second settleHold merely errored, and nothing
\* on the row can tell an operator which happened.
SettleGivesUp(w, s) ==
    /\ Saw(w, s, "claimed")
    /\ clock >= htlcE[s]
    /\ (~settled[s] \/ ~SettleIsIdempotent)
    /\ \/ CasWon(s, "claimed", "stuck")
       \/ CasLost(s, "claimed")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

(***** whenRefunding : src/receive/orchestrator.ts:499-540 *****************)

\* THE BACK-EDGE, AND THE REASON THIS CORRIDOR IS INTERESTING.
\* orchestrator.ts:509-515: the late-claim recheck runs FIRST, before
\* findLockups and before any refund is pushed, because a late-but-valid claim
\* can land right up until the refund races it and the refund could only ever
\* lose that race.  Losing is a RECOVERY: the solver now holds P and can still
\* settle the held HTLC.
RefundingSeesClaim(w, s) ==
    /\ Saw(w, s, "refunding")
    /\ ClaimReadable(s)
    /\ \/ CasWon(s, "refunding", "claimed")
       \/ CasLost(s, "refunding")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* arkade.refund() -> refundWithoutReceiverSwapScript: the solver's own
\* absolute-CLTV leaf (client=solver + Arkade server), pushed back to
\* solverRefundPkScript.  IRREVERSIBLE AND PRE-CAS (orchestrator.ts:538-539).
\* SpendAccepted is the Arkade server arbitrating: it will co-sign exactly one
\* spend of the vtxo, and it may already have accepted a claim — in which case
\* this action is simply disabled and the next tick's recheck recovers the swap.
\* AUDIT NOTE 2026-08-10: the `~ClaimReadable(s)` conjunct below is REDUNDANT —
\* ClaimReadable(s) implies SpentBy(s, "clientClaim") implies Spent(s), which
\* `~Spent(s)` already excludes.  It is kept because it mirrors the TypeScript's
\* ordering (orchestrator.ts:509-515 runs the recheck before the push), but the
\* model therefore does NOT demonstrate that ordering is necessary: SpendAccepted
\* alone makes a refund unable to win after a claim.  What IS load-bearing is the
\* RefundingSeesClaim action itself; delete that and NoNetLoss fails.
RefundAccepted(w, s) ==
    /\ Saw(w, s, "refunding")
    /\ ~ClaimReadable(s)
    /\ ~Spent(s)                            \* findLockups returned outputs
    /\ serverUp
    /\ clock >= RefundLocktime              \* the absolute CLTV has matured; see (A5)
    /\ SpendAccepted(s, "solverRefund")
    /\ Advance(w, "refundSent", "none")
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED LrVars

\* refund_ark_txid is written ONLY by this CAS — there is no pre-committed data
\* fact for the refund push, unlike `revealed_at` for the reveal.  A crash here
\* therefore makes an already-refunded swap indistinguishable from an
\* inexplicable one, and RefundingEmpty parks it in terminal `stuck`.  That is
\* a bookkeeping loss the code accepts; guessing the other way would be a money
\* loss.
RecordRefund(w, s) ==
    /\ At(w, s, "refundSent")
    /\ \/ CasWon(s, "refunding", "refunded")
       \/ CasLost(s, "refunding")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* orchestrator.ts:517-535.  The lockup is empty and no claim is readable.
\* Ordinary read lag and a genuine anomaly look IDENTICAL from here and only
\* TIME separates them, so the escalation is on a clock, not on a single
\* observation.  Escalating early throws a COMPLETED swap into a state with no
\* outgoing edge, hold invoice unsettled and lockup already spent.
RefundingEmpty(w, s) ==
    /\ Saw(w, s, "refunding")
    /\ ~ClaimReadable(s)
    /\ Spent(s)
    /\ GraceElapsed(s)                      \* <<< THE EMPTY_LOCKUP_GRACE MUTATION
    /\ \/ CasWon(s, "refunding", "stuck")
       \/ CasLost(s, "refunding")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

--------------------------------------------------------------------------
(***************************************************************************)
(* THE NEXT-STATE RELATION                                                 *)
(***************************************************************************)

(***************************************************************************)
(* FAIRNESS GROUPS.  See SwapCore's traps T1-T4.                           *)
(*                                                                         *)
(* The soundness obligation for grouping is NOT pairwise disjointness — it *)
(* is "no member can be taken infinitely often WITHOUT the swap advancing". *)
(*                                                                         *)
(* DriveRow: every member ends in a compare-and-swap and parks.  If it wins *)
(*   the row moved; if it loses the row had already moved.  A stale worker  *)
(*   cannot loop, because ReadRow only returns Drivable rows.              *)
(*                                                                         *)
(* ActStep (FundLockup / FundAdopt / SettleHold / SettleRetry /            *)
(*   RefundAccepted / FundedSoloRefund / RefundingSoloRefund) MUST stay      *)
(*   outside DriveRow and outside RecordStep.  Each performs an irreversible*)
(*   side effect and advances to a phase; a worker that then CRASHES        *)
(*   re-enables it, so a group containing both the act and its record       *)
(*   would be discharged forever by re-acting and the outcome would never   *)
(*   be written down.  Splitting them forces the write.  The acts may       *)
(*   share one group because for any one swap they are enabled in mutually  *)
(*   exclusive row states (armed / claimed / refunding / funded).           *)
(*                                                                         *)
(* RecordStep is what actually rescues a crash loop: it is re-enabled by    *)
(*   every ActStep, so SF forces it to be taken infinitely often.           *)
(***************************************************************************)
DriveRow(w, s) ==
    \/ InsertQuote(w, s)
    \/ SeeArmed(w, s)             \/ RefuseQuoted(w, s)
    \/ RefuseArmed(w, s)
    \/ FundedToRefunding(w, s)    \/ FundedSeesClaim(w, s)
    \/ FundedEmptyToRefunding(w, s)
    \/ SettleGivesUp(w, s)
    \/ RefundingSeesClaim(w, s)   \/ RefundingEmpty(w, s)

\* The irreversible side effects.  Each is separated from the row read by at
\* least one step, and from its own record by at least one step.
ActStep(w, s) ==
    \/ FundLockup(w, s) \/ FundAdopt(w, s)
    \/ SettleHold(w, s) \/ SettleRetry(w, s)
    \/ RefundAccepted(w, s)
    \/ FundedSoloRefund(w, s)
    \/ RefundingSoloRefund(w, s)

\* The compare-and-swaps that record an outcome the world already has.
RecordStep(w, s) ==
    \/ RecordFund(w, s) \/ RecordSettle(w, s) \/ RecordRefund(w, s)
    \/ FundedSoloRecord(w, s)

Progress(w, s) == DriveRow(w, s) \/ ActStep(w, s) \/ RecordStep(w, s)

Next ==
    \/ \E w \in Workers :
          \/ \E s \in Swaps : ReadSwap(w, s) \/ Progress(w, s)
          \/ GiveUp(w)
          \/ Crash(w)
    \/ \E s \in Swaps :
          \/ \E e \in EChoices : ArmHtlc(s, e)
          \/ ClientClaims(s)
          \/ ClientUnilateralClaim(s)
          \/ IndexerCatchUp(s)
    \/ Censor
    \/ Tick

Init ==
    /\ InitCore("none")
    /\ funds         = [s \in Swaps |-> 0]
    /\ htlcE         = [s \in Swaps |-> 0]
    /\ settled       = [s \in Swaps |-> FALSE]
    /\ claimReadable = [s \in Swaps |-> FALSE]
    /\ aged          = [s \in Swaps |-> FALSE]
    /\ fundedAt      = [s \in Swaps |-> 0]

(***************************************************************************)
(* FAIRNESS.  Strong fairness per (swap, action group): a worker that      *)
(* repeatedly reads a row and finds an applicable step must eventually     *)
(* take it.  Weak fairness would be satisfied by an endless read/give-up   *)
(* loop.  Crash, Censor, ArmHtlc and ClientClaims are deliberately UNFAIR — *)
(* the environment owes us nothing.  IndexerCatchUp IS fair, because it is *)
(* what discharges (A3); a permanently unreadable claim is not read lag,   *)
(* it is the anomaly EMPTY_LOCKUP_GRACE escalates to a human.              *)
(*                                                                         *)
(* Keep each `\A` body a SINGLE fairness formula (T1) and never put SF on  *)
(* the whole `Progress` disjunction (T2).  Thirteen conditions total, which *)
(* is inside TLC's comfortable ceiling (T3).                               *)
(***************************************************************************)
Fairness ==
    /\ \A w \in Workers : WF_vars(GiveUp(w))
    /\ \A s \in Swaps   : WF_vars(IndexerCatchUp(s))
    /\ WF_vars(Tick)
    \* "some worker eventually does this for this swap".  The \E is over
    \* WORKERS, never over swaps: swaps must each be driven, workers are
    \* interchangeable.
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ReadSwap(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : DriveRow(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ActStep(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : RecordStep(w, s))

Spec == Init /\ [][Next]_vars /\ Fairness

--------------------------------------------------------------------------
(***************************************************************************)
(* INVARIANTS                                                              *)
(***************************************************************************)

TypeOK ==
    /\ TypeOKCore(AllSt)
    /\ funds         \in [Swaps -> 0..2]
    /\ htlcE         \in [Swaps -> {0} \cup EChoices]
    /\ settled       \in [Swaps -> BOOLEAN]
    /\ claimReadable \in [Swaps -> BOOLEAN]
    /\ aged          \in [Swaps -> BOOLEAN]
    /\ fundedAt      \in [Swaps -> 0..(MaxClock+1)]

\* Every state change is an edge of LEGAL_EDGES.  An ACTION property.
ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars

\* The irreversible outbound side effect happens at most once per swap.
\* NOT guaranteed by the compare-and-swap: the CAS runs AFTER arkade.fund()
\* and decides only who RECORDS the outpoint, never who PAYS.
NoDoubleFund == \A s \in Swaps : funds[s] <= 1

\* The contested Arkade output is claimed or refunded, never both.  The
\* Arkade server co-signs exactly one spend of the vtxo.
AtMostOneOutcome == AtMostOneOutcomeInv

ExposureBounded == ExposureBoundedBy(NonTerminal)

\* THE money invariant: if the solver's own float has irreversibly left, it
\* has not been made whole, and the machine has stopped, then a human is being
\* paged.  The failure mode this excludes is `refused` — terminal, no outgoing
\* edge, and no refundSweep on this corridor — reached from `armed` with the
\* lockup already funded.
NoSilentLoss == NoSilentLossShape(PaidOut, Collected, Terminal, "stuck")

\* THE DISTINCTIVE INVARIANT OF THIS CORRIDOR, stated exactly as
\* SETTLE_SAFETY_MARGIN's own comment states it (src/core/receive.ts:33-41):
\* "the refund path must open before E, never after: once E passes the payment
\* is gone, and Arkade funds still sitting in an unrefundable script would be
\* lost outright."
\*
\* Never let E pass while the solver's own Arkade float sits in a script whose
\* refund path has not opened.
RecourseBeforeDeadline ==
    \A s \in Swaps :
        (PaidOut(s) /\ ~Collected(s) /\ HtlcExpired(s)) => clock >= RefundLocktime

\* THE loss itself: the counterparty took the Arkade lockup AND the held HTLC
\* died without ever being settled.  Both legs gone — the solver funded out of
\* its own float and collected nothing.
NoNetLoss == \A s \in Swaps : ~(ClientTookLockup(s) /\ HtlcLost(s))

\* Structural consequences of the edge table, asserted as theorems rather than
\* trusted, because a Go author will be tempted to change them.
\*
\* (i) `refused` must stay unreachable from every EXPOSED state — the same
\*     property the send corridor's refundSweep depends on.  NOTE THE HOLE
\*     THIS DOES NOT COVER: `armed` is not in EXPOSED, yet the solver's float
\*     CAN be out while a row reads `armed`, and armed -> refused IS an edge.
\*     That is why FundGateOneShot exists and why NoSilentLoss, not this
\*     theorem, is what catches the stranded float.
RefusedUnreachableFromExposed ==
    \A x \in Exposed : "refused" \notin Edges[x]

\* (ii) Every EXPOSED state must have an escalation to `stuck`, so that
\*      store.fail() from an exposed row always has somewhere legal to go.
\*      transition() THROWS on a non-edge, so a missing one would surface as an
\*      exception inside a tick rather than as a refusal.
StuckReachableFromEveryExposed ==
    \A x \in Exposed : "stuck" \in Edges[x]

Liveness == EventuallyTerminal(Terminal)

(***************************************************************************)
(* Swap ids and worker ids are interchangeable, so `Perms` would be sound  *)
(* for the safety invariants.  It is NOT declared in any cfg: SwapCore's   *)
(* trap T4 records that TLC's symmetry reduction is unsound in the         *)
(* presence of per-swap fairness conditions, verified on LightningSend.    *)
(* Do not "optimise" it back on.                                           *)
(***************************************************************************)
Perms == Permutations(Swaps) \cup Permutations(Workers)

(***************************************************************************)
(* MUTATION CHECKS — RESULTS                                               *)
(*                                                                         *)
(* A spec that passes because it is too weak to fail is worse than none.   *)
(* Seven behaviours were broken one at a time, each by a single constant,  *)
(* each with its own .cfg.  All seven produce a counterexample.            *)
(*                                                                         *)
(*   LightningReceive_Broken.cfg      BreakSettleMargin = TRUE             *)
(*                                    -> RecourseBeforeDeadline violated,  *)
(*                                       13,700 gen / 3,557 distinct       *)
(*   LightningReceive_BrokenLoss.cfg  same mutation, money invariant only  *)
(*                                    -> NoNetLoss violated,               *)
(*                                       22,816 gen / 5,752 distinct       *)
(*   LightningReceive_RecourseMargin.cfg                                   *)
(*                                    BreakRecourseMargin = TRUE           *)
(*                                    -> NoNetLoss violated,               *)
(*                                       277,839 gen / 58,370 distinct at  *)
(*                                       the violation.  The #69 shape:    *)
(*                                       fund an E=4 HTLC late in the      *)
(*                                       window, censor, and the trader's  *)
(*                                       timelock-free solo claim wins the *)
(*                                       race the solver only matures into *)
(*                                       at fundedAt + UnilateralDelay.    *)
(*   LightningReceive_DoubleFund.cfg  ArkadeHonoursFundKey = FALSE         *)
(*                                    -> NoDoubleFund violated,            *)
(*                                       3,396 gen / 917 distinct          *)
(*   LightningReceive_Stranded.cfg    FundGateOneShot = FALSE              *)
(*                                    -> NoSilentLoss violated,            *)
(*                                       22,114 gen / 5,445 distinct       *)
(*   LightningReceive_Grace.cfg       BreakEmptyGrace = TRUE               *)
(*                                    -> NoNetLoss violated,               *)
(*                                       228,850 gen / 46,865 distinct     *)
(*   LightningReceive_Overexposed.cfg AtomicAdmission = FALSE, MaxExposed 1*)
(*                                    -> ExposureBounded violated,         *)
(*                                       453 gen / 163 distinct            *)
(*                                                                         *)
(* plus two CONTROLs, which prove the fixes sufficient rather than merely  *)
(* plausible:                                                              *)
(*                                                                         *)
(*   LightningReceive_OverexposedControl.cfg                               *)
(*                                    AtomicAdmission = TRUE, MaxExposed 1 *)
(*                                    -> GREEN, 169,371 gen / 31,737       *)
(*                                       distinct.  Without it a green     *)
(*                                       Overexposed run could just mean   *)
(*                                       the cap never bound.              *)
(*   LightningReceive_RecourseControl.cfg                                  *)
(*                                    same constants as RecourseMargin,    *)
(*                                    gate (d) intact                      *)
(*                                    -> GREEN, 3,844,911 gen / 620,261    *)
(*                                       distinct, 7s.  Without it the     *)
(*                                       mutation's counterexample could   *)
(*                                       just mean the solo leaves were    *)
(*                                       never exercised.                  *)
(*                                                                         *)
(* plus two FINDING checks, which break no guard.  Each fixes a property   *)
(* of the OUTSIDE WORLD unfavourably and shows what the corridor does:     *)
(*                                                                         *)
(*   LightningReceive_Censored.cfg    ServerMayCensor = TRUE               *)
(*                                    -> GREEN, 2,729,200 gen / 430,350    *)
(*                                       distinct, 26m13s — safety AND     *)
(*                                       Liveness.  This EXPECTED RESULT   *)
(*                                       CHANGED when the solo exit was    *)
(*                                       modelled (gate (d) work, 2026-08):*)
(*                                       the covenant's solo leaves carry  *)
(*                                       NO server signature — that was    *)
(*                                       always their point — so the moment*)
(*                                       a funded row's solo refund matures*)
(*                                       (fundedAt + UnilateralDelay,      *)
(*                                       strictly before E whenever gate   *)
(*                                       (d) holds) the solver again has   *)
(*                                       work it could finish RIGHT NOW,   *)
(*                                       Urgent holds the clock for it,    *)
(*                                       and every swap reaches a terminal *)
(*                                       state.  The trader's solo claim   *)
(*                                       opens only at E, strictly later,  *)
(*                                       so the exit is FAIR.  What is     *)
(*                                       STILL true of the shipped         *)
(*                                       TypeScript: no src/ code spends   *)
(*                                       the solver's solo leaf yet        *)
(*                                       (TODO(unilateral-exit) in         *)
(*                                       src/arkade/covenant.ts), so a     *)
(*                                       censoring server still parks the  *)
(*                                       float in production — the F5      *)
(*                                       finding survives as a statement   *)
(*                                       about shipped code, not about the *)
(*                                       covenant.  This cfg is the        *)
(*                                       requirement evidence the Go       *)
(*                                       rewrite must keep passing;        *)
(*                                       RecourseMargin.cfg breaks the     *)
(*                                       gate that keeps the race fair.    *)
(*                                                                         *)
(*   LightningReceive_SettleNotIdempotent.cfg                              *)
(*                                    SettleIsIdempotent = FALSE           *)
(*                                    -> GREEN, 1,212,160 gen / 204,609    *)
(*                                       distinct, 9m24s, and it is the    *)
(*                                       only GREEN configuration in which *)
(*                                       SettleGivesUp and the             *)
(*                                       claimed -> stuck edge are         *)
(*                                       reachable at all.  RecourseMargin *)
(*                                       reaches the edge too, without     *)
(*                                       breaking idempotency: the trader's*)
(*                                       winning claim lands at/after E,   *)
(*                                       the settle path is already gone,  *)
(*                                       and SettleGivesUp parks the row.  *)
(*                                       A crash between                   *)
(*                                       ln.settleHold and the CAS leaves a*)
(*                                       COLLECTED swap in terminal `stuck`*)
(*                                       — a false negative no money       *)
(*                                       invariant can see, because the    *)
(*                                       money is fine and only the row    *)
(*                                       lies.  Fix: a pre-committed       *)
(*                                       settle_attempted_at, mirroring    *)
(*                                       revealed_at.                      *)
(*                                                                         *)
(* COVERAGE.  A `-coverage` run of the green cfg fires 24 of the 30        *)
(* actions (re-measured 2026-08-30 on the gate-(d) model).  The six that   *)
(* do not:                                                                 *)
(*                                                                         *)
(*   Censor, SettleGivesUp — disabled by constants their own cfgs above    *)
(*     turn on, and verified to fire there (SettleGivesUp 644:952 under    *)
(*     SettleIsIdempotent = FALSE; Censor drives the Censored run's        *)
(*     server-down scenarios).                                             *)
(*   ClientUnilateralClaim, FundedSoloRefund, RefundingSoloRefund,         *)
(*     FundedSoloRecord — the solo-exit actions, enabled only while the    *)
(*     Arkade server is down; they fire in the censor cfgs (Censored,      *)
(*     RecourseControl, RecourseMargin), where ClientUnilateralClaim wins  *)
(*     the race exactly when gate (d) is broken.                           *)
(*                                                                         *)
(* So there is no dead spec.  SettleGivesUp being unreachable in the green *)
(* model is a RESULT, not a gap: under (A2) and gates (b)+(c)+(d) together,*)
(* a swap that reaches `claimed` always settles inside E, and the only way *)
(* to reach the past-E escalation is a backend that errors on a repeated   *)
(* settle.                                                                 *)
(*                                                                         *)
(* THE MANDATED ONE, IN FULL.  LightningReceive_BrokenLoss.cfg removes only*)
(* gate (c) — SETTLE_SAFETY_MARGIN — from evaluateReceiveFunding.  TLC     *)
(* finds the loss in 14 states.  Constants: RefundLocktime 3,              *)
(* SettleSafetyMargin 1, MinSettleWindow 2, InvoiceExpiry 2,               *)
(* EChoices {2,4}, MaxClock 4.                                             *)
(*                                                                         *)
(*   1-6   both swaps quoted at clock 0 (two workers, interleaved reads    *)
(*         and inserts)                                                    *)
(*   7     ArmHtlc(s1, 2)     a payer's HTLC arms and THE BACKEND PICKS E. *)
(*                            It picks 2 — a short-dated HTLC, which       *)
(*                            src/core/receive.ts:126-131 warns is exactly *)
(*                            the case a hardcoded guess would miss.       *)
(*   8     SeeArmed(s1)       quoted -> armed; htlc_expires_at = 2 written *)
(*                            in the same UPDATE, and never refreshed.     *)
(*   9     ReadSwap(s1)       the row, plus whenArmed's `alreadyFunded`    *)
(*                            snapshot — "sawEmpty".                       *)
(*   10    FundLockup(s1)     <<< THE MUTATION.  With the real guard this  *)
(*                            edge is DISABLED: RefundLocktime 3 +         *)
(*                            SettleSafetyMargin 1 = 4 > E 2, so           *)
(*                            evaluateReceiveFunding returns               *)
(*                            refund_deadline_too_late and the row goes to  *)
(*                            `refused` having risked nothing.  Note gate  *)
(*                            (b) PASSES here — E 2 - now 0 = 2 >=         *)
(*                            MIN_SETTLE_WINDOW 2 — which is the whole     *)
(*                            reason gate (c) is a separate check.         *)
(*                            arkade.fund() moves the solver's own float.  *)
(*                            IRREVERSIBLE, and it happens BEFORE any CAS. *)
(*   11    RecordFund(s1)     armed -> funded.  funds[s1] = 1.             *)
(*   12-13 Tick, Tick         clock 0 -> 2.  Nothing is Urgent: the row is *)
(*                            `funded`, no claim is readable, and          *)
(*                            RefundLocktime 3 has not arrived.            *)
(*                            AT CLOCK 2 THE HELD HTLC IS GONE.  There is  *)
(*                            no cancelHold; the backend fails a stale hold *)
(*                            back on its own.  The inbound payment the    *)
(*                            solver was going to collect no longer exists.*)
(*                            The solver's own refund path does not open   *)
(*                            until clock 3.                               *)
(*   14    ClientClaims(s1)   the covenant's claim leaves carry NO         *)
(*                            TIMELOCK, so the client's option was live    *)
(*                            the whole time and is still live now.  The   *)
(*                            Arkade server co-signs it.  The lockup is    *)
(*                            gone.                                        *)
(*                                                                         *)
(*   Final state: funds[s1] = 1  /\  conf[s1] = {"clientClaim"}            *)
(*                settled[s1] = FALSE  /\  clock 2 >= htlcE[s1] 2          *)
(*                st[s1] = "funded"                                        *)
(*                                                                         *)
(*   NoNetLoss violated.  The solver paid amountSats out of its OWN float, *)
(*   the client took it, and the inbound HTLC died unsettled.  Both legs   *)
(*   gone, one full amount lost, and the row still reads `funded` — the    *)
(*   operator does not learn about it until a later tick routes it         *)
(*   somewhere terminal.                                                   *)
(*                                                                         *)
(* Note what the counterexample does NOT need: no crash, no lost           *)
(* compare-and-swap, no concurrency, no indexer lag, not even a hostile    *)
(* client — merely a client that does nothing until the free option it     *)
(* holds becomes free money.  SETTLE_SAFETY_MARGIN is not a concurrency    *)
(* guard.  It is the ordering constraint refund_locktime < E, and          *)
(* refund_locktime is fixed at QUOTE time while E is revealed by a         *)
(* stranger at ARM time, so nothing but this gate can enforce it.  That is *)
(* why breaking it is caught by a money invariant and not by ForwardOnly,  *)
(* NoDoubleFund or the compare-and-swap.                                   *)
(*                                                                         *)
(* LightningReceive_Broken.cfg runs the identical mutation against the full*)
(* invariant list and reports RecourseBeforeDeadline instead, one step      *)
(* earlier (state 13, before the client bothers to claim).  That is the    *)
(* hazard; NoNetLoss is the loss.                                          *)
(***************************************************************************)
=============================================================================
