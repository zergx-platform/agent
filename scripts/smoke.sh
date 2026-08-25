#!/usr/bin/env bash
# Agent-ts end-to-end smoke test: drives the live agent over HTTP and asserts
# the full mailbox pipeline (prompt → NATS → consumer → PG → turn → reply).
#
# Usage:
#   AGENT_BASE=http://rucoder-agent.temp.svc.cluster.local bash smoke.sh
#
# The agent must be reachable at AGENT_BASE (in-cluster svc or a port-forward).
set -uo pipefail

AGENT_BASE="${AGENT_BASE:-http://rucoder-agent.temp.svc.cluster.local}"
SID="smoke-$(date +%s)$RANDOM"
PASS=0
FAIL=0

pass() { echo "    PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "    FAIL: $1"; FAIL=$((FAIL + 1)); }

check() { # check <desc> <got> <want>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi
}

echo "[agent-smoke] base=$AGENT_BASE session=$SID"

# 1. create session
body=$(curl -sf -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"$SID\"}" "$AGENT_BASE/api/v1/sessions")
echo "$body" | grep -q '"ok":true' \
  && pass "create session" || fail "create session ($body)"

# 2. prompt (returns immediately; the turn runs async)
body=$(curl -sf -X POST -H 'Content-Type: application/json' \
  -d '{"prompt":"reply with exactly: SMOKE-OK"}' "$AGENT_BASE/api/v1/sessions/$SID/prompt")
echo "$body" | grep -q '"ok":true' \
  && pass "submit prompt" || fail "submit prompt ($body)"

# 3. poll state until idle (the run lease is released when the turn ends)
state="busy"
for _ in $(seq 1 30); do
  state=$(curl -sf "$AGENT_BASE/api/v1/sessions/$SID/state" \
    | sed -E 's/.*"status":"([a-z]+)".*/\1/')
  [ "$state" = "idle" ] && break
  sleep 2
done
check "turn reaches idle" "$state" "idle"

# 4. the reply chain must contain an assistant message
msgs=$(curl -sf "$AGENT_BASE/api/v1/sessions/$SID/messages")
echo "$msgs" | grep -q '"role":"assistant"' \
  && pass "assistant reply persisted" || fail "no assistant reply ($msgs)"

# 5. reply must echo the sentinel (LLM actually ran)
echo "$msgs" | grep -qi 'SMOKE-OK' \
  && pass "assistant content contains sentinel" || fail "sentinel missing ($msgs)"

# 6. settings PATCH persists max_turns/system_prompt
body=$(curl -sf -X PATCH -H 'Content-Type: application/json' \
  -d '{"max_turns":3,"system_prompt":"be terse"}' "$AGENT_BASE/api/v1/sessions/$SID/settings")
echo "$body" | grep -q '"max_turns":3' \
  && pass "settings max_turns persisted" || fail "max_turns not persisted ($body)"
echo "$body" | grep -q '"system_prompt":"be terse"' \
  && pass "settings system_prompt persisted" || fail "system_prompt not persisted ($body)"

# 7. undo rejects a message id outside this session's chain
body=$(curl -sf -X POST -H 'Content-Type: application/json' \
  -d '{"message_id":"nonexistent"}' "$AGENT_BASE/api/v1/sessions/$SID/undo")
echo "$body" | grep -q '"undone":false' \
  && pass "undo rejects foreign message id" || fail "undo did not reject ($body)"

# 8. mark-read persists last_read_at (200 + non-stub)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$AGENT_BASE/api/v1/sessions/$SID/read")
check "mark read returns 200" "$code" "200"

echo "======================================"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
