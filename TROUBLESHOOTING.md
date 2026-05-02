# Troubleshooting: CrofAI Vision Requests Return Empty Response

## Discovered: 2026-04-30

### Symptoms
- Attaching an image to a Copilot Chat message causes a "generic error"
- The extension returns successfully but NO content is displayed
- Non-image (text-only) requests work fine

### Root Cause
**CrofAI kimi-k2.6 vision API bug**: when a **system message** is present in the request AND `stream: true`, the API returns `completion_tokens: 0` and immediately finishes with `finish_reason: "stop"` — no reasoning or answer is generated.

The extension's requests always include system messages (the Copilot system prompt), so every vision request triggers this bug.

### Curl Test Results

| System Msg | `stream` | Vision | Result |
|-----------|----------|--------|--------|
| No | `true` | Yes | ✅ Works (returns reasoning in chunks) |
| No | `false` | Yes | ✅ Works (returns reasoning in JSON) |
| Yes | `false` | Yes | ✅ Works (non-streaming avoids the bug) |
| **Yes** | **`true`** | **Yes** | **❌ FAILS — `completion_tokens: 0`, immediate stop** |

### Current Fix / Workaround (applied in code)
The extension now **detects vision requests** (by checking if any message has array content with `image_url`) and **disables streaming** (`stream: false`) for those requests. This works around the API bug because non-streaming vision requests with system messages succeed.

**Changed file:** `src/provider.ts`
- `provideLanguageModelChatResponse` checks `hasVisionContent` after `buildOpenAIMessages()`
- When vision is detected, `stream` is set to `false`
- Log messages are tagged with `[VISION]` so they're easy to identify

### Recommended Permanent Fix (CrofAI API side)
This is a server-side bug in the CrofAI API. The `chat/completions` endpoint with `kimi-k2.6` (and potentially other vision models) should correctly handle:
- System messages in streaming mode (`stream: true`) alongside vision content (`image_url`)
- The model should generate content (words/tokens) instead of returning 0 completion tokens

The client-side workaround (disabling streaming for vision) should be removed once the API is fixed.

### Additional Note: kimi-k2.6 Response Format Quirk
When `kimi-k2.6` processes a vision request (even in non-streaming mode), all output text is placed in the `reasoning_content` field, while the `content` field is set to empty string `""`. The extension handles this correctly by emitting `reasoning_content` as visible text, but it's worth noting this is non-standard behavior compared to most OpenAI-compatible models.

# CrofAI Compatibility Troubleshooting

## Latest Baseline (7s Timeout Policy)

Last updated: 2026-05-02

Test command:

```bash
bash ./tools/test_crof_matrix.sh
```

Per-request timeout policy used by the matrix script:
- connect timeout: 7s
- total request timeout: 7s
- if a request does not complete in 7s, it is marked as `TIMEOUT` and testing continues

### Latest Matrix Results

| Model | Reasoning Flag | Basic Non-Stream | Basic Stream | Tool Non-Stream | Tool Stream | Notes |
|---|---:|---:|---:|---:|---:|---|
| deepseek-v4-pro | true | 200 | 200 | 200 | 200 | OK |
| deepseek-v4-pro-precision | true | 200 | 200 | 200 | 200 | OK |
| deepseek-v4-flash | true | 200 | 200 | 200 | 200 | OK |
| deepseek-v3.2 | false | TIMEOUT | TIMEOUT | 200 | 200 | basic path exceeded 7s cutoff |
| glm-5.1 | true | 200 | 200 | 200 | 200 | OK |
| glm-5.1-precision | true | 200 | 200 | 200 | 200 | OK |
| kimi-k2.6 | true | 200 | 200 | 200 | 200 | OK |
| kimi-k2.6-precision | true | 200 | 200 | 200 | 200 | OK |

## How To Read These Results

- `200`: request finished successfully inside the timeout window.
- `TIMEOUT`: no result inside 7 seconds (not necessarily a permanent model failure).
- `SSE_ERR`: streaming request returned an SSE error event.

## Practical Guidance

- For fast health checks, this 7s matrix is intentionally strict and useful.
- A `TIMEOUT` in this matrix means "too slow for this strict probe", not automatically "broken model".
- If a model times out here but works in extension sessions, prefer increasing timeout for deeper validation rather than treating it as unavailable.

## Extension-Side Notes

- Vision requests are still forced to non-stream mode as a provider-side workaround for known streaming vision instability with system prompts.
- Retry behavior remains same-model only (no cross-model fallback).
