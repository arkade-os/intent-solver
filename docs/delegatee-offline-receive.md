# Offline receive with delegatee

Lightning and onchain receive transport the encrypted preimage in the funding transaction.
Neither the receiving client nor the solver calls delegatee to register a claim. The receiving
application configures the trusted encryption public key and `offline_receive` template ID.

The receiving application needs [ts-sdk#1090](https://github.com/arkade-os/ts-sdk/pull/1090),
stacked on [ts-sdk#972](https://github.com/arkade-os/ts-sdk/pull/972), and the deployment needs
[delegatee#5](https://github.com/arkade-os/delegatee/pull/5). The client APIs are not included
in the SDK/swap versions pinned by this solver repository. Deploy the trusted template and
solver packet support before enabling the receiving application's option. The template is
[`templates/offline_receive.json`](https://github.com/arkade-os/delegatee/blob/feat/delegatee-offline-receive/templates/offline_receive.json),
loaded as an operator-trusted default by delegatee; clients pin its content ID.

1. The SDK seals a `delegatee-secrets/v1` envelope containing the preimage, receiver program
   and minimum payout, authenticated to the chosen template ID. `receive()` pins the payout;
   direct `quote()` calls require `amountOn: "take"`.
2. The RFQ carries the opaque bytes in `profile.claim_packet`. The extension packet type is
   `0x04`, shared with covclaimd. Its body begins with
   TLV `0x7f` containing the UTF-8 marker `delegatee-secrets/v1`, followed by ciphertext in
   TLV `0x01` and the compressed encryption key in TLV `0x03`.
3. The solver appends its own covenant script as TLV `0x02`, then stamps the packet and full
   taptree into the funding transaction. It does not decrypt the envelope.
4. Delegatee's default transaction stream template matches the marker and encryption key,
   validates the covenant and authenticated payout constraints, and persists a claim watch.
   The solver learns the preimage from the claim witness and settles the external leg.

An adopted funding output does not cause a delegatee envelope to fall back to the legacy
covclaimd Reveal API. If funding carried no discoverable packet, this path cannot repair it
through a registration call. Existing covclaimd ciphertext and packet behavior is unchanged.

The envelope authenticates the payment intent, not the exact later-quoted tree or refund
deadline. It prevents revealing the preimage for a payout below the requested minimum or
to a different receiver. The receiver can go offline after `receive()` has persisted its state.

Delegatee must observe the funding packet while connected: the current transaction stream
has no replay cursor. Once a child watch is persisted, indexer scans and pending-transaction
reconciliation survive restarts. A funding packet received entirely during daemon downtime
is not discoverable through that existing stream.
