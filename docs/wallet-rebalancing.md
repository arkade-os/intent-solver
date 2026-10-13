# Wallet rebalancing

The admin console's **Wallet** page can replenish configured backend pools
from surplus Arkade funds. Manual transfers and automatic refills share the
same policy checks and durable transfer journal. A transfer completes when its
destination proves spendable credit of at least the quoted minimum.

The configured rail must provide a rebalance capability. LND exposes separate
**Onchain wallet** (`rail:onchain`) and **Lightning channels**
(`rail:lightning`) pools. A backend with overlapping onchain and Lightning
balances can expose one shared pool; configure one target for that pool.
Unsupported deployments show rebalancing as unavailable.

## Prepare and send a manual transfer

1. In **automatic policy**, configure the reserve, debit limits, fee limits and
   minimum transfer size described below. Automation may remain unchecked;
   these limits also govern manual transfers. Leave both trigger and target
   blank for pools you do not want to refill automatically. Type `REBALANCE` and select
   **save confirmed policy**.
2. Select a **destination pool**, a **deposit route**, and **minimum credit
   (sat)**. The automatic route choice compares the bounded costs of routes
   offered by that pool. Selecting a specific route restricts the quote to it.
3. Select **prepare quote**. Review its ID, minimum credit, fee upper bound,
   source debit, route and expiry. The source debit is the authorized maximum;
   actual costs or credited funds can differ within those bounds.
4. Type the quote ID into **type quote ID to send**, then select
   **send confirmed quote**. Follow its state in **transfer history** and use
   **refresh rebalancing** to update the display.

All amounts are whole satoshis. The backend creates the receive address or
fixed-amount plain Lightning invoice; the browser cannot supply a replacement
destination. Quotes expire within 60 seconds, or earlier if the route or invoice
expires. A policy change invalidates an earlier quote: prepare a new preview.
An unsubmitted quote can be cancelled from transfer history.

Submission retries for the same transfer do not create another source spend.
After a timeout, inspect the existing transfer before preparing another one.
The journal permits only one active transfer across the source wallet, whether
the request was manual or automatic.

## Configure automatic refills

Automatic rebalancing starts disabled on a new installation or an upgrade with
no saved policy. Monetary defaults are all zero; transfers require explicit
configuration. The default cooldown is 300 seconds.

| UI field                         | Policy field                  | Meaning                                                                                               |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Arkade reserve (sat)             | `reserveSats`                 | Arkade funds retained in addition to outstanding payout obligations and other inventory reservations. |
| Maximum debit per transfer (sat) | `maxDebitSats`                | Maximum authorized source debit, including fees. Must be positive for automation.                     |
| Maximum debit per 24 hours (sat) | `dailyDebitSats`              | Source debit allowance over a rolling 24-hour window. Must be positive for automation.                |
| Maximum fees (sat)               | `maxFeeSats`                  | Upper bound on total source, route and receiving costs.                                               |
| Maximum fees (basis points)      | `maxFeeBps`                   | Fee limit relative to minimum credited sats; 100 basis points is 1%. Must be between 0 and 10,000.    |
| Minimum transfer (sat)           | `minTransferSats`             | Smallest permitted minimum credit. Must be positive for automation.                                   |
| Cooldown (seconds)               | `cooldownSeconds`             | Delay between automatic attempts, including attempts whose quote fails.                               |
| Minimum trigger (sat)            | `targets[poolId].minimumSats` | Refill only when fresh spendable balance is below this threshold. Zero never triggers automatically.  |
| Refill target (sat)              | `targets[poolId].targetSats`  | Desired spendable pool balance; must exceed the minimum trigger.                                      |

Both fee limits apply, including to manual transfers. Setting either fee limit
to zero permits only transfers with no quoted fees. All policy values must be
nonnegative safe integers; zero is permitted for the reserve and cooldown.

Choose values for your deployment, enable **automatic rebalancing**, type
`REBALANCE`, and save. Policy changes are stored in the `REBALANCE_POLICY`
settings override and applied to the running service without a restart.
To stop new automatic jobs, uncheck automation and save; existing transfers
continue reconciliation and recovery.

The service evaluates approximately every 60 seconds. It reads balances directly
from the backend and skips unreadable or invalid readings. Among eligible
positive thresholds, the lowest `balance / minimum` is considered first.
The target is a refill goal: source surplus, fees and remaining debit allowance
may require a smaller transfer. Amounts below the configured minimum are skipped.
The panel's **Last automatic evaluation** explains why an attempt was skipped
or refused.

## Lightning counterparty

A Lightning refill requires an external solver offering the Arkade-to-Lightning
corridor. Configure its 64-character hexadecimal **external solver public key**
and websocket **relay URLs**, one per line. The service uses Nostr RFQ transport;
it does not discover or choose a counterparty automatically. Leave both fields
empty if only onchain deposits are needed.

Use another solver identity and a separate wallet with sufficient Lightning
liquidity. The local solver identity is rejected: paying its own deposit invoice
through its own corridor cannot replenish its liquidity. The destination also
needs enough receiving capacity. The service checks the invoice network, amount,
payment hash, expiry and external quote before funding the verified Arkade
lockup. An unavailable counterparty prevents the Lightning route from quoting.

## Track and recover transfers

| State                  | Operator meaning                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `quoted`               | Persisted preview; no source submission yet. Can be cancelled.                      |
| `submitting`           | Inputs and maximum debit are claimed before the source call.                        |
| `pending`              | Source funding is recorded; destination confirmation or settlement is still needed. |
| `needs_reconciliation` | Submission outcome is uncertain. The transfer blocks another source spend.          |
| `completed`            | The destination proves credit of at least the promised minimum.                     |
| `refunded`             | Returned source funds have been observed.                                           |
| `failed`               | Definitive failure before spending; no source debit remains charged.                |
| `cancelled`            | An unsubmitted quote was cancelled.                                                 |

LND onchain deposits require the particular destination output to have at least
one confirmation. Lightning receipt is proved by settlement of the destination's
own invoice. Other backends may require confirmations, maturity or a deposit
claim before funds become spendable. A remote status or an unrelated balance
increase alone is insufficient receipt evidence.

The maximum debit is charged when submission begins. Pending, uncertain,
completed and refunded transfers retain that charge for the rolling window;
a refund does not reset the daily allowance. Attempt cooldown and charges
survive restart. A restart during `submitting` moves the transfer to
`needs_reconciliation` and restores its source hold rather than replaying it.

Ambiguous submissions can require operator investigation. A timeout or elapsed
refund deadline does not clear an uncertain hold. Destination failure does not
itself prove a source refund. Some refund recovery remains shown as `pending`
until returned funds are proved; inspect the recorded error and history.

Keep one solver process per source wallet. Back up the deployment's swap and
admin databases together: transfers and route recovery data live in the swap
database; policy lives in the admin settings database. Disable automation before
an operational rollback, and keep a journal-aware version running until active
transfers resolve. Do not delete recovery records to clear a blocked transfer.

This feature does not open or splice channels, rebalance tokens, send to arbitrary
destinations, or automatically move backend funds back into Arkade. Route and
counterparty availability must be verified for the deployment; unit tests do
not establish live liquidity or successful fund movement.
