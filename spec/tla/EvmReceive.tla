------------------------------ MODULE EvmReceive ----------------------------
(***************************************************************************)
(* EVM RECEIVE: `ethereum:<token> -> arkade:BTC`.  The client locks ERC20  *)
(* against the contract; the solver locks SATS into an Arkade covenant;    *)
(* the client claims the sats (revealing the preimage); the solver claims  *)
(* the ERC20 with it.  The mirror of EvmSend, with the risk running the    *)
(* other way: here the solver funds against a lock it does not control     *)
(* and did not create (evmReceivePlan.ts:4-7).                             *)
(*                                                                         *)
(* THE ARCHITECTURE UNDER TEST is the same planner/shell split as the send *)
(* corridor: planEvmReceive (src/core/evmReceivePlan.ts) is a pure         *)
(* function of (row, observation); EvmReceiveSwapService                   *)
(* (src/receive/evmOrchestrator.ts) owns the order in which the row and    *)
(* the world change.  There are no when* methods and no LEGAL_EDGES table  *)
(* in the store: the planner IS the edge authority, and the Edges table    *)
(* below is what a Go rewrite must reproduce.                              *)
(*                                                                         *)
(* THE FOUR RULES (evmReceivePlan.ts:9-25), and where each lives here:     *)
(*  1. Fund only against a lock proven deep AND old enough - the           *)
(*     evmConfirmed snapshot gate in FundArkade.                           *)
(*  2. Fund only with enough of the client's evm_timeout left to claim in  *)
(*     - TooClose (EVM_RECEIVE_CLAIM_MARGIN_BLOCKS, plan:139).             *)
(*  3. A revealed preimage means CLAIM THE ERC20 NOW - the pre-switch      *)
(*     rule, an interrupt from EVERY non-terminal state (plan:87-108).     *)
(*  4. Preimage in hand past the client's timeout: stick, loudly           *)
(*     (plan:92-94).                                                       *)
(*  5. A quote binds only until valid_until (plan:112-133).                *)
(*                                                                         *)
(* TWO CLOCKS, as in EvmSend: the wall clock (validUntil, refundLocktime)  *)
(* and the EVM block HEIGHT (evmTimeout, the CLIENT's choice - the quote   *)
(* validates it and derives refundLocktime from it, orchestrator:369-380). *)
(* The quote-time bridge reads the client's height deadline at the FASTEST *)
(* plausible cadence - the safe direction when it bounds somebody else's   *)
(* recourse - so the modelled margin is:                                   *)
(*                                                                         *)
(*     refundLocktime (wall) < evmTimeout (height) * FastCad               *)
(*                                                                         *)
(* i.e. the solver's Arkade refund opens strictly before the client's      *)
(* ERC20 refund could possibly open.  (R1), enforced by ASSUME unless the  *)
(* BreakDeadlineOrder mutation collapses it.                               *)
(*                                                                         *)
(* THE PRE-SWITCH RULE is a global interrupt, exactly as in EvmSend: rules *)
(* 3 and 4 run BEFORE the state switch, off `seen.preimage ?? row.preimage`   *)
(* (plan:87).  The preimage is read from the ARKADE side (the client       *)
(* reveals by claiming the lockup), and only once the lockup exists        *)
(* (orchestrator:187) - which is why conf = {clientClaim} is exactly the   *)
(* readable precondition.                                                  *)
(*                                                                         *)
(* THE PARKED STATES.  funding_arkade's only escape is the observed lockup *)
(* (plan:148-149), and claiming maps to wait as a state branch             *)
(* (plan:162-163):                                                         *)
(*   - claiming is NOT truly parked: the pre-switch rule re-fires from it  *)
(*     off the persisted preimage (plan:87), so the claim retries until it *)
(*     records or the timeout sticks it.                                   *)
(*   - refunding_arkade is parked only in the NARROW window the re-drive   *)
(*     cannot see: the spend LANDED and the recording CAS was lost.  While *)
(*     the covenant reads unspent the planner re-drives it (plan:156-160), *)
(*     which is what closed F4; once it is spent there is nothing left to  *)
(*     lose, only a row to finish.                                         *)
(*   - funding_arkade with a crash before fundArkade IS parked: the sats   *)
(*     never went out, the lockup never appears, the row waits forever.    *)
(* Liveness is stated so those two count as outcomes - finding F1.         *)
(*                                                                         *)
(* ASSUMPTIONS, each with a mutation cfg that breaks it:                   *)
(*                                                                         *)
(*  (R1) THE MARGIN, above.  With it, a client that reveals the preimage   *)
(*       late finds the solver's sats already refunded; without it the     *)
(*       client claims the sats at height >= evmTimeout, the row sticks    *)
(*       loudly, and the client ALSO takes its ERC20 back - NoNetLoss.     *)
(*  (B1) `FundCommitFirst`.  The row CASes into funding_arkade BEFORE the  *)
(*       sats go out (orchestrator:251-257), so two readers cannot both    *)
(*       fund and a crash cannot leave a funded lockup against a row that  *)
(*       still reads `locked`.  The mutation funds before the CAS and      *)
(*       NoDoubleFund fails.                                               *)
(*  (B2) `ClaimLandsPromptly`.  A broadcast claimCall mines before the     *)
(*       height can reach the client's timeout - the operational content   *)
(*       of RULE 2's 60-block margin, and of any live mempool.  Modelled   *)
(*       as the height clock refusing to advance while a claim is in       *)
(*       flight against a still-locked contract.  The mutation lets the    *)
(*       client's refund win the race and NoNetLoss fails.                 *)
(*  (B3) `ClaimRecordsReceipt`.  SHIPPED, not an open assumption           *)
(*       (evmReceivePlan.ts:99-105): `claimed` is written only for a claim *)
(*       whose own receipt says it MINED.  The row used to record it when  *)
(*       the broadcast RETURNED a txid - send-only, no receipt             *)
(*       (broadcast.ts:91-95) - so the terminal word could stand over a    *)
(*       claim that reverted, reporting the solver paid when the sats had  *)
(*       gone out for nothing.  The mutation records at send time and      *)
(*       NoSilentLoss fails.  Finding F2, fixed.                           *)
(*  (B4) `FundLandsPromptly`.  fundArkade is one awaited call in the       *)
(*       shell; RULE 2's 60-block margin is what makes "the fund landed    *)
(*       quickly" safe to assume.  The mutation lets the accept land at    *)
(*       or after the client's timeout height and NoNetLoss fails.         *)
(*       Finding F3.                                                       *)
(*                                                                         *)
(* HOW THIS WAS CHECKED: see THE GREEN RUN and MUTATION CHECKS at the      *)
(* bottom of the module.                                                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC, SwapCore

CONSTANTS
    EvmTimeoutH,       \* the CLIENT's ERC20 refund opens at this height
    ClaimMarginBlocks, \* RULE 2: fund only if height + this < EvmTimeoutH
    RefundLocktime,    \* wall: the solver's Arkade refund opens (derived)
    ValidUntil,        \* wall: the quote stops binding
    MaxHeight,         \* height bound for TLC
    FastCad,           \* fastest plausible cadence: wall ticks per block
    SlowCad,           \* slowest plausible cadence
    FundCommitFirst,   \* (B1) MUTATION: CAS funding_arkade before the
                       \*      broadcast (TRUE) - FALSE is the flipped order
    ClaimLandsPromptly, \* (B2) MUTATION: a broadcast claim mines before the
                       \*      height reaches the client timeout (TRUE)
    ClaimRecordsReceipt, \* (B3) MUTATION: record `claimed` only once mined
                       \*      (TRUE, shipped) - FALSE is the pre-fix
                       \*      send-time record (F2 in RESULTS)
    FundLandsPromptly,  \* (B4) MUTATION: the fundArkade accept lands before
                       \*      the height runs the client's timeout down
                       \*      (TRUE) - FALSE is a hung funding RPC
    RefundSpendAtomic,  \* (B5) CAS and covenant spend in ONE step (TRUE) or
                       \*      split, with a crash window between them
                       \*      (FALSE, shipped)
    RefundRedrivenWhileUnspent, \* (B5) MUTATION: the planner re-drives a
                       \*      refunding_arkade row whose covenant is still
                       \*      unspent (TRUE, shipped) or parks it forever
                       \*      (FALSE, the pre-fix planner; F4 in RESULTS)
    AtomicAdmission,   \* the reservation re-check at insertQuote
    BreakDeadlineOrder \* (R1) MUTATION: collapse the height/wall margin

\* The margin (R1): the solver's Arkade refund opens strictly before the
\* client's ERC20 refund could open even at the FASTEST cadence.
MarginHolds == RefundLocktime < EvmTimeoutH * FastCad

ASSUME EvmTimeoutH \in Nat /\ RefundLocktime \in Nat /\ ValidUntil \in Nat
ASSUME MaxHeight \in Nat /\ FastCad \in Nat /\ SlowCad \in Nat
ASSUME ClaimMarginBlocks \in Nat
ASSUME FastCad >= 1 /\ SlowCad >= FastCad
ASSUME BreakDeadlineOrder \in BOOLEAN
ASSUME ValidUntil <= RefundLocktime          \* the quote dies first
ASSUME RefundLocktime <= MaxClock
ASSUME EvmTimeoutH <= MaxHeight
ASSUME ClaimMarginBlocks >= 1                \* at least one block to claim in
ASSUME ClaimMarginBlocks < EvmTimeoutH       \* a fundable window exists
ASSUME BreakDeadlineOrder \/ MarginHolds

VARIABLES
    evmHeight,     \* the EVM chain's block height - the client's timeout clock
    arkFund,       \* [Swaps -> {"none","funded"}] the solver's lockup visible
    evm,           \* [Swaps -> {"none","locked","solverClaimed","clientRefunded"}]
    evmConfirmed,  \* [Swaps -> BOOLEAN] the depth+age probe passed
    claimSent,     \* [Swaps -> BOOLEAN] a claim broadcast is in the mempool
    fundSends      \* [Swaps -> 0..2] fund broadcasts issued; the (B1) counter

LrVars == << evmHeight, arkFund, evm, evmConfirmed, claimSent, fundSends >>
vars   == << clock, st, loc, conf, serverUp, evmHeight, arkFund, evm,
             evmConfirmed, claimSent, fundSends >>

(***************************************************************************)
(* STATES AND EDGES.  Authority: planEvmReceive + the shell CASes.         *)
(* `awaiting_lock` and `locked` are planner states production never writes *)
(* (no transition targets them); they are modelled because the planner     *)
(* handles them.                                                           *)
(***************************************************************************)
Row    == { "none", "quoted", "awaiting_lock", "locked", "funding_arkade",
            "awaiting_claim", "claiming", "claimed", "refunding_arkade",
            "refunded", "refused", "stuck" }
NonTerminal == { "quoted", "awaiting_lock", "locked", "funding_arkade",
                 "awaiting_claim", "claiming", "refunding_arkade" }
Exposed  == { "funding_arkade", "awaiting_claim", "claiming",
              "refunding_arkade" }
Terminal == { "claimed", "refunded", "refused", "stuck" }
Drivable == NonTerminal \cup { "none" }

\* Every -> claiming / -> stuck pair is the pre-switch rule, not a state
\* branch.  The dead rows carry the planner's own edges: `locked` funds
\* unconditionally (plan:145-146) and shares quoted's pre-switch edges.
Edges == [ x \in Row |->
    CASE x = "none"             -> { "quoted" }
      [] x = "quoted"           -> { "funding_arkade", "claiming", "refused",
                                     "stuck" }
      [] x = "awaiting_lock"    -> { "funding_arkade", "claiming", "refused",
                                     "stuck" }
      [] x = "locked"           -> { "funding_arkade", "claiming", "stuck" }
      [] x = "funding_arkade"   -> { "awaiting_claim", "claiming", "stuck" }
      [] x = "awaiting_claim"   -> { "claiming", "refunding_arkade", "stuck" }
      [] x = "claiming"         -> { "claimed", "stuck" }
      [] x = "refunding_arkade" -> { "claiming", "refunded", "stuck" }
      [] OTHER                  -> {} ]

AllSt == Row

(***************************************************************************)
(* MONEY.                                                                  *)
(*                                                                         *)
(* PaidOut: the solver's sats are committed in the covenant.  Collected:   *)
(* the solver is made whole, by tokens (its claim won the contract) or by  *)
(* its own sats back (its refund won the covenant).  NoNetLoss: the client *)
(* may not hold BOTH the sats and its own ERC20 back.                      *)
(***************************************************************************)
PaidOut(s)   == arkFund[s] = "funded"
Collected(s) == evm[s] = "solverClaimed" \/ conf[s] = { "solverRefund" }
NoNetLoss  == \A s \in Swaps : ~(conf[s] = { "clientClaim" }
                                 /\ evm[s] = "clientRefunded")
NoSilentLoss == NoSilentLossShape(PaidOut, Collected, Terminal, "stuck")
NoDoubleFund == \A s \in Swaps : fundSends[s] <= 1

TypeOK == /\ TypeOKCore(Row)
          /\ evmHeight \in 0..MaxHeight
          /\ arkFund \in [Swaps -> { "none", "funded" }]
          /\ evm \in [Swaps -> { "none", "locked", "solverClaimed",
                                 "clientRefunded" }]
          /\ evmConfirmed \in [Swaps -> BOOLEAN]
          /\ claimSent \in [Swaps -> BOOLEAN]
          /\ fundSends \in [Swaps -> 0..2]

(***************************************************************************)
(* THE CADENCE BAND, exactly as in EvmSend: height may advance only once   *)
(* at least FastCad wall ticks stand behind the next block; the wall clock *)
(* may not advance so far that the slowest cadence would already have      *)
(* produced another block.                                                 *)
(***************************************************************************)
HeightSane == clock >= evmHeight * FastCad
              /\ clock <= (evmHeight + 1) * SlowCad

(***************************************************************************)
(* GUARDS over the worker's snapshot.                                      *)
(***************************************************************************)
\* The client's ERC20 refund opens at this height (plan:71).
HeightUp == evmHeight >= EvmTimeoutH

\* RULE 2: not enough of the client's timeout left to claim in (plan:139).
TooClose == evmHeight + ClaimMarginBlocks >= EvmTimeoutH

\* The wall-clock deadlines.
QuoteStale  == clock >= ValidUntil
RefundOpen  == clock >= RefundLocktime

\* The preimage is readable: the client's Arkade claim revealed it (the
\* read is gated on the lockup existing, which the claim implies), or the
\* row already persisted it - `seen.preimage ?? row.preimage`, plan:64.
PReadable(s) == conf[s] = { "clientClaim" } \/ st[s] = "claiming"

(***************************************************************************)
(* URGENCY.  Same discipline as EvmSend: the margins buy the solver        *)
(* wall-clock time to ACT, not to wait, so a swap with an immediately-     *)
(* completable solver step outstanding holds the clock.  On THIS leg BOTH  *)
(* clocks are contested - the wall opens the solver's sats refund, the     *)
(* height opens the client's ERC20 refund - so SolverBehind gates both     *)
(* Tick and HeightTick.  The two flight gates below are the (B2)/(B4)      *)
(* promptness assumptions: the operational content of RULE 2's 60-block    *)
(* margin.                                                                 *)
(***************************************************************************)
Urgent(s) ==
    \/ st[s] = "none"                                          \* admission settles at once
    \/ (st[s] \in { "quoted", "awaiting_lock" }
        /\ evm[s] # "locked" /\ (QuoteStale \/ RefundOpen))    \* never locked: refuse now
    \/ (st[s] \in { "quoted", "awaiting_lock" }
        /\ evm[s] = "locked" /\ QuoteStale)                    \* locked late: refuse now
    \/ (st[s] \in { "quoted", "awaiting_lock" } /\ evm[s] = "locked"
        /\ evmConfirmed[s] /\ TooClose)                        \* RULE 2: refuse now
    \/ (st[s] \in { "quoted", "awaiting_lock" } /\ evm[s] = "locked"
        /\ evmConfirmed[s] /\ ~TooClose /\ ~QuoteStale)        \* fund now
    \/ st[s] = "locked"                                        \* planner funds unconditionally
    \/ (st[s] = "funding_arkade" /\ arkFund[s] = "funded")     \* advance now
    \/ (st[s] = "awaiting_claim" /\ RefundOpen
        /\ conf[s] = {})                                       \* refund now
    \* The refund SPEND in flight holds both clocks: the (R1) margin is the
    \* window [RefundLocktime, EvmTimeoutH*FastCad) in which the solver's
    \* refund must land, so the client may not run a clock past it.
    \* With the re-drive shipped the row is drivable whether or not a worker
    \* is still standing at sentRefund, so a crash there does not release the
    \* clock either.
    \/ (st[s] = "refunding_arkade" /\ conf[s] = {}
        /\ (RefundRedrivenWhileUnspent
            \/ \E w \in Workers : At(w, s, "sentRefund")))
    \* The pre-switch interrupt: P readable means claim or stick NOW.
    \* `claiming` stops being urgent once the claim is in flight (claimSent)
    \* or mined: the sweep has done its part, and whether the broadcast
    \* beats the client's timeout is the mempool's question - exactly the
    \* (B2) assumption, so it must NOT be discharged by urgency.  A claiming
    \* row with neither (a crash before the broadcast) is driven NOW.
    \/ (st[s] \in NonTerminal /\ PReadable(s)
        /\ (st[s] # "claiming"
            \/ (~claimSent[s] /\ evm[s] # "solverClaimed")))

SolverBehind == \E s \in Swaps : Urgent(s)

\* (B2): the height may not run past a claim in flight.  (B4): nor past a
\* FUND in flight - RULE 2's 60 blocks budget the fund landing AND the
\* claim landing, and a fund that lands only after the client's timeout
\* opened is the double loss (F3): the client refunds its ERC20 and claims
\* the freshly-landed sats in the same breath.  The mutations remove one
\* gate each.
HeightTick ==
    /\ evmHeight < MaxHeight
    /\ clock >= (evmHeight + 1) * FastCad
    /\ ~SolverBehind
    /\ (ClaimLandsPromptly
        => ~(\E s \in Swaps : claimSent[s] /\ evm[s] = "locked"))
    /\ (FundLandsPromptly
        => ~(\E w \in Workers : loc[w].phase = "sentFund"))
    /\ evmHeight' = evmHeight + 1
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, claimSent, fundSends >>

Tick ==
    /\ TickCore
    /\ ~SolverBehind
    /\ clock + 1 <= (evmHeight + 1) * SlowCad
    /\ UNCHANGED LrVars

Censor(w) == CensorCore /\ UNCHANGED LrVars

(***************************************************************************)
(* ENVIRONMENT.  The client, the contract, the miner.                      *)
(***************************************************************************)
\* The client locks its ERC20 against the contract - the client's own call,
\* keyed from the row (orchestrator:50, 172).  Possible while a live quote
\* awaits it; a lock that lands past the quote's deadline is the refused
\* case, and past its own timeout the client does not bother.
ClientLocksEvm(s) ==
    /\ st[s] \in { "quoted", "awaiting_lock" }
    /\ evm[s] = "none"
    /\ ~HeightUp
    /\ evm' = [evm EXCEPT ![s] = "locked"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evmConfirmed, claimSent, fundSends >>

\* The depth+age probe passes (RULE 1): provenDepth measured, never fed
\* back from config (orchestrator:186-194) - one environment step.
ConfirmEvmLock(s) ==
    /\ evm[s] = "locked"
    /\ ~evmConfirmed[s]
    /\ evmConfirmed' = [evmConfirmed EXCEPT ![s] = TRUE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, claimSent, fundSends >>

\* The client takes its ERC20 back, once its own timeout height opens.
\* The contract deletes the lock; a solver claim after this reverts.
ClientRefundsEvm(s) ==
    /\ evm[s] = "locked"
    /\ HeightUp
    /\ evm' = [evm EXCEPT ![s] = "clientRefunded"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evmConfirmed, claimSent, fundSends >>

\* The client claims the Arkade lockup - the collaborative spend, server
\* co-signed, and THE PREIMAGE REVEAL.  The contested output: SwapCore's
\* conf, at most one winner.
ClientClaimsArkade(s) ==
    /\ arkFund[s] = "funded"
    /\ serverUp
    /\ SpendAccepted(s, "clientClaim")
    /\ UNCHANGED << clock, st, loc, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, claimSent, fundSends >>

\* The miner lands the broadcast claim: the solver takes the ERC20.  An
\* environment step, as in EvmSend - the mempool owes no worker anything.
\* If the client's refund got there first the claim reverts and nothing
\* changes (ClientRefundsEvm already ran).
ClaimMines(s) ==
    /\ claimSent[s]
    /\ evm[s] = "locked"
    /\ evm' = [evm EXCEPT ![s] = "solverClaimed"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evmConfirmed, claimSent, fundSends >>

(***************************************************************************)
(* WORKER ACTIONS.  The observation snapshot is one ReadSwap; the planner  *)
(* is pure; every effect below names the planner branch it executes.       *)
(***************************************************************************)
\* store.get(id) plus the one Promise.all snapshot (lockPresent / funded /
\* height) and the Arkade-side preimage read - all sampled in one breath,
\* orchestrator:171-211.  res compresses what the planner needs.
ReadSwap(w, s) ==
    /\ ReadRowWith(w, s, Drivable,
           CASE st[s] = "none" ->
                    IF Exposure(NonTerminal) + Amount <= MaxExposed
                      THEN "capOk" ELSE "capFull"
             [] st[s] \in { "quoted", "awaiting_lock" } ->
                    IF evm[s] = "locked" THEN "locked" ELSE "empty"
             [] st[s] = "funding_arkade" ->
                    IF arkFund[s] = "funded" THEN "funded" ELSE "clear"
             [] OTHER ->
                    IF PReadable(s) THEN "revealed" ELSE "clear")
    /\ UNCHANGED LrVars

GiveUp(w) ==
    /\ loc[w].phase = "read"
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED LrVars

\* Crash can strike in any phase.  Crashes in sentFund and sentRefund are
\* what strand the two parked states (see THE PARKED STATES).
Crash(w) == CrashCore(w) /\ UNCHANGED LrVars

\* quote(): the INSERT, cap-checked at read; AtomicAdmission = FALSE drops
\* the re-check here, which is the admission race the reservation lease
\* closes in the shipped code (orchestrator:410-461).
InsertQuote(w, s) ==
    /\ Saw(w, s, "none")
    /\ loc[w].res \in { "capOk", "capFull" }
    /\ \/ /\ st[s] = "none"
          /\ IF /\ loc[w].res = "capOk"
                /\ ( ~AtomicAdmission
                     \/ Exposure(NonTerminal) + Amount <= MaxExposed )
             THEN CasWon(s, "none", "quoted")
             ELSE CasWon(s, "none", "refused")
       \/ CasLost(s, "none")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* quoted / awaiting_lock, refused three ways (plan:82-110): never locked
\* by the quote deadline (RULE 5, the refund-locktime refusal is the
\* backstop), locked past the deadline (RULE 5 again), or locked deep but
\* with the claim window too close to fund against (RULE 2).  Pre-exposure;
\* the client's stranded lock is its own problem (its refund, at its own
\* timeout, is outside this model's money).
RefuseQuoted(w, s) ==
    /\ Saw(w, s, loc[w].seen)
    /\ loc[w].seen \in { "quoted", "awaiting_lock" }
    /\ \/ /\ loc[w].res = "empty"
          /\ QuoteStale \/ RefundOpen
       \/ /\ loc[w].res = "locked"
          /\ QuoteStale
       \/ /\ loc[w].res = "locked"
          /\ evmConfirmed[s]
          /\ TooClose
    /\ \/ CasWon(s, loc[w].seen, "refused")
       \/ CasLost(s, loc[w].seen)
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* fund_arkade: the CAS FIRST (B1) - "exposed BEFORE the sats go out"
\* (orchestrator:251-255) - then the broadcast is a separate step so a
\* crash can land between them: the parked funding_arkade with no sats
\* out, F1.  From `locked` the planner funds unconditionally (plan:145-146).
FundArkade(w, s) ==
    /\ \/ /\ Saw(w, s, loc[w].seen)
          /\ loc[w].seen \in { "quoted", "awaiting_lock" }
          /\ loc[w].res = "locked"
          /\ evmConfirmed[s]
          /\ ~TooClose
          /\ ~QuoteStale
       \/ Saw(w, s, "locked")
    /\ IF FundCommitFirst
       THEN UNCHANGED fundSends
       ELSE \* the mutation: fund first, record after - two readers both send
            fundSends' = [fundSends EXCEPT ![s] = fundSends[s] + 1]
    /\ \/ /\ CasWon(s, loc[w].seen, "funding_arkade")
          /\ Advance(w, "sentFund", "none")
       \/ /\ CasLost(s, loc[w].seen)
          /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << evmHeight, arkFund, evm, evmConfirmed, claimSent >>

\* The fund broadcast lands: the solver's sats sit in the covenant.  THE
\* irreversible act of this corridor.  Arkade acceptance is final (the
\* server co-signs; there is no mempool), so the landing is one step.
ArkFundLands(w, s) ==
    /\ At(w, s, "sentFund")
    /\ arkFund[s] = "none"
    /\ arkFund' = [arkFund EXCEPT ![s] = "funded"]
    /\ IF FundCommitFirst
       THEN fundSends' = [fundSends EXCEPT ![s] = fundSends[s] + 1]
       ELSE UNCHANGED fundSends
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp, evmHeight >>
    /\ UNCHANGED << evm, evmConfirmed, claimSent >>

\* funding_arkade, lockup observed -> awaiting_claim (plan:148-149).
AwaitClaim(w, s) ==
    /\ Saw(w, s, "funding_arkade")
    /\ loc[w].res = "funded"
    /\ \/ CasWon(s, "funding_arkade", "awaiting_claim")
       \/ CasLost(s, "funding_arkade")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* THE PRE-SWITCH RULE, early arm (RULE 3): P seen before the client's
\* timeout height.  CAS into claiming - persisting P with the state
\* (orchestrator:248-250) - then the claim broadcast is a separate step,
\* then the recording CAS.  Enabled from ANY non-terminal state, claiming
\* included: the retry IS the pre-switch rule re-firing off the persisted
\* preimage (plan:87), and the shell skips the state CAS for it.
ClaimEvm(w, s) ==
    /\ Saw(w, s, loc[w].seen)
    /\ loc[w].seen \in NonTerminal
    /\ loc[w].res = "revealed"
    /\ ~HeightUp
    /\ \/ /\ loc[w].seen = "claiming"
          /\ UNCHANGED st
          /\ Advance(w, "sentClaim", "none")
       \/ /\ loc[w].seen # "claiming"
          /\ \/ /\ CasWon(s, loc[w].seen, "claiming")
                /\ Advance(w, "sentClaim", "none")
             \/ /\ CasLost(s, loc[w].seen)
                /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

\* claimCall: the ERC20 claim is broadcast (orchestrator:265-277).  The
\* broadcast rides the phase; the landing is ClaimMines, an environment
\* step - a crashed worker cannot un-broadcast it.
ClaimBroadcast(w, s) ==
    /\ At(w, s, "sentClaim")
    /\ ~claimSent[s]
    /\ claimSent' = [claimSent EXCEPT ![s] = TRUE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, fundSends >>

\* The recording CAS, and (B3) its receipt.  SHIPPED (plan:99-105): the row
\* records `claimed` only once the claim is MINED, and the broadcast itself
\* only patches evm_claim_txid (orchestrator:277).  It USED TO write the
\* terminal word when the broadcast RETURNED a txid - send-only, no receipt
\* (broadcast.ts:91-95) - so the word could stand over a claim that never
\* landed while the solver's sats were already out.  The mutation restores
\* the send-time record and NoSilentLoss names the lie.
RecordClaimed(w, s) ==
    /\ At(w, s, "sentClaim")
    /\ claimSent[s]
    /\ IF ClaimRecordsReceipt
       THEN evm[s] = "solverClaimed"
       ELSE TRUE
    /\ \/ CasWon(s, "claiming", "claimed")
       \/ CasLost(s, "claiming")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, claimSent, fundSends >>

\* refund_arkade: no preimage and the Arkade window has closed
\* (plan:137-138).  The CAS, then the spend, then the recording CAS - three
\* steps in the shipped shell, and RefundSpendAtomic = FALSE is that shipped
\* split.  What used to make the split cost money was that nothing re-drove
\* refunding_arkade, so a crash between the CAS and the spend stranded the
\* row with the covenant unspent (F4).  RedriveArkRefund below is the fix;
\* this action is only the first attempt.
RefundArkade(w, s) ==
    /\ Saw(w, s, "awaiting_claim")
    /\ loc[w].res = "clear"
    /\ RefundOpen
    /\ \/ /\ CasWon(s, "awaiting_claim", "refunding_arkade")
          /\ IF RefundSpendAtomic
             THEN IF /\ serverUp
                     /\ conf[s] = {}
                     \* landed: the worker stays to record the verdict
                     THEN /\ SpendAccepted(s, "solverRefund")
                          /\ Advance(w, "sentRefund", "none")
                     \* the throw: the row is parked, the worker moves on
                     ELSE /\ UNCHANGED conf
                          /\ Park(w)
             ELSE /\ UNCHANGED conf
                  /\ Advance(w, "sentRefund", "none")
       \/ /\ CasLost(s, "awaiting_claim")
          /\ Park(w)
          /\ UNCHANGED conf
    /\ UNCHANGED << clock, serverUp >>
    /\ UNCHANGED LrVars

\* refundArkade as the separate step (B5 = FALSE): the solver's own
\* collaborative spend of the covenant.  Needs the server and an unspent
\* output; if the client's claim landed first the call throws and the row
\* parks in refunding_arkade.  Arkade acceptance is final, so the spend IS
\* the refund.
SubmitArkRefund(w, s) ==
    /\ At(w, s, "sentRefund")
    /\ ~RefundSpendAtomic
    /\ IF /\ serverUp
          /\ conf[s] = {}
       THEN /\ SpendAccepted(s, "solverRefund")
            /\ UNCHANGED loc
       ELSE /\ Park(w)
            /\ UNCHANGED conf
    /\ UNCHANGED << clock, st, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, claimSent, fundSends >>

\* (B5) THE RE-DRIVE, and what closes F4.  planEvmReceive returns
\* refund_arkade from refunding_arkade whenever the lockup is still funded
\* (evmReceivePlan.ts:139-147), so the window the split opens is closed by
\* the NEXT SWEEP rather than by folding the spend into the CAS: the shell
\* skips the CAS it is already past and re-attempts the spend.  `conf = {}`
\* is the unspent covenant the shipped planner sees as `arkadeLockupFunded`,
\* and `res = "clear"` keeps the pre-switch rule's precedence - a preimage
\* sends the row to the claim instead, exactly as from every other state.
RedriveArkRefund(w, s) ==
    /\ RefundRedrivenWhileUnspent
    /\ Saw(w, s, "refunding_arkade")
    /\ loc[w].res = "clear"
    /\ conf[s] = {}
    /\ IF serverUp
       THEN /\ SpendAccepted(s, "solverRefund")
            /\ Advance(w, "sentRefund", "none")
       ELSE /\ UNCHANGED conf
            /\ Park(w)
    /\ UNCHANGED << clock, st, serverUp >>
    /\ UNCHANGED LrVars

\* The recording CAS.  A crash before it leaves refunding_arkade parked
\* with the outcome already final on the covenant.
RecordRefunded(w, s) ==
    /\ At(w, s, "sentRefund")
    /\ conf[s] = { "solverRefund" }
    /\ \/ CasWon(s, "refunding_arkade", "refunded")
       \/ CasLost(s, "refunding_arkade")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, claimSent, fundSends >>

\* THE PRE-SWITCH RULE, late arm (RULE 4): P seen at or after the client's
\* timeout height - the ERC20 may already be client-refunded, so the row
\* is failed loudly.  A claim that ALREADY MINED is excluded (plan:99):
\* height cannot un-mine it, and the contract deletes the lock on claim, so
\* the client's refund cannot have landed too.  Sticking there would file an
\* incident over tokens the solver holds.  Reachable only because waiting for
\* the receipt (B3) keeps the row in `claiming` long enough for the height to
\* catch up - so the F2 fix is what made this arm need the exclusion.
StickLate(w, s) ==
    /\ Saw(w, s, loc[w].seen)
    /\ loc[w].seen \in NonTerminal
    /\ loc[w].res = "revealed"
    /\ HeightUp
    /\ evm[s] # "solverClaimed"
    /\ \/ CasWon(s, loc[w].seen, "stuck")
       \/ CasLost(s, loc[w].seen)
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LrVars

(***************************************************************************)
(* THE NEXT-STATE RELATION                                                 *)
(***************************************************************************)
DriveRow(w, s) ==
       InsertQuote(w, s)   \/ RefuseQuoted(w, s)
    \/ FundArkade(w, s)    \/ AwaitClaim(w, s)
    \/ ClaimEvm(w, s)      \/ StickLate(w, s)
    \/ RefundArkade(w, s)  \/ RedriveArkRefund(w, s)

PushChain(w, s) ==
       ArkFundLands(w, s)
    \/ ClaimBroadcast(w, s) \/ RecordClaimed(w, s)
    \/ SubmitArkRefund(w, s) \/ RecordRefunded(w, s)

Env(s) ==
       ClientLocksEvm(s) \/ ConfirmEvmLock(s) \/ ClientRefundsEvm(s)
    \/ ClientClaimsArkade(s) \/ ClaimMines(s)

Next ==
    \/ Tick
    \/ HeightTick
    \/ \E w \in Workers : Censor(w) \/ Crash(w) \/ GiveUp(w)
    \/ \E w \in Workers, s \in Swaps :
           ReadSwap(w, s) \/ DriveRow(w, s) \/ PushChain(w, s) \/ Env(s)

Init ==
    /\ InitCore("none")
    /\ evmHeight = 0
    /\ arkFund = [ s \in Swaps |-> "none" ]
    /\ evm = [ s \in Swaps |-> "none" ]
    /\ evmConfirmed = [ s \in Swaps |-> FALSE ]
    /\ claimSent = [ s \in Swaps |-> FALSE ]
    /\ fundSends = [ s \in Swaps |-> 0 ]

\* T1/T3 shape: quantify over swaps, \E over workers.  Tick and HeightTick
\* are STRONGLY fair: crash-retry loops around the pre-switch claim make
\* SolverBehind flicker on both clocks, and WF cannot discharge an
\* obligation whose enabledness is intermittent.  The mempool does not sit
\* on a broadcast claim forever: while it is minable it eventually mines
\* (or the client's refund lands first, which disables it - no obligation
\* either way).
Fairness ==
    /\ \A w \in Workers : WF_vars(GiveUp(w))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ReadSwap(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : DriveRow(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : PushChain(w, s))
    /\ SF_vars(Tick)
    /\ SF_vars(HeightTick)
    /\ \A s \in Swaps : WF_vars(ClaimMines(s))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* INVARIANTS AND PROPERTIES.                                              *)
(***************************************************************************)
AtMostOneOutcome == AtMostOneOutcomeInv
ExposureBounded  == ExposureBoundedBy(NonTerminal)

\* Edge-table assertions.  The EVM stores have no LEGAL_EDGES table - these
\* pin the PLANNER's action set instead (evmReceivePlan.ts), which is the
\* authority a Go rewrite must reproduce.
RefusedUnreachableFromExposed ==
    \A x \in Exposed : "refused" \notin Edges[x]
StuckReachableFromEveryExposed ==
    \A x \in Exposed : "stuck" \in Edges[x]

ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars

\* THE PARKED STATES, as the liveness statement: while the server
\* co-signs, every swap reaches a terminal state OR parks in one of the
\* two states a crash can strand - funding_arkade before the sats went
\* out, refunding_arkade after the refund CAS.  The money invariants above
\* bound what parking may cost; F1 in RESULTS names it.  `claiming` is not
\* accepted parking: the pre-switch rule re-drives it off the persisted
\* preimage.
Liveness == ([]serverUp) =>
    \A s \in Swaps : <>(st[s] \in Terminal \cup { "funding_arkade",
                                                  "refunding_arkade" })

\* The artifact property for EvmReceive_Parked.cfg: strict terminality, no
\* accepted parking.  EXPECTED violated there - a crash in the fund or
\* refund push leaves the row parked forever - funding_arkade always, and
\* refunding_arkade in the one window past the re-drive (the spend landed,
\* the recording CAS was lost), F1 - and only the money invariants bound
\* what the parking costs.
LivenessStrict == ([]serverUp) => EventuallyTerminal(Terminal)

Perms == Permutations(Swaps) \cup Permutations(Workers)

\* SwapCore constant overrides, supplied by the cfgs.
ERPhases  == { "idle", "read", "sentFund", "sentClaim", "sentRefund" }
ERResults == { "none", "capOk", "capFull", "empty", "locked", "funded",
               "revealed", "clear" }
ERSpendKinds == { "clientClaim", "solverRefund" }

-----------------------------------------------------------------------------
(***************************************************************************)
(* THE GREEN RUN                                                           *)
(*                                                                         *)
(* EvmReceive.cfg: all assumptions at their safe settings.  GREEN:         *)
(* 2,930,907 states generated, 402,480 distinct, depth 46, 1min 40s        *)
(* (-workers 4).  All nine invariants, ForwardOnly, and Liveness.          *)
(* Re-run for F2, F4 and the mined-claim exclusion.  It was                *)
(* 3,115,999/427,805 before that work: the re-drive removes the stranded   *)
(* refunding_arkade states, and StickLate no longer reaches the ones where *)
(* a mined claim was about to be filed as an incident.                     *)
(*                                                                         *)
(* FINDINGS                                                                *)
(*                                                                         *)
(* F1  THE PARKED STATES.  The planner maps funding_arkade to "observed    *)
(*     lockup or wait" (evmReceivePlan.ts:131-132), so a crash before      *)
(*     fundArkade parks the row forever - NON_TERMINAL and holding cap.    *)
(*     refunding_arkade is no longer in that company except in the one     *)
(*     window the re-drive cannot see (spend landed, recording CAS lost),  *)
(*     which costs a row rather than money.  Liveness accepts both         *)
(*     (EvmReceive_Parked.cfg shows the strict statement is false); the    *)
(*     money invariants bound the cost.  `claiming` is NOT parked: the     *)
(*     pre-switch rule re-drives it off the persisted preimage.            *)
(* F2  (B3) THE SEND-TIME RECORD - FIXED.  `claimed` USED TO be written    *)
(*     when the claim broadcast returned a txid - send-only, no receipt    *)
(*     (broadcast.ts:91-95) - so the terminal word could stand over a      *)
(*     claim that reverted while the solver's sats were already out.  The  *)
(*     planner now reads the receipt (evmReceivePlan.ts:99-105) and sticks *)
(*     on a revert, so EvmReceive_NoReceipt.cfg is a genuine mutation - it *)
(*     deletes the shipped check - rather than a record of shipped         *)
(*     behaviour.                                                          *)
(* F3  (B4) THE LATE FUND.  RULE 2's 60-block margin budgets BOTH the      *)
(*     fund landing and the claim landing; a fundArkade accept that lands  *)
(*     only at the client's timeout height lets the client refund its      *)
(*     ERC20 and claim the freshly-landed sats in one breath.              *)
(*     EvmReceive_LateFund.cfg: NoNetLoss, depth 21.                       *)
(* F4  (B5) THE STRANDED REFUND - FIXED.  refunding_arkade USED TO be      *)
(*     parked, so a crash between the refund CAS and the refundArkade      *)
(*     spend left the covenant unspent AND the row unwatched; the patient  *)
(*     client waited for its own timeout, claimed the sats, and took its   *)
(*     ERC20 back - the row stuck loudly (RULE 4) and the money was still  *)
(*     gone.  The planner now re-drives the refund while the lockup reads  *)
(*     funded (evmReceivePlan.ts:139-147), so                              *)
(*     EvmReceive_RefundStrand.cfg is a genuine mutation - it parks the    *)
(*     state again - and EvmReceive_LostSpend.cfg is its control: the same *)
(*     split CAS-then-spend, the shipped re-drive, green.                  *)
(*                                                                         *)
(* MUTATION CHECKS - RESULTS                                               *)
(*                                                                         *)
(*   EvmReceive_DoubleFund.cfg    FundCommitFirst = FALSE                  *)
(*                                NoDoubleFund violated, depth 10          *)
(*                                (3,369/775)                              *)
(*   EvmReceive_NoReceipt.cfg     ClaimRecordsReceipt = FALSE (mutation of *)
(*                                a SHIPPED guard since the F2 fix)        *)
(*                                NoSilentLoss violated, depth 16          *)
(*                                (78,840/12,934)                          *)
(*   EvmReceive_ClaimRace.cfg     ClaimLandsPromptly = FALSE               *)
(*                                NoNetLoss violated, depth 26.  STILL     *)
(*                                OPEN - the mined-claim exclusion in      *)
(*                                StickLate narrows this arm (a claim that *)
(*                                LANDED no longer sticks) but does not    *)
(*                                close the race it names, where the claim *)
(*                                has not landed yet.                      *)
(*   EvmReceive_LateFund.cfg      FundLandsPromptly = FALSE                *)
(*                                NoNetLoss violated, depth 21             *)
(*                                (269,565/43,305).  STILL OPEN.           *)
(*   EvmReceive_RefundStrand.cfg  RefundRedrivenWhileUnspent = FALSE over  *)
(*                                RefundSpendAtomic = FALSE (mutation of a *)
(*                                SHIPPED guard since the F4 fix)          *)
(*                                NoNetLoss violated, depth 26             *)
(*                                (779,685/119,913)                        *)
(*   EvmReceive_LostSpend.cfg     RefundRedrivenWhileUnspent = TRUE over   *)
(*                                RefundSpendAtomic = FALSE - the F4       *)
(*                                CONTROL.  GREEN: 3,615,831/491,756,      *)
(*                                depth 47, Liveness included.  The re-    *)
(*                                drive really does close the split's      *)
(*                                crash window, and this is the artifact.  *)
(*   EvmReceive_Overexposed.cfg   AtomicAdmission = FALSE, MaxExposed = 1  *)
(*                                ExposureBounded violated, depth 7        *)
(*                                (651/209); the green cfg is the control  *)
(*   EvmReceive_BrokenMargin.cfg  BreakDeadlineOrder = TRUE,               *)
(*                                RefundLocktime = 4: NoNetLoss violated,  *)
(*                                depth 22 (371,938/59,828)                *)
(*   EvmReceive_Parked.cfg        LivenessStrict artifact: violated,       *)
(*                                2,930,907/402,480, 4min 12s - F1 named   *)
(*                                                                         *)
(* KNOWN-VACUOUS IN THE GREEN CFG (coverage run, -coverage 1):             *)
(*                                                                         *)
(*   SubmitArkRefund  fires 0:0 - by construction: it is gated on          *)
(*     ~RefundSpendAtomic and the green cfg sets the fold.  The mutation   *)
(*     EvmReceive_RefundStrand.cfg exercises it.                           *)
(*   GiveUp           fires 0:N - enabled often, but every GiveUp          *)
(*     successor is state-identical to a Crash successor (both Park with   *)
(*     everything else unchanged), so TLC counts no new-state firings.     *)
(*     Its role is the FAIRNESS obligation, exactly as in EvmSend.         *)
(*   awaiting_lock / locked rows: never entered - production never writes  *)
(*     them (no transition targets them); they exist in Row and Edges      *)
(*     because the planner handles them, and ForwardOnly pins those        *)
(*     branches for the rewrite.                                           *)
(*                                                                         *)
(* Every other action fires in the green cfg.                              *)
(***************************************************************************)
=============================================================================
