# TLA+ models of the swap corridors

Formal models of the solver's six corridors — LightningSend, LightningReceive,
OnchainSend, OnchainReceive, EvmSend, EvmReceive — checked with TLC. Each module
models the corridor's row as a state machine with N concurrent workers, each
Worker's read separated from its write, and Worker crashes between the store CAS
and the irreversible side effect. The claim under test is the one the TypeScript
itself makes (`packages/solver-app/src/worker.ts:20-25`): money-safety rests on the store's
compare-and-swap alone, not on the in-process `inFlight` Set, and therefore
survives a rewrite with more processes.

| File | What it is |
|---|---|
| `SwapCore.tla` | Shared machinery: the CAS, the worker/crash model, the clock, the contested-outpoint chain. Header documents traps T1–T4. |
| `LightningSend.tla` | quoted → funded → paying → paid → claiming |
| `LightningReceive.tla` | quoted → armed → funded → claimed → settled |
| `OnchainSend.tla` | The L1 HTLC leg and its mempool race. Timing invariants are conditional on the `(A2) Urgent` assumption — read that note before trusting any timing pass. |
| `OnchainReceive.tla` | The confirmation policy and the two-sided exposure. |
| `EvmSend.tla` | The planner/shell split and the height-vs-wall margin. F2, F3, F5 and F6 are FIXED, so `EvmSend_BlindScan`, `EvmSend_NoReceipt`, `EvmSend_LockStrand` and `EvmSend_LostRefund` all mutate guards the code really ships. F4, the late lock, is the one still open — `LockLandsPromptly` is an assumption, not a guard, so read the findings before trusting a pass. |
| `EvmReceive.tla` | The mirror corridor: the solver funds against a lock it does not control. The parked `refunding_arkade` with an unspent covenant (F4) is a double loss under a patient client. |

Bugs the models prove in the shipped TypeScript are named F1... per module in
the module comments (each module numbers its own findings); the ones ranked
highest are tracked as GitHub issues so they outlive this directory.

## Prerequisites

- Any recent JDK (verified on Temurin 25).
- `tla2tools.jar` from the [TLA+ releases page](https://github.com/tlaplus/tlaplus/releases)
  (the `tla2tools.jar` asset). It needs no install — keep it anywhere and put
  it on the classpath.

## Running a model

From this directory (`spec/tla`):

```sh
java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC -config LightningSend.cfg LightningSend
```

- The positional argument is the **module** (the `.tla` file); the cfg is
  named with `-config`. Almost every cfg here has a different name from its
  module, so give both. Passing `Foo.cfg` positionally makes TLC look for
  `Foo.cfg.cfg`.
- `-workers N` sets the worker count; the recorded checkpoint runs used 2.
- `-coverage 1` after a green run prints how many times each action fired —
  the check that no action is dead spec. (`OnchainReceive.cfg`'s checkpoint
  comment records what its coverage run found.)
- TLC writes its state queue and fingerprints to `states/` in the cwd —
  gitignored, and safe to delete at any time; it regenerates on every run.
- Syntax-check a module without model checking:
  `java -cp /path/to/tla2tools.jar tla2sany.SANY LightningSend.tla`

## What the cfgs are

Every module ships one green cfg (`LightningSend.cfg`, …) — the corridor as
shipped — plus scenario and mutation cfgs:

- **Mutation cfgs** (`_Broken`, `_DoubleFund`, `_StaleIndexer`, `_ZeroConf`,
  `_Censored`, `_Overexposed`, …) flip exactly one `Break<Guard>` constant to
  delete one real guard. Each header names the src/ file:line the constant
  abstracts and states the expected violated invariant. A spec that stays
  green when a guard is deleted proves nothing; these runs are the evidence
  the invariants have teeth.
- **Control cfgs** (`_BrokenControl`, `_OverexposedControl`) re-run the
  mutation with the guard restored and must be GREEN. The control is what
  makes the paired violation a proof about the guard rather than about the
  constants around it.

Every cfg header carries an `EXPECTED RESULT` line. The full set is 53 cfgs —
15 green, 38 expected violations — and the green modules' checkpoint comments
record the per-cfg results. After touching a module or any of its cfgs,
re-run the module's full set and confirm every result still matches its
header.

## Reading the results

- **Green:** `Model checking completed. No error has been found.` followed by
  the generated/distinct/depth numbers. Paste them into the module's
  checkpoint comment next to the cfg that produced them.
- **Mutation:** TLC stops at the first violated invariant and prints the
  counterexample trace (`Error: Invariant X is violated`, ending in the state
  dump). That early stop is the expected outcome for every cfg whose header
  says so — do not "fix" the spec until it goes away; fix the guard in the
  TypeScript, or accept the finding and track it.
- A liveness violation prints as `Error: The following behavior violates
  property Liveness` with the infinite-cycle suffix marked `<Stuttering>`-free.
  No cfg in the current set violates liveness: the canonical example was
  `LightningReceive_Censored.cfg`, which went GREEN once the covenant's solo
  exit was modelled — its header keeps the history and what still holds of
  the shipped TypeScript.

## Adding a guard or a mutation

1. Each guard has a `Break<Guard> = TRUE/FALSE` constant in the `.tla`; the
   green cfg pins it FALSE and the mutation cfg flips it TRUE. To model a
   newly shipped guard, add its own Break constant where the guarded action
   lives, following the existing pattern.
2. Copy the module's green cfg, change the one constant, and write a header
   saying which line of real code the flip deletes and which invariant must
   fall. If the mutation changes anything beyond a boolean flip (deadline,
   cap, horizon), also ship the paired `_Control` cfg with the guard restored.
3. Only the **relative ordering** of deadlines is modelled, because that
   ordering is all the guards compare (see `LightningSend.cfg`'s header for
   the worked example). Keep that when picking constants.
4. Regenerate the checkpoint: run the green cfg, paste the numbers into the
   module comment, and note the cfg name, flags, and runtime next to them.

Do not, under any circumstances:

- Add `SYMMETRY` — unsound together with the per-swap fairness conditions;
  produces counterexamples whose cycle exists only in the quotient graph
  (trap T4, verified on LightningSend).
- Merge or reorder fairness groups — the merged-variant liveness failure for
  OnchainReceive is recorded in its module comment; the split exists for a
  real reason (trap T2).
- Raise the swap/worker counts to look thorough — every finding lives in the
  read / side-effect / CAS interleaving, which is fully reachable with two
  workers on one row inside a single tick. Bigger models cost hours and add
  no interleavings.

When the TypeScript changes a guard the specs cite, update the model, the
cfg headers' file:line references, and the checkpoint comment in the same
commit.
