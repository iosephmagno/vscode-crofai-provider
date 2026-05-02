#!/usr/bin/env bash
set -euo pipefail

# Usage:
# CROFAI_API_KEY=... ./tools/debug_deepseek_ab.sh [model] [large_payload_json]
#
# Example:
# CROFAI_API_KEY=sk-xxx ./tools/debug_deepseek_ab.sh deepseek-v4-flash /tmp/large_payload.json

MODEL="${1:-deepseek-v4-flash}"
LARGE_PAYLOAD_PATH="${2:-}"
BASE_URL="https://crof.ai/v1/chat/completions"

if [[ -z "${CROFAI_API_KEY:-}" ]]; then
  echo "ERROR: CROFAI_API_KEY is not set"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SMALL_STREAM_PAYLOAD="$TMP_DIR/small_stream.json"
SMALL_NON_STREAM_PAYLOAD="$TMP_DIR/small_non_stream.json"

cat > "$SMALL_STREAM_PAYLOAD" <<EOF
{
  "model": "$MODEL",
  "stream": true,
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Reply with exactly: OK"}
  ],
  "max_tokens": 64
}
EOF

cat > "$SMALL_NON_STREAM_PAYLOAD" <<EOF
{
  "model": "$MODEL",
  "stream": false,
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Reply with exactly: OK"}
  ],
  "max_tokens": 64
}
EOF

run_case() {
  local name="$1"
  local payload_path="$2"

  local headers_out="$TMP_DIR/${name}.headers.txt"
  local body_out="$TMP_DIR/${name}.body.txt"

  echo "==== $name ===="
  curl -sS -N \
    -D "$headers_out" \
    -o "$body_out" \
    -X POST "$BASE_URL" \
    -H "Authorization: Bearer $CROFAI_API_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$payload_path"

  local status
  status="$(awk 'NR==1 {print $2}' "$headers_out")"
  local ctype
  ctype="$(awk -F': ' 'tolower($1)=="content-type" {print $2}' "$headers_out" | tr -d '\r' | head -n1)"
  local bytes
  bytes="$(wc -c < "$body_out" | tr -d ' ')"

  echo "status=$status content-type=${ctype:-unknown} body-bytes=$bytes"
  echo "body-preview:"
  head -c 600 "$body_out" | cat
  echo
  echo
}

run_case "small_stream_true" "$SMALL_STREAM_PAYLOAD"
run_case "small_stream_false" "$SMALL_NON_STREAM_PAYLOAD"

if [[ -n "$LARGE_PAYLOAD_PATH" ]]; then
  if [[ ! -f "$LARGE_PAYLOAD_PATH" ]]; then
    echo "ERROR: large payload file not found: $LARGE_PAYLOAD_PATH"
    exit 1
  fi

  LARGE_STREAM_PAYLOAD="$TMP_DIR/large_stream.json"
  LARGE_NON_STREAM_PAYLOAD="$TMP_DIR/large_non_stream.json"

  sed 's/"stream"[[:space:]]*:[[:space:]]*false/"stream": true/g' "$LARGE_PAYLOAD_PATH" > "$LARGE_STREAM_PAYLOAD"
  sed 's/"stream"[[:space:]]*:[[:space:]]*true/"stream": false/g' "$LARGE_PAYLOAD_PATH" > "$LARGE_NON_STREAM_PAYLOAD"

  run_case "large_stream_true" "$LARGE_STREAM_PAYLOAD"
  run_case "large_stream_false" "$LARGE_NON_STREAM_PAYLOAD"
else
  echo "No large payload path provided; skipped large payload A/B cases."
fi
