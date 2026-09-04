------------------------------- MODULE EvmSend -------------------------------
(***************************************************************************)
(* EVM SEND CORRIDOR   arkade:BTC -> ethereum:<token>                      *)
(*                                                                         *)
(* The client locks sats at an Arkade covenant; the solver locks ERC20 in  *)
(* the swap contract.  The client claims the ERC20 with the preimage,      *)
(* revealing it; the solver claims the sats with it.  If the client never  *)
(* claims, the solver refunds its ERC20 at the block-height timeout and    *)
(* the client refunds its sats after the (wall-clock) refund locktime.     *)
(*                                                                         *)
(* WHICH TYPESCRIPT THIS SPECIFIES                                         *)
(*                                                                         *)
(*   src/core/evmSendPlan.ts      the pure planner: (row, observation) ->  *)
(*                                action.  THE EDGE AUTHORITY - the EVM    *)
(*                                stores have no LEGAL_EDGES table (see    *)
(*                                below).                                  *)
(*   src/send/evmOrchestrator.ts  the I/O shell: CAS discipline, the       *)
(*                                lock/claim/refund broadcasts, quote()    *)
(*   src/db/evmSendSwaps.ts       from-state CAS, partial UNIQUE index     *)
(*   src/evm/broadcast.ts         send-only broadcast: a hash comes back,  *)
(*                                NO receipt/revert check (:91-95).  The   *)
(*                                receipt is a SEPARATE read               *)
(*                                (transactionOutcome, backend.ts:181-193) *)
(*                                and only the planner acts on it.         *)
(*   src/evm/blockTime.ts         seconds <-> blocks conversion            *)
(*   src/evm/lockDepth.ts         the historical isLockedAt probe          *)
(*                                                                         *)
(* THE PLANNER/PLAN SPLIT, AND WHAT IT CHANGES HERE                        *)
(*                                                                         *)
(* Unlike the four BTC corridors there are no `when*` methods and no db    *)
(* LEGAL_EDGES table: every edge below is (a planner branch, the shell     *)
(* effect that branch triggers).  The edge table in this module is the     *)
(* planner's action set, stated explicitly so a Go rewrite has something   *)
(* to be diffed against - and because the edge-table assertions            *)
(* (RefusedUnreachableFromExposed, StuckReachableFromEveryExposed) have    *)
(* no shipped table to pin, they pin the PLANNER here.                     *)
(*                                                                         *)
(* THE PRE-SWITCH RULE IS A GLOBAL INTERRUPT                               *)
(*                                                                         *)
(* planEvmSend checks the preimage BEFORE the state switch                 *)
(* (evmSendPlan.ts:98-110), from EVERY non-terminal state:                 *)
(*   P seen, wall clock < refundLocktime  -> claim_arkade                  *)
(*   P seen, wall clock >= refundLocktime -> stick                         *)
(* That is why the edge table has -> claiming and -> stuck from every      *)
(* non-terminal state, and why the worker actions below model the rule     *)
(* as one action per outcome, enabled from any drivable state.             *)
(*                                                                         *)
(* TWO CLOCKS, ONE BRIDGE                                                  *)
(*                                                                         *)
(* The Arkade deadlines (validUntil, refundLocktime) compare against WALL  *)
(* seconds; the ERC20 refund timeout compares against BLOCK HEIGHT.  The   *)
(* only bridge is the quote-time conversion (evmOrchestrator.ts:397-406):  *)
(* evmTimeout is stored as a height via blocksForDuration, floored at the  *)
(* SLOWEST cadence (blockTime.ts:103-107), so the timeout always arrives   *)
(* no earlier in wall time than the naive estimate.  This module models    *)
(* height as a second clock advancing inside a cadence band:               *)
(*                                                                         *)
(*   FastCad * height <= clock <= SlowCad * (height + 1)                   *)
(*                                                                         *)
(* so every interleaving of "blocks came fast" and "blocks came slow"      *)
(* within the configured band is explored, and the margin claim (A2) is    *)
(* stated against the WORST end of the band.                               *)
(*                                                                         *)
(* WHAT IS DELIBERATELY ABSTRACTED AWAY                                    *)
(*                                                                         *)
(*  - The ERC20 approval dance (approve/reset-approve, erc20Token.ts).     *)
(*    It precedes the lock call in the same broadcast sequence; a crash    *)
(*    there leaves no lock and no row change, which Crash already covers.  *)
(*  - Token units, prices, 256-bit amounts.  Every swap is `Amount`.       *)
(*  - The lockDepth probe's two thresholds (minConfirmations AND           *)
(*    minAgeSeconds) are one "depth reached" step here: both are read off  *)
(*    the same probe block (lockDepth.ts:72-84) and a failed probe is      *)
(*    UNPROVEN, never absent - which is exactly "depth not reached yet".   *)
(*  - The contract's internal storage.  `evm` below IS the lock flag and   *)
(*    its disposition: claim deletes the flag on claim (backend.ts:109-110)*)
(*    and refund deletes it on refund, so absence is final.               *)
(*  - The sats covenant's construction.  `arkFund` is "the client's sats   *)
(*    sit at the covenant"; the spending leaves are SwapCore's `conf`.     *)
(*                                                                         *)
(* MODELLING DECISIONS THAT ARE ASSUMPTIONS, NOT FACTS                     *)
(*                                                                         *)
(*  (A1) `LockCommitFirst`.  The shell CASes quoted -> locking_evm BEFORE  *)
(*       the lock broadcast (evmOrchestrator.ts:281, comment :277-280),    *)
(*       so a second worker that read `quoted` loses its CAS and the       *)
(*       planner has no re-broadcast branch from locking_evm: at most one  *)
(*       lock call ever goes out.  The mutation broadcasts BEFORE the      *)
(*       CAS - the "simplification" a rewrite might make - and NoDoubleLock*)
(*       fails.                                                            *)
(*  (A2) THE MARGIN.  refundLocktime (wall) must be reachable strictly     *)
(*       AFTER the height timeout even at the SLOWEST cadence:             *)
(*       EvmTimeoutH * SlowCad < RefundLocktime.  The margin is only a     *)
(*       budget of wall-clock time; what makes the budget binding is the   *)
(*       URGENCY discipline below - a swap with a completable solver step  *)
(*       outstanding holds the clock, so the solver always spends the      *)
(*       budget before the client does.  Then the ERC20 refund opens       *)
(*       before the client's sats refund, so a client that wants both      *)
(*       must claim early enough that the pre-switch rule still has wall   *)
(*       time to claim the sats.  The mutation BreakDeadlineOrder          *)
(*       collapses the ordering and NoNetLoss fails.                       *)
(*  (A3) `ClaimLands`.  claimArkade is modelled as needing only serverUp   *)
(*       and an unspent covenant; the send corridor never re-reads the     *)
(*       outcome because `claiming` maps to `wait` in the planner          *)
(*       (evmSendPlan.ts:174-176).  See THE PARKED STATES below.           *)
(*  (A4) `RefundSeesClaim`.  SHIPPED, not an open assumption               *)
(*       (evmSendPlan.ts:163-172): `refunded` is written only for a        *)
(*       refund whose own receipt says it MINED.  The row used to record   *)
(*       it at SEND time, so a client claim that won the block race left   *)
(*       a terminal row saying `refunded` over tokens the client held -    *)
(*       and terminal is what made it unrecoverable, because it ended the  *)
(*       preimage scan that was still the swap's way out.  The mutation    *)
(*       records with no receipt and NoSilentLoss fails.  Finding F3,      *)
(*       fixed.                                                            *)
(*                                                                         *)
(*       ONE ARM IS DELIBERATELY NOT GREEN.  "The refund reverted and      *)
(*       there was nothing to refund" (evm = "none") is a settled outcome  *)
(*       to this model, which is an oracle, and NOT to the code, which     *)
(*       cannot tell it from "the client claimed and my preimage scan is   *)
(*       blind" - both present as (reverted, lock absent, no preimage).    *)
(*       Recording the pair would restore the F3 lie for the second        *)
(*       member, so the guard below is the single mined arm and those      *)
(*       rows wait in refunding_evm instead.                               *)
(*                                                                         *)
(*       A refund that reverts with the lock STILL PRESENT is not          *)
(*       modelled: RefundMines has no such behaviour, so the gas and       *)
(*       mis-set-timelock failures it would stand for are abstracted away  *)
(*       with the rest of the chain's error surface.  The shipped planner  *)
(*       sends that case to `stuck`, which NoSilentLoss permits from any   *)
(*       exposed state.                                                    *)
(*  (A5) `ScanFollowsTheRow`.  SHIPPED, not an open assumption             *)
(*       (evmOrchestrator.ts:247-248): the preimage scan opens on the      *)
(*       ROW having entered locking_evm, not on the patched txid.  The     *)
(*       txid patch is still a separate write after the lock broadcast     *)
(*       (:355-356) and a crash between them still leaves evm_lock_txid    *)
(*       null forever - it just no longer blinds the scan, which is the    *)
(*       whole point of moving the gate.  The mutation restores the txid    *)
(*       gate and NoNetLoss fails.  Finding F2, fixed.                     *)
(*                                                                         *)
(*       `TxidPatchAtomic` survives as the write ORDER, no longer as a     *)
(*       money assumption.  EvmSend_LostPatch.cfg runs the shipped split   *)
(*       (FALSE) against the shipped gate and is GREEN; the main cfg folds *)
(*       the patch only to keep the state space on facts that still bear   *)
(*       on an outcome.                                                    *)
(*  (A6) `LockLandsPromptly`.  The locking_evm timeout refund branch       *)
(*       cannot distinguish "lock never broadcast" from "lock broadcast    *)
(*       but still pending" - the isLockedAt probe says only what the      *)
(*       chain tip shows.  A pending lock tx can land AFTER the row was    *)
(*       recorded `refunded` (terminal, unmonitored), putting the solver's *)
(*       ERC20 out with the books closed.  Green assumes lock fate is      *)
(*       settled before the timeout; the mutation lets it land late and    *)
(*       NoSilentLoss fails.  Finding F4.                                  *)
(*                                                                         *)
(*  (A7) `TimeoutRefundCoversPresent`.  SHIPPED, not an open assumption    *)
(*       (evmSendPlan.ts:141-155): the locking_evm timeout refund fires at *)
(*       the height timeout whatever the lock's presence says.  It used to *)
(*       require the lock ABSENT, so a lock present but never proven deep  *)
(*       - the depth probe reads a failed node as UNPROVEN, never absent - *)
(*       parked the swap past its own timeout, and the client then claimed *)
(*       the ERC20 at any height and refunded its sats at the wall         *)
(*       locktime: the double loss the margin exists to prevent, delivered *)
(*       through the one branch that withheld the timeout.  The mutation   *)
(*       restores the absence condition and NoNetLoss fails.  Finding F5,  *)
(*       fixed.                                                            *)
(*                                                                         *)
(* THE PARKED STATES                                                       *)
(*                                                                         *)
(* The planner maps `claiming` to `wait` unconditionally: nothing          *)
(* re-drives it.  `refunding_evm` is no longer in that company - (A4) gave *)
(* it a receipt to read, so it leaves on its own for `refunded`, `stuck`   *)
(* or (via the pre-switch rule) `claiming`.  It still parks in the one     *)
(* window the receipt cannot reach: a crash between the refund broadcast   *)
(* and the txid patch (evmOrchestrator.ts:382-392) leaves nothing to ask   *)
(* about, the mirror of (A5) on the lock side.  A parked row is            *)
(* NON_TERMINAL, EXPOSED and holding cap with no `stuck` escalation of     *)
(* its own; an operator can still force one (evmCorridors.ts:209 parks     *)
(* any non-terminal row), which is not modelled here.                      *)
(* The money outcome is still bounded (NoNetLoss / NoSilentLoss), and      *)
(* Liveness below is stated so the parked states count as outcomes -       *)
(* anything stricter is red for reasons that have nothing to do with       *)
(* liveness.  This is finding F1, and EvmSend_Parked.cfg is its artifact.  *)
(*                                                                         *)
(* WHAT A GO IMPLEMENTER MUST PRESERVE                                     *)
(*                                                                         *)
(*  1. The CAS-before-broadcast order in lock_evm, and the pre-switch      *)
(*     preimage rule's precedence over every state branch.                 *)
(*  2. The evmLockTxid gate on the preimage scan (evmOrchestrator.ts:216): *)
(*     the contract DELETES the lock flag on claim, so gating the scan on  *)
(*     lock presence would hide exactly the claims that matter.  A crash   *)
(*     between the lock broadcast and the txid patch blinds the scan -     *)
(*     modelled here by PatchTxid being a separate step.                   *)
(*  3. evm_timeout is a HEIGHT, never seconds (evmOrchestrator.ts:397-406).*)
(*                                                                         *)
(* HOW THIS WAS CHECKED: see THE GREEN RUN and MUTATION CHECKS at the      *)
(* bottom of the module.                                                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC, SwapCore

CONSTANTS
    EvmTimeoutH,      \* the client's ERC20 refund opens at this HEIGHT
    RefundLocktime,   \* the client's sats refund opens at this WALL clock
    ValidUntil,       \* quote validity, wall clock
    MaxHeight,        \* height bound; keeps the state space finite
    FastCad,          \* fastest cadence: clock ticks per block, lower bound
    SlowCad,          \* slowest cadence: clock ticks per block, upper bound
    LockCommitFirst,  \* (A1) MUTATION: broadcast after CAS (TRUE) or before (FALSE)
    TxidPatchAtomic,  \* (A5) txid patch folded into the lock step (TRUE) or a
                      \*      separate step with a crash window (FALSE, shipped)
    ScanFollowsTheRow, \* (A5) MUTATION: the preimage scan opens on the row's
                      \*      own state (TRUE, shipped) or on the patched txid
                      \*      (FALSE, the pre-fix gate; F2 in RESULTS)
    LockLandsPromptly, \* (A6) MUTATION: the lock broadcast cannot land at or
                      \*      after the timeout height (TRUE) - FALSE is the
                      \*      shipped truth for a pending tx (F4 in RESULTS)
    TimeoutRefundCoversPresent, \* (A7) MUTATION: the locking_evm timeout refund
                      \*      fires with the lock PRESENT too (TRUE, the fix),
                      \*      not only with it absent (FALSE, shipped; F5)
    RefundSeesClaim,  \* (A4) MUTATION: refund recording waits for the receipt
                      \*      (TRUE, shipped) or records at send time (FALSE)
    AtomicAdmission,  \* MUTATION: quote re-checks the cap at insert
    BreakDeadlineOrder \* (A2) MUTATION: collapse the height/wall margin

ASSUME EvmTimeoutH \in Nat /\ RefundLocktime \in Nat /\ ValidUntil \in Nat
ASSUME MaxHeight \in Nat /\ FastCad \in Nat /\ SlowCad \in Nat
ASSUME FastCad >= 1 /\ SlowCad >= FastCad
ASSUME BreakDeadlineOrder \in BOOLEAN

\* The margin in checkable form: at the slowest cadence the height timeout
\* still arrives strictly before the wall-clock refund locktime.
MarginHolds == EvmTimeoutH * SlowCad < RefundLocktime
ASSUME BreakDeadlineOrder \/ MarginHolds

VARIABLES
    evmHeight,     \* the EVM chain tip, in blocks.  Advances inside the band.
    arkFund,       \* [Swaps -> {"none","funded"}] the client's sats at covenant
    evm,           \* [Swaps -> {"none","locked","clientClaimed","solverRefunded"}]
    evmConfirmed,  \* [Swaps -> BOOLEAN] the lockDepth probe's thresholds met
    lockTxid,      \* [Swaps -> BOOLEAN] evm_lock_txid patched on the row
    lockSends,     \* [Swaps -> 0..2] lock broadcasts issued; the (A1) counter
    refundSent     \* [Swaps -> BOOLEAN] a refund broadcast is in the mempool

LsVars == << evmHeight, arkFund, evm, evmConfirmed, lockTxid, lockSends,
             refundSent >>
vars   == << clock, st, loc, conf, serverUp, evmHeight, arkFund, evm,
             evmConfirmed, lockTxid, lockSends, refundSent >>

(***************************************************************************)
(* STATES AND EDGES.  Authority: planEvmSend + the shell CASes.            *)
(* `funded` is a planner state production never writes (no transition      *)
(* targets it); it is modelled because the planner handles it.             *)
(***************************************************************************)
Row    == { "none", "quoted", "funded", "locking_evm", "awaiting_claim",
            "claiming", "claimed", "refunding_evm", "refunded", "refused",
            "stuck" }
NonTerminal == { "quoted", "funded", "locking_evm", "awaiting_claim",
                 "claiming", "refunding_evm" }
Exposed  == { "locking_evm", "awaiting_claim", "claiming", "refunding_evm" }
Terminal == { "claimed", "refunded", "refused", "stuck" }
Drivable == NonTerminal \cup { "none" }

\* Every -> claiming / -> stuck pair is the pre-switch rule, not a state
\* branch.  The dead `funded` row has the planner's two edges.
Edges == [ x \in Row |->
    CASE x = "none"           -> { "quoted" }
      [] x = "quoted"         -> { "locking_evm", "claiming", "refused", "stuck" }
      [] x = "funded"         -> { "locking_evm", "claiming", "stuck" }
      [] x = "locking_evm"    -> { "awaiting_claim", "claiming",
                                   "refunding_evm", "stuck" }
      [] x = "awaiting_claim" -> { "claiming", "refunding_evm", "stuck" }
      [] x = "claiming"       -> { "claimed", "stuck" }
      [] x = "refunding_evm"  -> { "claiming", "refunded", "stuck" }
      [] OTHER                -> {} ]

AllSt == Row

(***************************************************************************)
(* MONEY.                                                                  *)
(*                                                                         *)
(* PaidOut: the solver's ERC20 left the contract account - the lock call   *)
(* landed.  Collected: the solver is made whole, by sats (its claim won    *)
(* the covenant) or by getting its ERC20 back (its refund won the          *)
(* contract).  NoNetLoss: the client may not hold BOTH the ERC20 and its   *)
(* own sats back.                                                          *)
(***************************************************************************)
PaidOut(s)   == evm[s] \in { "locked", "clientClaimed", "solverRefunded" }
Collected(s) == conf[s] = { "solverClaim" } \/ evm[s] = "solverRefunded"
NoNetLoss  == \A s \in Swaps : ~(evm[s] = "clientClaimed"
                                 /\ conf[s] = { "clientRefund" })
NoSilentLoss == NoSilentLossShape(PaidOut, Collected, Terminal, "stuck")
NoDoubleLock == \A s \in Swaps : lockSends[s] <= 1

TypeOK == /\ TypeOKCore(Row)
          /\ evmHeight \in 0..MaxHeight
          /\ arkFund \in [Swaps -> { "none", "funded" }]
          /\ evm \in [Swaps -> { "none", "locked", "clientClaimed",
                                 "solverRefunded" }]
          /\ evmConfirmed \in [Swaps -> BOOLEAN]
          /\ lockTxid \in [Swaps -> BOOLEAN]
          /\ lockSends \in [Swaps -> 0..2]
          /\ refundSent \in [Swaps -> BOOLEAN]

(***************************************************************************)
(* THE CADENCE BAND.  Height may advance only once at least FastCad wall   *)
(* ticks stand behind the next block; the wall clock may not advance so    *)
(* far that the slowest cadence would already have produced another block. *)
(***************************************************************************)
HeightSane == clock >= evmHeight * FastCad
              /\ clock <= (evmHeight + 1) * SlowCad

(***************************************************************************)
(* GUARDS over the worker's snapshot.                                      *)
(***************************************************************************)
\* The preimage scan, gated on THE ROW HAVING ENTERED locking_evm - the
\* honest guard of evmOrchestrator.ts:247-248.  Gating on lock PRESENCE
\* would hide claims, because the contract deletes the flag on claim; gating
\* on the patched TXID read one write too late, because the patch lands
\* after the broadcast (A5).  The CAS into locking_evm precedes the
\* broadcast, so nothing claimable exists before it - and `clientClaimed`
\* already entails the row got that far.
ClaimReadable(s) == evm[s] = "clientClaimed" /\ (ScanFollowsTheRow \/ lockTxid[s])

\* Height timeout reached, in blocks.
HeightUp == evmHeight >= EvmTimeoutH

\* The wall-clock deadlines.
QuoteStale  == clock >= ValidUntil
RefundOpen  == clock >= RefundLocktime

(***************************************************************************)
(* URGENCY.  The margins buy the solver wall-clock time to ACT, not to     *)
(* wait: the sweep loop runs on a seconds cadence against deadlines that   *)
(* are minutes-to-hours wide, so a swap with an immediately-completable    *)
(* solver step outstanding must be driven before the wall clock moves on.  *)
(* Same discipline as OnchainReceive's Urgent/SolverBehind.  Without it    *)
(* the client can schedule its ERC20 claim at the exact wall locktime and  *)
(* the model cannot tell "solver was slow" from "solver had no budget".    *)
(***************************************************************************)
Urgent(s) ==
    \/ st[s] = "none"                                          \* admission settles at once
    \/ (st[s] = "quoted" /\ arkFund[s] = "funded")             \* lock now
    \/ (st[s] = "quoted" /\ (QuoteStale \/ RefundOpen))        \* refuse now
    \/ (st[s] = "locking_evm" /\ evm[s] = "locked"
        /\ evmConfirmed[s])                                    \* adopt the lock
    \/ (st[s] = "locking_evm" /\ HeightUp
        /\ (TimeoutRefundCoversPresent \/ evm[s] # "locked"))  \* refund now
    \/ (st[s] = "awaiting_claim" /\ HeightUp)                  \* refund now
    \* A contested-leg effect in flight holds the clock: a broadcast refund
    \* lands on its own (mempool mining needs no worker), and the margin
    \* exists so it lands before the wall locktime.  The client may not
    \* advance the wall past a landing the sweep has already sent.  Same
    \* load-bearing discipline as OnchainSend's `claiming` disjunct.
    \/ (refundSent[s] /\ evm[s] = "locked")                    \* the refund mines now
    \* `claiming` with the claim still unconfirmed is covered by the
    \* pre-switch disjunct below; claiming with the claim CONFIRMED is one
    \* of the two accepted parked states (its push phase is SF-forced), so
    \* holding the clock for it would freeze every other swap at the park.
    \/ (st[s] \in NonTerminal /\ ClaimReadable(s)
        /\ (st[s] # "claiming" \/ conf[s] # { "solverClaim" }))  \* P readable: claim or stick NOW

SolverBehind == \E s \in Swaps : Urgent(s)

HeightTick ==
    /\ evmHeight < MaxHeight
    /\ clock >= (evmHeight + 1) * FastCad
    /\ evmHeight' = evmHeight + 1
    /\ UNCHANGED << clock, st, loc, conf, serverUp >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, lockTxid, lockSends, refundSent >>

Tick ==
    /\ TickCore
    /\ ~SolverBehind
    /\ clock + 1 <= (evmHeight + 1) * SlowCad
    /\ UNCHANGED LsVars

Censor(w) == CensorCore /\ UNCHANGED LsVars

(***************************************************************************)
(* ENVIRONMENT.  The client, the contract, the miner.                      *)
(***************************************************************************)
\* The client funds the covenant with its sats.  Possible from the moment
\* the quote exists; a funding that lands after the quote went stale is the
\* refused-and-swept case, abstracted away (sats back to client, no solver
\* money involved).
ClientFundsArkade(s) ==
    /\ arkFund[s] = "none"
    /\ st[s] \in Drivable
    /\ arkFund' = [arkFund EXCEPT ![s] = "funded"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << evm, evmConfirmed, lockTxid, lockSends, refundSent >>

\* The client claims the ERC20 with the preimage.  The contract reveals P
\* in the Claim event and deletes the lock flag - one step, because the
\* event and the flag change are the same transaction.  Valid at any
\* height: the contract does not gate the claim on the timeout.
ClientClaimsEvm(s) ==
    /\ evm[s] = "locked"
    /\ evm' = [evm EXCEPT ![s] = "clientClaimed"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evmConfirmed, lockTxid, lockSends, refundSent >>

\* The client refunds its sats, once the wall locktime opens and the server
\* co-signs.  The contested output: SwapCore's conf, at most one winner.
ClientRefundsArkade(s) ==
    /\ arkFund[s] = "funded"
    /\ RefundOpen
    /\ serverUp
    /\ SpendAccepted(s, "clientRefund")
    /\ UNCHANGED << clock, st, loc, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, lockTxid, lockSends, refundSent >>

(***************************************************************************)
(* WORKER ACTIONS.  The observation snapshot is one ReadSwap; the planner  *)
(* is pure; every effect below names the planner branch it executes.       *)
(***************************************************************************)
\* store.get(id) plus the one Promise.all snapshot (funded / lockPresent /
\* height) and the gated preimage scan - all sampled in one breath,
\* evmOrchestrator.ts:192-223.  res compresses what the planner needs.
ReadSwap(w, s) ==
    /\ ReadRowWith(w, s, Drivable,
           CASE st[s] = "none" ->
                    IF Exposure(NonTerminal) + Amount <= MaxExposed
                      THEN "capOk" ELSE "capFull"
             [] st[s] = "quoted" ->
                    IF arkFund[s] = "funded" THEN "funded" ELSE "empty"
             [] OTHER ->
                    IF ClaimReadable(s) THEN "revealed" ELSE "clear")
    /\ UNCHANGED LsVars

GiveUp(w) ==
    /\ \/ loc[w].phase = "read"
       \* A lock broadcast still pending at the timeout height is moot:
       \* (A6) bars it from landing now, so the shell abandons the attempt
       \* and the row goes to its timeout refund instead of wedging here.
       \/ /\ loc[w].phase = "sentLock"
          /\ evm[loc[w].swap] = "none"
          /\ HeightUp
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp >>
    /\ UNCHANGED LsVars

\* Crash can strike in any phase.  Crashes in the push phases are what
\* strand the parked states (see THE PARKED STATES).
Crash(w) == CrashCore(w) /\ UNCHANGED LsVars

\* (A5) THE SCAN-GATE CRASH WINDOW.  The txid patch is a separate write
\* after the lock broadcast (evmOrchestrator.ts:306-310); a crash between
\* them leaves evm_lock_txid null forever, which blinds the gated preimage
\* scan.  Green folds the patch into LockLands (TxidPatchAtomic = TRUE, the
\* fix); the mutation keeps it a separate step and NoNetLoss fails when the
\* blinded scan lets the client take both legs.
\*
\* quote(): the INSERT, cap-checked at read; AtomicAdmission = FALSE drops
\* the re-check here, which is the admission race the reservation lease
\* closes in the shipped code (evmOrchestrator.ts:435-451).
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
    /\ UNCHANGED LsVars

\* quoted, nothing arrived, or arrived too late -> refused.  Pre-exposure;
\* the client's late funding is its own problem (the covenant sweep returns
\* it, outside this model's money).
RefuseQuoted(w, s) ==
    /\ Saw(w, s, "quoted")
    /\ \/ /\ loc[w].res = "empty"
          /\ QuoteStale \/ RefundOpen
       \/ /\ loc[w].res = "funded"
          /\ QuoteStale
    /\ \/ CasWon(s, "quoted", "refused")
       \/ CasLost(s, "quoted")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* lock_evm: the CAS FIRST (A1), then the broadcast is a separate step so a
\* crash can land between them - and between broadcast and txid patch.
SubmitEvmLock(w, s) ==
    /\ \/ Saw(w, s, "quoted") /\ loc[w].res = "funded" /\ ~QuoteStale
       \/ Saw(w, s, "funded")
    /\ IF LockCommitFirst
       THEN UNCHANGED lockSends
       ELSE \* the mutation: send first, record after - two readers both send
            lockSends' = [lockSends EXCEPT ![s] = lockSends[s] + 1]
    /\ \/ /\ CasWon(s, loc[w].seen, "locking_evm")
          /\ Advance(w, "sentLock", "none")
       \/ /\ CasLost(s, loc[w].seen)
          /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << evmHeight, arkFund, evm, evmConfirmed, lockTxid,
                    refundSent >>

\* The lock broadcast lands: transferFrom has run.  THE irreversible act of
\* this corridor.  With LockCommitFirst the send happens HERE; with the
\* mutation it already happened in SubmitEvmLock.  (A6): a pending EVM
\* transaction can in principle land at ANY later height, and the planner's
\* locking_evm refund branch cannot tell "never broadcast" from "not mined
\* yet" - F4.  Green assumes the lock's fate is settled before the timeout.
LockLands(w, s) ==
    /\ At(w, s, "sentLock")
    /\ evm[s] = "none"
    /\ LockLandsPromptly => evmHeight < EvmTimeoutH
    /\ IF LockCommitFirst
       THEN lockSends' = [lockSends EXCEPT ![s] = lockSends[s] + 1]
       ELSE UNCHANGED lockSends
    /\ evm' = [evm EXCEPT ![s] = "locked"]
    /\ lockTxid' = [lockTxid EXCEPT ![s] = TxidPatchAtomic \/ lockTxid[s]]
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evmConfirmed, refundSent >>

\* The txid patch: the scan gate opens.  A crash before this step leaves
\* lockTxid FALSE forever - the lock exists, the scan never runs.
PatchTxid(w, s) ==
    /\ ~TxidPatchAtomic
    /\ At(w, s, "sentLock")
    /\ evm[s] = "locked"
    /\ ~lockTxid[s]
    /\ lockTxid' = [lockTxid EXCEPT ![s] = TRUE]
    /\ Park(w)
    /\ UNCHANGED << clock, st, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, lockSends, refundSent >>

\* The depth probe says final.  Measured, never fed back from config
\* (evmOrchestrator.ts:240-250); modelled as one environment step.
ConfirmEvmLock(s) ==
    /\ evm[s] = "locked"
    /\ ~evmConfirmed[s]
    /\ evmConfirmed' = [evmConfirmed EXCEPT ![s] = TRUE]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, lockTxid, lockSends, refundSent >>

\* locking_evm, lock present and deep -> awaiting_claim.
RecordLock(w, s) ==
    /\ Saw(w, s, "locking_evm")
    /\ loc[w].res = "clear"
    /\ evm[s] = "locked" /\ evmConfirmed[s]
    /\ \/ CasWon(s, "locking_evm", "awaiting_claim")
       \/ CasLost(s, "locking_evm")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* refund_evm.  From locking_evm the planner requires the lock ABSENT
\* (:138-143); from awaiting_claim it is unconditional at the height
\* timeout (:151-154) - which is the (A4) window.  (A7): the absence condition
\* defeats the whole margin whenever the lock is present but never proven
\* deep - the timeout exists to end the client's option, and the shipped
\* branch structure withholds it exactly then.  The CAS, then the broadcast
\* is a separate step, then the recording CAS.
SubmitEvmRefund(w, s) ==
    /\ \/ /\ Saw(w, s, "locking_evm")
          /\ loc[w].res = "clear"
          /\ (TimeoutRefundCoversPresent \/ evm[s] # "locked")
          /\ HeightUp
       \/ /\ Saw(w, s, "awaiting_claim")
          /\ loc[w].res = "clear"
          /\ HeightUp
    /\ \/ /\ CasWon(s, loc[w].seen, "refunding_evm")
          /\ Advance(w, "sentRefund", "none")
          \* The broadcast rides with the CAS: once the row says
          \* refunding_evm, the mempool has the tx.  It lands on its own
          \* (RefundMines) - a crashed worker cannot un-broadcast it.
          /\ refundSent' = [refundSent EXCEPT ![s] = TRUE]
       \/ /\ CasLost(s, loc[w].seen)
          /\ Park(w)
          /\ UNCHANGED refundSent
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED << evmHeight, arkFund, evm, evmConfirmed, lockTxid,
                    lockSends >>

\* The miner lands the broadcast refund: the contract deletes the lock and
\* returns the ERC20.  An ENVIRONMENT step - the mempool owes no worker
\* anything.  If the client's claim got there first the refund reverts and
\* nothing changes (ClientClaimsEvm already ran); if no lock ever landed
\* the broadcast was a harmless revert and the flag just never fires.
RefundMines(s) ==
    /\ refundSent[s]
    /\ evm[s] = "locked"
    /\ evm' = [evm EXCEPT ![s] = "solverRefunded"]
    /\ UNCHANGED << clock, st, loc, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evmConfirmed, lockTxid, lockSends, refundSent >>

\* The recording CAS, and (A4) its receipt check.  RefundSeesClaim = TRUE
\* is the SHIPPED planner (evmSendPlan.ts:163-172): `refunded` is written
\* only for a refund the receipt says MINED.  The single arm is the point
\* - see (A4) for why "there was nothing to refund" is not a second one.
\* RefundSeesClaim = FALSE drops the check and writes the word over any
\* chain state, including a lock the client already claimed; NoSilentLoss
\* names the lie.
\*
\* Still a push-phase step rather than a fresh read, which is the
\* ADVERSARIAL abstraction: the shipped shell broadcasts and returns, so
\* the recording is decided a tick later, while this lets it be attempted
\* in the same breath as the broadcast.  Every ordering the shell can
\* produce is included in that.
RecordEvmRefund(w, s) ==
    /\ At(w, s, "sentRefund")
    /\ IF RefundSeesClaim
        THEN evm[s] = "solverRefunded"
        ELSE TRUE
    /\ \/ CasWon(s, "refunding_evm", "refunded")
       \/ CasLost(s, "refunding_evm")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, lockTxid, lockSends,
                    refundSent >>

\* THE PRE-SWITCH RULE, early arm: P seen before the wall locktime.  CAS
\* into claiming (persisting P), the Arkade claim is a separate step, then
\* the recording CAS.  Enabled from ANY drivable non-terminal state.
ClaimArkade(w, s) ==
    /\ Saw(w, s, loc[w].seen)
    /\ loc[w].seen \in NonTerminal
    /\ loc[w].res = "revealed"
    /\ ~RefundOpen
    /\ \/ /\ loc[w].seen = "claiming"
          \* already claiming: the shell skips the state CAS and retries
          \* claimArkade itself - the retry IS the pre-switch rule re-firing
          /\ UNCHANGED st
          /\ Advance(w, "sentClaim", "none")
       \/ /\ loc[w].seen # "claiming"
          /\ \/ /\ CasWon(s, loc[w].seen, "claiming")
                /\ Advance(w, "sentClaim", "none")
             \/ /\ CasLost(s, loc[w].seen)
                /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* claimArkade: the collaborative spend of the covenant.  Needs the server
\* and an unspent output; if the client's refund landed first the call
\* throws and the row parks in `claiming` - THE PARKED STATES.
SubmitArkClaim(w, s) ==
    /\ At(w, s, "sentClaim")
    /\ IF /\ serverUp
          /\ conf[s] = {}
       THEN /\ SpendAccepted(s, "solverClaim")
       ELSE UNCHANGED conf
    /\ Park(w)
    /\ UNCHANGED << clock, st, serverUp, evmHeight >>
    /\ UNCHANGED << arkFund, evm, evmConfirmed, lockTxid, lockSends, refundSent >>

\* The recording CAS.  A crash before it leaves `claiming` parked with the
\* outcome already final on the covenant.
\* the shell records `claimed` only after claimArkade RETURNS
\* (evmOrchestrator.ts:327-328), so a thrown claim never records.
RecordClaimed(w, s) ==
    /\ Saw(w, s, "claiming")
    /\ conf[s] = { "solverClaim" }
    /\ \/ CasWon(s, "claiming", "claimed")
       \/ CasLost(s, "claiming")
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

\* THE PRE-SWITCH RULE, late arm: P seen at or after the wall locktime -
\* the sats may already be client-refundable, so the row is failed loudly.
StickLate(w, s) ==
    /\ Saw(w, s, loc[w].seen)
    /\ loc[w].seen \in NonTerminal
    /\ loc[w].res = "revealed"
    /\ RefundOpen
    /\ \/ CasWon(s, loc[w].seen, "stuck")
       \/ CasLost(s, loc[w].seen)
    /\ Park(w)
    /\ UNCHANGED << clock, conf, serverUp >>
    /\ UNCHANGED LsVars

(***************************************************************************)
(* NEXT, FAIRNESS, SPEC.                                                   *)
(***************************************************************************)
DriveRow(w, s) ==
       InsertQuote(w, s)      \/ RefuseQuoted(w, s)
    \/ RecordLock(w, s)       \/ SubmitEvmRefund(w, s)
    \/ SubmitEvmLock(w, s)
    \/ ClaimArkade(w, s)      \/ StickLate(w, s)
    \/ RecordClaimed(w, s)

PushChain(w, s) ==
       LockLands(w, s) \/ PatchTxid(w, s)
    \/ SubmitArkClaim(w, s)
    \/ RecordEvmRefund(w, s)

Env(s) ==
       ClientFundsArkade(s) \/ ClientClaimsEvm(s) \/ ClientRefundsArkade(s)
    \/ ConfirmEvmLock(s) \/ RefundMines(s)

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
    /\ lockTxid = [ s \in Swaps |-> FALSE ]
    /\ lockSends = [ s \in Swaps |-> 0 ]
    /\ refundSent = [ s \in Swaps |-> FALSE ]

\* T1/T3 shape: quantify over swaps, \E over workers.  The environment is
\* weakly fair only where the money argument needs it: the client may
\* always walk away, but a chain that never ticks is not a chain.  Tick is
\* STRONGLY fair: a crash-retry loop around the pre-switch claim makes
\* SolverBehind flicker (the push phase is transiently live), and WF cannot
\* discharge an obligation whose enabledness is intermittent - the wall
\* clock would starve at the exact park the liveness statement accepts.
\* SF forces the clock through whenever it is enabled infinitely often; a
\* perpetually urgent swap still blocks it continuously and owes nothing.
Fairness ==
    /\ \A w \in Workers : WF_vars(GiveUp(w))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : ReadSwap(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : DriveRow(w, s))
    /\ \A s \in Swaps : SF_vars(\E w \in Workers : PushChain(w, s))
    /\ SF_vars(Tick)
    /\ WF_vars(HeightTick)
    \* The mempool does not sit on a broadcast refund forever: while it is
    \* minable it eventually mines (or the client's claim lands first,
    \* which disables it - no obligation either way).
    /\ \A s \in Swaps : WF_vars(RefundMines(s))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* INVARIANTS AND PROPERTIES.                                              *)
(***************************************************************************)
AtMostOneOutcome == AtMostOneOutcomeInv
ExposureBounded  == ExposureBoundedBy(NonTerminal)

\* Edge-table assertions.  The EVM stores have no LEGAL_EDGES table - these
\* pin the PLANNER's action set instead (evmSendPlan.ts), which is the
\* authority a Go rewrite must reproduce.
RefusedUnreachableFromExposed ==
    \A x \in Exposed : "refused" \notin Edges[x]
StuckReachableFromEveryExposed ==
    \A x \in Exposed : "stuck" \in Edges[x]

ForwardOnly == [][ ForwardOnlyStep(Edges) ]_vars

\* THE PARKED STATES, as the liveness statement: while the server
\* co-signs, every swap reaches a terminal state OR parks in one of the
\* two states the shipped planner never re-drives.  The money invariants
\* above bound what parking may cost; F1 in RESULTS names it.
Liveness == ([]serverUp) =>
    \A s \in Swaps : <>(st[s] \in Terminal \cup { "claiming", "refunding_evm" })

\* The artifact property for EvmSend_Parked.cfg: strict terminality, no
\* accepted parking.  EXPECTED violated there - a crash in the claim or
\* refund push leaves the row in claiming/refunding_evm forever (the
\* planner never re-drives them, F1), and only the money invariants bound
\* what that parking costs.
LivenessStrict == ([]serverUp) => EventuallyTerminal(Terminal)

Perms == Permutations(Swaps) \cup Permutations(Workers)

\* SwapCore constant overrides, supplied by the cfgs.
ESPhases  == { "idle", "read", "sentLock", "sentRefund", "sentClaim" }
ESResults == { "none", "capOk", "capFull", "funded", "empty",
               "revealed", "clear" }
ESSpendKinds == { "solverClaim", "clientRefund" }

-----------------------------------------------------------------------------
(***************************************************************************)
(* THE GREEN RUN                                                           *)
(*                                                                         *)
(* EvmSend.cfg: all assumptions at their safe settings.  GREEN:            *)
(* 12,719,321 states generated, 1,705,266 distinct, depth 46, 10min 42s    *)
(* (-workers 4).  All nine invariants, ForwardOnly, and Liveness.          *)
(*                                                                         *)
(* FINDINGS                                                                *)
(*                                                                         *)
(* F1  THE PARKED STATES.  The planner maps claiming to wait               *)
(*     unconditionally: a thrown claimArkade after the state CAS, or a     *)
(*     crash between the side effect and its recording CAS, parks the row  *)
(*     forever, NON_TERMINAL and holding cap.  refunding_evm now leaves    *)
(*     on its receipt (F3), except in the one window with no receipt to    *)
(*     read - a crash between the refund broadcast and the txid patch.     *)
(*     Liveness accepts the parking (EvmSend_Parked.cfg shows the strict   *)
(*     statement is false); the money invariants bound the cost.           *)
(* F2  (A5) THE BLINDED SCAN - FIXED.  The scan USED TO be gated on       *)
(*     `evm_lock_txid`, patched one write AFTER the lock broadcast, so a   *)
(*     crash between them left it shut forever over a lock that existed:   *)
(*     the client claimed invisibly, the timeout refund took the row and   *)
(*     the sats refund took the rest.  The gate is now the row's own state *)
(*     (evmOrchestrator.ts:247-248), which the CAS sets BEFORE the         *)
(*     broadcast, so EvmSend_BlindScan.cfg is a genuine mutation - it      *)
(*     restores the txid gate - and EvmSend_LostPatch.cfg is its control:  *)
(*     the same lost patch, the shipped gate, green.                       *)
(* F3  (A4) THE SEND-TIME RECORD - FIXED.  The row USED TO record          *)
(*     `refunded` when the refund was SENT, not when it landed; a claim    *)
(*     that won the block race left a terminal row lying over the money,   *)
(*     and terminal ended the preimage scan that was the swap's way out.   *)
(*     The shipped planner now records only a MINED refund                 *)
(*     (evmSendPlan.ts:163-172), so EvmSend_NoReceipt.cfg is a genuine     *)
(*     mutation - it deletes the shipped check - rather than a record of   *)
(*     shipped behaviour.                                                  *)
(* F4  (A6) THE LATE LOCK - STILL OPEN, and the (A4) fix moved which       *)
(*     invariant catches it.  A pending lock broadcast can land at any     *)
(*     later height.  It used to land after a terminal `refunded` row had  *)
(*     closed the books, which was a NoSilentLoss at depth 15; recording   *)
(*     `refunded` on the strength of the broadcast is what (A4) stopped,   *)
(*     so that witness is gone.  The expensive half is not: the lock       *)
(*     lands, the client claims it and still refunds its sats.             *)
(*     EvmSend_LateLock.cfg: NoNetLoss, depth 20.                          *)
(* F5  (A7) THE STRANDED LOCK - FIXED.  The locking_evm timeout refund    *)
(*     USED TO require the lock ABSENT, so a lock present but never proven *)
(*     deep (the depth probe's failed read is UNPROVEN, never absent -     *)
(*     lockDepth.ts) withheld the very timeout that ends the client's      *)
(*     option, and the client took both legs at the wall locktime.  The    *)
(*     branch now reads the timeout before the presence (evmSendPlan.ts:   *)
(*     141-155), so EvmSend_LockStrand.cfg is a genuine mutation - it      *)
(*     restores the absence condition - rather than a record of shipped    *)
(*     behaviour.                                                          *)
(*                                                                         *)
(* MUTATION CHECKS - RESULTS                                               *)
(*                                                                         *)
(* Re-run in full after the (A4) fix; every count below is from that run   *)
(* (-workers 4).  A mutation run stops at the FIRST violation, so its      *)
(* counts and depth wobble by a step or so with the worker interleaving -  *)
(* the invariant that falls is the stable fact, and the one to read.       *)
(*                                                                         *)
(*   EvmSend_DoubleLock.cfg    LockCommitFirst = FALSE                     *)
(*                             NoDoubleLock violated, depth 9 (2,942/603)  *)
(*   EvmSend_NoReceipt.cfg     RefundSeesClaim = FALSE (mutation of a      *)
(*                             SHIPPED guard since the F3 fix)             *)
(*                             NoSilentLoss violated, depth 15 (59,702/    *)
(*                             11,141)                                     *)
(*   EvmSend_BlindScan.cfg     ScanFollowsTheRow = FALSE over              *)
(*                             TxidPatchAtomic = FALSE (mutation of a      *)
(*                             SHIPPED guard since the F2 fix)             *)
(*                             NoNetLoss violated, depth 21 (442,860/      *)
(*                             66,298)                                     *)
(*   EvmSend_LostPatch.cfg     ScanFollowsTheRow = TRUE over               *)
(*                             TxidPatchAtomic = FALSE - the F2 CONTROL.   *)
(*                             GREEN: 12,719,321/1,705,266, depth 46,      *)
(*                             12min 14s, Liveness included.  Read the     *)
(*                             KNOWN-VACUOUS note below before leaning on  *)
(*                             it: it is green by isomorphism.             *)
(*   EvmSend_LateLock.cfg      LockLandsPromptly = FALSE (shipped)         *)
(*                             NoNetLoss violated, depth 21 (693,321/      *)
(*                             113,905).  WAS NoSilentLoss at depth 15;    *)
(*                             see F4 - the (A4) fix removed that witness  *)
(*                             and left the double-take one.  STILL OPEN.  *)
(*   EvmSend_LockStrand.cfg    TimeoutRefundCoversPresent = FALSE          *)
(*                             (mutation of a SHIPPED guard since the F5   *)
(*                             fix)  NoNetLoss violated, depth 19          *)
(*                             (284,778/49,031)                            *)
(*   EvmSend_Overexposed.cfg   AtomicAdmission = FALSE, MaxExposed = 1     *)
(*                             ExposureBounded violated, depth 7           *)
(*                             (1,096/285); the green cfg is the control   *)
(*   EvmSend_BrokenMargin.cfg  BreakDeadlineOrder = TRUE,                  *)
(*                             RefundLocktime = 2: NoNetLoss violated,     *)
(*                             depth 13 (40,269/7,644)                     *)
(*   EvmSend_Parked.cfg        LivenessStrict artifact: violated - F1      *)
(*                             named                                       *)
(*                                                                         *)
(* KNOWN-VACUOUS IN THE GREEN CFG (coverage run, -coverage 1):             *)
(*                                                                         *)
(*   PatchTxid  fires 0:0 IN EVERY CFG, including the ones that set        *)
(*     TxidPatchAtomic = FALSE.  Not for the reason this note used to      *)
(*     give.  LockLands ends with Park(w), so no worker is ever at phase   *)
(*     `sentLock` afterwards, and PatchTxid requires At(w, s, "sentLock"): *)
(*     it is unreachable whatever the constant says.  So                   *)
(*     TxidPatchAtomic = FALSE means "the txid is NEVER patched", not      *)
(*     "the patch may be lost".  That is STRICTLY STRONGER than the code,  *)
(*     which patches on all but the crashing tick, so BlindScan's          *)
(*     NoNetLoss witness remains a real behaviour - a crash there does     *)
(*     leave the column null forever.  What it costs is the control:       *)
(*     EvmSend_LostPatch.cfg is green by ISOMORPHISM with the main cfg     *)
(*     (lockTxid is deterministic in both and, with the shipped gate,      *)
(*     reaches no guard) rather than by exploring a mixed window.          *)
(*     Verified, not assumed: -coverage 1 on EvmSend_BlindScan.cfg reports *)
(*     PatchTxid 0:0 against LockLands 835:2003.                           *)
(*   GiveUp     fires 0:N - enabled often (the sub-clause counts prove     *)
(*     it), but every GiveUp successor is state-identical to a Crash       *)
(*     successor (both Park with everything else unchanged), so TLC        *)
(*     counts no new-state firings.  Its role is the FAIRNESS obligation:  *)
(*     WF(GiveUp) is the voluntary exit from a wedged phase - in           *)
(*     particular the sentLock phase past the timeout height, where the    *)
(*     liveness lasso sat until the arm was added.  WF(Crash) would force  *)
(*     crashes, which is not the statement the model makes.                *)
(*                                                                         *)
(* Every other action fires in the green cfg.                              *)
(***************************************************************************)
=============================================================================
