#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./tools/test_crof_matrix.sh
#
# Reads API key from: CROF_API_KEY, CROFAI_API_KEY, or API_KEY.
# If none is set, tries loading src/.env.

if [[ -f "src/.env" ]]; then
	set -a
	source src/.env >/dev/null 2>&1 || true
	set +a
fi

API_KEY="${CROF_API_KEY:-${CROFAI_API_KEY:-${API_KEY:-}}}"
if [[ -z "${API_KEY}" ]]; then
	echo "ERROR: Missing API key. Set CROF_API_KEY/CROFAI_API_KEY/API_KEY or put one in src/.env"
	exit 2
fi

MODELS_JSON="/tmp/crof_models_matrix.json"
curl -sS \
	-H "Authorization: Bearer ${API_KEY}" \
	"https://crof.ai/v1/models" > "${MODELS_JSON}"

python3 - <<'PY'
import json
import subprocess
import os

api_key = os.environ.get('CROF_API_KEY') or os.environ.get('CROFAI_API_KEY') or os.environ.get('API_KEY')
models = json.load(open('/tmp/crof_models_matrix.json')).get('data', [])

target = []
for m in models:
    mid = m.get('id', '')
    if mid.startswith('deepseek') or mid.startswith('kimi') or mid.startswith('glm-'):
        target.append({
            'id': mid,
            'reasoning': bool(m.get('custom_reasoning') or m.get('reasoning_effort')),
        })

def call_api(payload):
    proc = subprocess.run([
        'curl', '-sS',
        '--connect-timeout', '7',
        '--max-time', '7',
        '-o', '/tmp/crof_matrix_resp.json',
        '-w', '%{http_code}',
        '-H', f'Authorization: Bearer {api_key}',
        '-H', 'Content-Type: application/json',
        'https://crof.ai/v1/chat/completions',
        '--data', json.dumps(payload),
    ], capture_output=True, text=True)

    if proc.returncode != 0:
        if proc.returncode == 28:
            return 'TIMEOUT', 'curl timeout after 7s'
        return 'CURL_ERR', f'curl exit {proc.returncode}'

    status = proc.stdout.strip()[-3:]
    try:
        body = open('/tmp/crof_matrix_resp.json', 'r', encoding='utf-8', errors='ignore').read(260).replace('\n', ' ')
    except Exception as exc:
        body = f'read_err={exc}'

    return status, body

def mk_basic_payload(model_id, stream, reasoning):
    payload = {
        'model': model_id,
        'stream': stream,
        'messages': [
            {'role': 'user', 'content': 'Reply with exactly: OK'}
        ],
        'max_tokens': 64,
        'temperature': 0,
    }
    if reasoning:
        payload['reasoning_effort'] = 'none'
    return payload

def mk_tool_payload(model_id, stream, reasoning):
    payload = {
        'model': model_id,
        'stream': stream,
        'messages': [
            {'role': 'user', 'content': 'Call function get_time with timezone UTC. Do not answer without calling it.'}
        ],
        'max_tokens': 128,
        'temperature': 0,
        'tools': [
            {
                'type': 'function',
                'function': {
                    'name': 'get_time',
                    'description': 'Get current time in a timezone',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'timezone': {'type': 'string'}
                        },
                        'required': ['timezone']
                    }
                }
            }
        ],
        'tool_choice': 'auto',
    }
    if reasoning:
        payload['reasoning_effort'] = 'none'
    return payload

def classify_stream(status, body_head):
    if status != '200':
        return status
    lowered = body_head.lower()
    if 'event: error' in lowered or '"type": "internal_error"' in lowered or '"code": 500' in lowered:
        return 'SSE_ERR'
    return status

print('model\treasoning\tbasic_nonstream\tbasic_stream\ttool_nonstream\ttool_stream\tnote')
for m in target:
    mid = m['id']
    reasoning = m['reasoning']

    bns_status, bns_body = call_api(mk_basic_payload(mid, False, reasoning))
    bs_status, bs_body = call_api(mk_basic_payload(mid, True, reasoning))
    bs_status = classify_stream(bs_status, bs_body)
    tns_status, tns_body = call_api(mk_tool_payload(mid, False, reasoning))
    ts_status, ts_body = call_api(mk_tool_payload(mid, True, reasoning))
    ts_status = classify_stream(ts_status, ts_body)

    note = ''
    if bns_status != '200' or bs_status != '200':
        note = 'basic_fail'
    elif tns_status != '200' or ts_status != '200':
        note = 'tool_fail'

    sample = bns_body if bns_status != '200' else (tns_body if tns_status != '200' else '')
    sample = sample.replace('\t', ' ')[:120]
    if sample:
        note = (note + ' ' + sample).strip()

    print(f"{mid}\t{str(reasoning).lower()}\t{bns_status}\t{bs_status}\t{tns_status}\t{ts_status}\t{note}")
PY
