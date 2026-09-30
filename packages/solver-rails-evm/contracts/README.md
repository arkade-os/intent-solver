# Intent receiver

An ordinary ERC-20 transfer funds an immutable receiver. Anyone can activate it
once to register the exact destination HTLC. The receiver accepts activation
only before both its block cutoff and timestamp cutoff. Neither a balance nor
an external execution status is authority to collect the input-side payment.
The settlement signal is the exact finalized HTLC claim and its valid preimage.

The fixed solver refund address receives excess, wrong-token, duplicate, and
expired unactivated funds. Before either cutoff closes, recovery preserves the
entire required token amount. Activation and recovery check actual token balance
changes and support tokens returning no boolean; fee-taking or dishonest tokens
are rejected. Operators must explicitly allowlist token and swap code. Tokens
with upgradeable implementations additionally retain their administrator's trust
and freeze risks; a proxy runtime hash alone does not remove those assumptions.

The timestamp cutoff uses the destination chain's consensus clock. Quote
authoring must bind it earlier than the input-side refund, with the configured
clock and settlement margin. The RPC adapter also rejects a stale chain clock
and enforces a minimum destination claim window in blocks. These checks do not
turn destination timestamps into a proof of another chain's state. The existing
HTLC permits claims after its timelock until a refund wins; both branches and
preimage disclosure races remain relevant during recovery.

## Reproducible artifact

`node scripts/build-receiver-artifact.mjs --check` verifies the checked-in artifact
against the exact source and pinned Solidity 0.8.30 compiler, optimization runs
200, and Shanghai target. `receiverCreation(binding)` constructs deployment bytes.
`expectedReceiverRuntimeHash(binding)` patches compiler immutable references
independently. Expected runtime hashes must never be copied from the target RPC.
The local tests compile the source again and execute the real swap and token
runtime fixtures on mandatory Anvil Cancun.
Keep this trusted artifact and signing policy available while operations created
with them remain outstanding. Replacing a deployed receiver's artifact requires
an explicit compatibility registry or draining those operations first.

## Deployment and observation

`createReceiverBackend` deploys through `createDurableEvmSender`; the deployment
address follows the persisted signer and nonce. A recipient is quotable only
when `deploy(...).verified` is true. The adapter checks the successful canonical
deployment receipt, trusted receiver runtime and every immutable getter, and
configured swap/token code hashes. Funding observations pin all reads to one
canonical block hash, then verify that header remains canonical. Confirmations,
age, and optionally the chain's finalized tag bound the chosen observation.

Use a dedicated execution EOA separate from accounts using legacy broadcasters.
Every operation sharing that EOA must use one SQL journal. Durable rows reserve
nonces permanently and store validated signed bytes before dispatch. Restart
and uncertain submission replay those exact bytes; unknown raw transactions or
changed request identities fail closed. `pendingTransactions()` exposes known
requests for startup recovery. Raw transactions are sensitive execution data
and must not be written to logs.

An unsubmitted prepared nonce blocks subsequent account work explicitly. Once
an abandoned activation's immutable on-chain cutoff has closed,
`resolveExpiredActivation` replays its original bytes; they consume the nonce
by reverting, or reconcile an earlier mined result. Do not replay an abandoned
activation before that cutoff simply to fill a nonce gap. Startup recovery must
resolve these rows before opening intake. A receiver's refund uses the existing
permissionless six-argument HTLC refund, returning funds to the fixed solver
address even when a dedicated account pays gas.
