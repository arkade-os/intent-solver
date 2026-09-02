#!/usr/bin/env bash
# End-to-end test that a RECEIVE rfq_request reaches its corridor over a relay.
#
#   real Nostr relay  ⇄  provider (`cli relay`)          — provider is outbound-only
#   real Nostr relay  ⇄  client   (receive-quote-relay)  — client is outbound-only
#
#   1. client generates P, keeps it, seals it to covclaimd, publishes an
#      rfq_request for lightning:BTC->arkade:BTC carrying only H = sha256(P)
#   2. provider's relay ingress routes it to the Lightning-receive corridor
#   3. provider mints a hold invoice on H, derives the lockup, quotes back
#   4. client reads a real quote off the relay
#
# QUOTE ONLY, deliberately. Everything after the quote — paying the hold
# invoice, funding the lockup, claiming with P — is covered by
# test/e2e/receiveLightning*.e2e.test.ts, which drives the orchestrator
# directly. The one thing those cannot cover is the leg this covers: the
# ingress arm that carries a receive request in off the wire.
#
# A REAL relay, not scripts/mock-relay.mjs. The mock speaks its own broker
# framing, and both halves speaking it is exactly how a Nostr interop bug hid
# here before: the flow passed while being unable to talk to any real relay.
# arkade-regtest's `nostr` profile publishes strfry on ws://localhost:7777.
#
# Prerequisites (see docs/runbook.md § "Replicating end to end on regtest"):
#   - the arkade-regtest stack up WITH its `nostr` profile (strfry :7777),
#     plus arkd :7070 and covclaimd :7271
#   - pnpm build has run
#   - two wallets: .env.regtest (provider) and .env.regtest.client (client).
#     The provider needs no balance here — quoting spends nothing.
#
# Usage: scripts/e2e-relay-receive.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RELAY_URL=${RELAY_URL:-ws://localhost:7777}
AMOUNT_SATS=${AMOUNT_SATS:-5000}
# The default provider env runs LN_BACKEND=fake, whose hold-invoice half is a
# full LightningBackend implementation — so this needs no LND. Point ENV_FILE
# at .env.regtest.lnd to drive the same leg against a real one.
ENV_FILE=${ENV_FILE:-.env.regtest}
export RELAY_PROTOCOL=nostr
NODE="node --enable-source-maps --experimental-eventsource"
LOGDIR=$(mktemp -d)
provider_pid=""

cleanup() {
  [ -n "$provider_pid" ] && kill "$provider_pid" 2>/dev/null || true
}
trap cleanup EXIT

echo "── starting provider in OUTBOUND relay mode (no listening ports) ────"
RELAY_URL="$RELAY_URL" $NODE --env-file="$ENV_FILE" packages/solver-app/dist/cli.js relay >"$LOGDIR/provider.log" 2>&1 &
provider_pid=$!

for _ in $(seq 1 40); do
  grep -q "watching" "$LOGDIR/provider.log" && break
  sleep 1
done
provider_pubkey=$(grep -oE "as [0-9a-f]{64}" "$LOGDIR/provider.log" | head -1 | cut -d' ' -f2)
[ -n "$provider_pubkey" ] || { echo "provider never came up:"; cat "$LOGDIR/provider.log"; exit 1; }
echo "provider pubkey: $provider_pubkey"

echo "── client asks for a receive quote over the relay ───────────────────"
if $NODE --env-file=.env.regtest.client examples/receive-quote-relay.mjs \
     "$RELAY_URL" "$provider_pubkey" "$AMOUNT_SATS" 2>&1 | grep -vE "EventSource|trace-warnings" | tee "$LOGDIR/client.log" \
     | grep -q "Receive quote received over a real Nostr relay."; then
  echo "── PASS: receive RFQ round-tripped a real relay ─────────────────────"
  exit 0
else
  echo "── FAIL ─────────────────────────────────────────────────────────────"
  echo "provider log:"; grep -vE "EventSource|trace-warnings" "$LOGDIR/provider.log" | tail -10
  exit 1
fi
