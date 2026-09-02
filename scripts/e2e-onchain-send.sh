#!/usr/bin/env bash
# End-to-end test of arkade:BTC->onchain:BTC (send), against a live regtest
# stack with a real LND onchain wallet (boltz-lnd).
#
# Unlike scripts/e2e-relay.sh (which proves the RELAY TRANSPORT with two
# separate processes), this proves the MONEY PATH: `cli send-onchain` plays
# both the solver and the client role in one process, the same scope
# `cli send` already covers for the Lightning leg. It does not exercise RFQ
# negotiation over HTTP or relay for this pair — there is no onchain
# equivalent of examples/send-client-relay.mjs yet; that is a separate,
# not-yet-built reference client, same status as the receive leg.
#
#   1. quote arkade:BTC->onchain:BTC for the requested amount
#   2. fund the Arkade lockup from the provider's own wallet (the "client" role)
#   3. the solver observes it, funds the onchain HTLC via boltz-lnd's onchain wallet
#   4. the "client" role signs and broadcasts the claim transaction with an
#      ephemeral keypair generated for the self-test
#   5. the solver observes the claim, reveals P, claims the Arkade lockup
#
# Prerequisites (see docs/runbook.md § "Replicating end to end on regtest,
# onchain leg"):
#   - the arkade-regtest stack up WITH the boltz profile (arkd :7070,
#     emulator :7073, boltz-lnd, bitcoin, miner, esplora :3000)
#   - .env.regtest.lnd filled in (ARK_MNEMONIC, LND_SOCKET, LND_CERT_PATH /
#     LND_MACAROON_PATH pointing at the extracted boltz-lnd cert/macaroon)
#   - the provider's Arkade wallet funded (scripts/regtest-fund.mjs)
#   - pnpm build has run
#
# Usage: scripts/e2e-onchain-send.sh [sats]
set -euo pipefail
cd "$(dirname "$0")/.."

AMOUNT_SATS=${1:-50000}
NODE="node --enable-source-maps --experimental-eventsource"
LOGDIR=$(mktemp -d)

echo "── sanity-checking the LND connection ────────────────────────────────"
if ! $NODE --env-file=.env.regtest.lnd dist/cli.js balances >"$LOGDIR/balances.log" 2>&1; then
  echo "── FAIL: could not reach boltz-lnd or the Arkade wallet ──────────────"
  cat "$LOGDIR/balances.log"
  exit 1
fi
cat "$LOGDIR/balances.log"

echo "── running the onchain-send self-test (${AMOUNT_SATS} sats) ──────────"
if $NODE --env-file=.env.regtest.lnd dist/cli.js send-onchain "$AMOUNT_SATS" \
     2>&1 | tee "$LOGDIR/send-onchain.log" | grep -q '"state":"claimed"'; then
  echo "── PASS: onchain send completed end to end ────────────────────────────"
  exit 0
else
  echo "── FAIL ─────────────────────────────────────────────────────────────"
  cat "$LOGDIR/send-onchain.log"
  exit 1
fi
