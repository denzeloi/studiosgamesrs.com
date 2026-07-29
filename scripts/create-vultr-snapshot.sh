#!/usr/bin/env bash
# Create a Vultr golden snapshot from a running CS2 server and update .env files.
# Usage:
#   ./scripts/create-vultr-snapshot.sh [instance-id]
# Requires VULTR_API_TOKEN in repo/functions/.env (or repo/functions/cs2-nexus/.env)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/functions/cs2-nexus/.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$ROOT/functions/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy from functions/.env.example first."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "${VULTR_API_TOKEN:-}" ]; then
  echo "VULTR_API_TOKEN not set in $ENV_FILE"
  exit 1
fi

INSTANCE_ID="${1:-}"
if [ -z "$INSTANCE_ID" ]; then
  echo "Finding cs2-nexus instances..."
  INSTANCE_ID=$(curl -s -4 -H "Authorization: Bearer ${VULTR_API_TOKEN}" \
    "https://api.vultr.com/v2/instances?tag=cs2-nexus" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); inst=d.get('instances') or []; print(inst[0]['id'] if inst else '')")
fi

if [ -z "$INSTANCE_ID" ]; then
  echo "No instance id. Pass one: $0 <instance-id>"
  exit 1
fi

DESC="cs2-nexus-golden-miami-$(date +%Y%m%d)"
echo "Creating snapshot for instance $INSTANCE_ID ($DESC)..."

RESP=$(curl -s -4 -X POST "https://api.vultr.com/v2/snapshots" \
  -H "Authorization: Bearer ${VULTR_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"instance_id\":\"${INSTANCE_ID}\",\"description\":\"${DESC}\"}")

SNAP_ID=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('snapshot') or {}; print(s.get('id',''))" 2>/dev/null || true)

if [ -z "$SNAP_ID" ]; then
  echo "Snapshot request failed:"
  echo "$RESP"
  exit 1
fi

echo "Snapshot started: $SNAP_ID (may take 10–30 min on Vultr)"
echo "Waiting for status=complete..."

for i in $(seq 1 60); do
  STATUS=$(curl -s -4 -H "Authorization: Bearer ${VULTR_API_TOKEN}" \
    "https://api.vultr.com/v2/snapshots/${SNAP_ID}" | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('snapshot') or {}).get('status',''))" 2>/dev/null || true)
  echo "  [$i/60] status=$STATUS"
  if [ "$STATUS" = "complete" ]; then
    break
  fi
  sleep 30
done

if [ "$STATUS" != "complete" ]; then
  echo "Snapshot not complete yet. When ready, set manually:"
  echo "  VULTR_SNAPSHOT_ID=$SNAP_ID"
  exit 0
fi

for f in "$ROOT/functions/.env" "$ROOT/functions/cs2-nexus/.env"; do
  if [ -f "$f" ]; then
    if grep -q '^VULTR_SNAPSHOT_ID=' "$f"; then
      sed -i "s/^VULTR_SNAPSHOT_ID=.*/VULTR_SNAPSHOT_ID=${SNAP_ID}/" "$f"
    else
      echo "VULTR_SNAPSHOT_ID=${SNAP_ID}" >> "$f"
    fi
    echo "Updated $f"
  fi
done

echo ""
echo "Done. VULTR_SNAPSHOT_ID=$SNAP_ID"
echo "Deploy functions: cd repo && npm run deploy:functions"
echo "Future provisions will boot in ~5–8 min (snapshot mode)."
