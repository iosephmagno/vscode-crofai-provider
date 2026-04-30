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
