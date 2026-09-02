#!/usr/bin/env bash
# End-to-end test of the PURELY OUTBOUND transport, against a live regtest stack.
#
# Proves the whole outbound flow with the provider opening NO listening ports:
#   mock relay  ⇄  provider (`cli relay`)      — provider is outbound-only
#   mock relay  ⇄  client   (send-client-relay) — client is outbound-only
#
#   1. client publishes an rfq_request to the relay (RFQ v1, docs/rfq-protocol.md)
#   2. provider (subscribed outbound) quotes it, publishes the quote back
#   3. client derives the script locally, verifies the address, funds its own
#      derivation from ITS OWN wallet
#   4. provider's watch loop (running alongside the relay ingress) pays the
#      invoice and claims the lockup
#   5. client sees the lockup spent on-chain → swap complete
#
# Prerequisites (see docs/runbook.md § "Replicating end to end on regtest"):
#   - the arkade-regtest stack up (arkd :7070, emulator :7073, esplora :3000)
#   - pnpm build has run
#   - two funded wallets: .env.regtest (provider) and .env.regtest.client (client),
#     each funded via scripts/regtest-fund.mjs
#
# Usage: scripts/e2e-relay.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RELAY_URL=${RELAY_URL:-ws://localhost:7447}
# The mock relay speaks the dev broker framing, not Nostr.
export RELAY_PROTOCOL=${RELAY_PROTOCOL:-dev}
NODE="node --enable-source-maps --experimental-eventsource"
LOGDIR=$(mktemp -d)
relay_pid="" provider_pid=""

cleanup() {
  [ -n "$provider_pid" ] && kill "$provider_pid" 2>/dev/null || true
  [ -n "$relay_pid" ] && kill "$relay_pid" 2>/dev/null || true
}
trap cleanup EXIT

# The mock exists so this runs with no relay at all. Point RELAY_URL at a real
# one and it is skipped — arkade-regtest's `nostr` profile publishes strfry on
# ws://localhost:7777, which is what proves this flow against a real Nostr relay
# rather than only against the dev broker framing:
#
#   RELAY_URL=ws://localhost:7777 RELAY_PROTOCOL=nostr scripts/e2e-relay.sh
#
# Set explicitly rather than inferred from the URL: guessing which relay is
# "the mock" from a port number is the kind of cleverness that silently starts
# a second relay nobody asked for.
if [ -n "${SKIP_MOCK_RELAY:-}" ]; then
  echo "── using the relay at $RELAY_URL (mock not started) ─────────────────"
else
  echo "── starting mock relay ──────────────────────────────────────────────"
  node scripts/mock-relay.mjs >"$LOGDIR/relay.log" 2>&1 &
  relay_pid=$!
  sleep 1
fi

echo "── starting provider in OUTBOUND relay mode (no listening ports) ────"
RELAY_URL="$RELAY_URL" $NODE --env-file=.env.regtest packages/solver-app/dist/cli.js relay >"$LOGDIR/provider.log" 2>&1 &
provider_pid=$!

# Wait for the provider to be subscribed and print its pubkey.
for _ in $(seq 1 40); do
  grep -q "watching" "$LOGDIR/provider.log" && break
  sleep 1
done
provider_pubkey=$(grep -oE "as [0-9a-f]{64}" "$LOGDIR/provider.log" | head -1 | cut -d' ' -f2)
[ -n "$provider_pubkey" ] || { echo "provider never came up:"; cat "$LOGDIR/provider.log"; exit 1; }
echo "provider pubkey: $provider_pubkey"

echo "── forging an invoice (provider's fake LN) ──────────────────────────"
invoice=$($NODE --env-file=.env.regtest packages/solver-app/dist/cli.js invoice 1000 2>/dev/null | tail -1)

echo "── client requests over the relay, funds, waits for the claim ───────"
if $NODE --env-file=.env.regtest.client examples/send-client-relay.mjs \
     "$RELAY_URL" "$provider_pubkey" "$invoice" 2>&1 | grep -vE "EventSource|trace-warnings" | tee "$LOGDIR/client.log" \
     | grep -q "Swap complete."; then
  echo "── PASS: outbound swap completed end to end ─────────────────────────"
  exit 0
else
  echo "── FAIL ─────────────────────────────────────────────────────────────"
  echo "provider log:"; grep -vE "EventSource|trace-warnings" "$LOGDIR/provider.log" | tail -10
  exit 1
fi
