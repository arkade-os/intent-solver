# Offline receive with delegatee

Lightning and onchain receive already support a client that omits `claim_packet`.
The solver funds the agreed covenant and recovers the preimage from its claim witness.
That is also the path used by a delegatee claim; no solver-side delegatee URL is required.

Use the SDK swap client's `offlineReceive` configuration with a `RestDelegateeProvider`
and the operator-trusted `offline_receive` template ID. The client registers a durable
watch before returning payment instructions. Its encrypted payload binds the preimage
to the exact lockup program, quoted minimum payout, template and claim deadline.

The solver continues to learn the preimage only from a claim transaction. Delegatee
uses its indexer scan to recover funding that arrived during downtime. The older type-4
covclaimd packet and `COVCLAIMD_URL` reveal paths remain available for existing clients.
Do not send a delegatee secret envelope as a legacy `claim_packet`: the envelope goes
directly to delegatee's generic delegation API after the quote has been verified.
