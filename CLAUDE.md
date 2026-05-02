# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript → out/
npm run watch        # Watch mode compilation
npm run lint         # ESLint
npm run format       # Prettier
npm run package      # Build .vsix package
```

No automated tests — `npm run test` requires a running VS Code instance via `vscode-test`.

To test manually: `npm run package`, then install `crof-ai-provider.vsix` via "Extensions: Install from VSIX".

## Architecture

VS Code extension that registers CrofAI as a `languageModelChatProvider` (vendor: `"crofai"`) for GitHub Copilot Chat. Uses the proposed `languageModelThinkingPart` API.

**Data flow:**
1. `extension.ts` — activates, wires together services, registers commands and the provider
2. `models.ts` — `CrofAIModelsService` fetches available models from `https://crof.ai/v1/models`, validates with Zod, and maps them to `LanguageModelChatInformation[]` for VS Code
3. `provider.ts` — `CrofAIChatModelProvider` handles chat requests: converts VS Code message parts to OpenAI-format messages, streams SSE responses from `https://crof.ai/v1/chat/completions`, and reports `LanguageModelTextPart` / `LanguageModelThinkingPart` / `LanguageModelToolCallPart` back via `progress.report()`
4. `config.ts` — per-model temperature stored in VS Code global settings (`crofai.modelTemperatures`)
5. `usage.ts` — polls `https://crof.ai/usage_api/` every 5 min for credits/requests, shown in status bar
6. `types.ts` — Zod schemas + TS types for API responses

**Reasoning effort** is encoded in model IDs as suffixes (`#low`, `#medium`, `#high`). `getEffortFromModelId()` in `models.ts` strips the suffix before sending to the API and passes `reasoning_effort` in the request body. Models with `custom_reasoning: true` or `reasoning_effort: true` in the API response get all four variants registered (none/low/medium/high).

**Vision support** is determined by model ID containing `kimi`, `gemma`, or `qwen`. Images are uploaded to [Litterbox](https://litterbox.catbox.moe) (free, anonymous, 1-hour expiry) via `imageServer.ts` — a `RemoteImageServer` class that POSTs `multipart/form-data` to `https://litterbox.catbox.moe/resources/internals/api.php`. The upload happens inside the retry loop in `provider.ts`, so failures are caught and retried. SHA-256 dedup prevents re-uploading identical images.

**API key** stored in VS Code `SecretStorage` under key `crofai.apiKey`.

## Style

- Tabs for indentation (enforced by `@stylistic/eslint-plugin`)
- Single quotes
- Strict TypeScript (`noImplicitAny`, `strictNullChecks`)
- Module imports use `.js` extensions (NodeNext module resolution)
