# Changelog

## 1.0.1

### Fixed

- Context window display no longer doubles `maxInputTokens + maxOutputTokens` in the model picker — now shows the correct context length from the API
- Vision support correctly detected from the API `vision` field instead of only matching model ID patterns
- Reasoning effort configuration validates input before casting to `ReasoningEffort` type
- Streaming requests have a 60-second timeout to prevent hanging connections
- Invalid JSON chunks during SSE streaming are logged as warnings instead of silently skipped

### Improved

- Model list is cached for 5 minutes with automatic TTL expiry
- Model fetching retries up to 2 times with exponential backoff (auth errors are not retried)
- Model cache is invalidated when the API key changes (including from other VS Code windows)
- `max_completion_tokens` is stored separately and sent correctly to the API while `maxOutputTokens` is set to `0` in the model info to prevent VS Code from summing both values in the UI
