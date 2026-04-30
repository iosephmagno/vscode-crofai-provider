# CrofAI Provider for GitHub Copilot

> **Community extension** — not affiliated with or officially supported by CrofAI.

**Powerful models. Crazy cheap pricing.** — directly inside GitHub Copilot Chat.

CrofAI gives you access to the best open-weight models at the cheapest prices on the market. This extension wires them into VS Code's native model picker so you can use them anywhere GitHub Copilot Chat works — chat, agent mode, and more.

---

## Quick Start

**1. Get your API key**

Sign up at [crof.ai](https://crof.ai/dashboard) and copy your API key from the dashboard.

Free models are available with no credit card required.

**2. Set your API key in VS Code**

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
CrofAI: Manage CrofAI Provider
```

Paste your API key and press Enter. The key is stored securely using VS Code's built-in secret storage — never in plain text.

**3. Pick a model in Copilot Chat**

Open Copilot Chat (`Cmd+Shift+I` / `Ctrl+Shift+I`), click the model picker, and select any **CrofAI** model from the list.

**4. Start chatting**

That's it. Ask questions, get code completions, use agent mode — everything works through GitHub Copilot Chat's standard interface.

---

## Install And Configuration

After installing or updating the extension, run this checklist:

1. Run `Developer: Reload Window`
2. Open Command Palette and run: `CrofAI: Manage CrofAI Provider`
3. Paste your key from `.env` (the `nahcrof_...` key) and save
4. Run: `CrofAI: Refresh Models`

---

## Build from Source

```bash
# 1. Install dependencies
npm install

# 2. Compile TypeScript → out/
npm run compile

# 3. Package as .vsix
npx vsce package --out crof-ai-provider.vsix

# 4. Install in VS Code
code --install-extension crof-ai-provider.vsix --force

# 5. Reload VS Code (Cmd+Shift+P → Developer: Reload Window)
```

If you encounter `EPERM: uv_cwd` errors, run the commands via a subshell:
```bash
zsh -c 'cd /path/to/vscode-crofai-provider && npm run compile'
```

---

## Features

### Wide model selection

Choose from 14+ open-weight models across multiple model families:

| Model               | Context | Pricing             | Notes              |
| ------------------- | ------- | ------------------- | ------------------ |
| Kimi K2.5           | 262K    | $0.35↑ / $1.70↓ /M  | Vision             |
| Kimi K2.5 Lightning | 131K    | $1.00↑ / $3.00↓ /M  | Vision + Reasoning |
| GLM 5.1             | 202K    | $0.45↑ / $2.10↓ /M  |                    |
| GLM 5.1 Precision   | 202K    | $0.80↑ / $2.90↓ /M  | Higher quality     |
| Qwen3.5 397B A17B   | 262K    | $0.35↑ / $1.75↓ /M  | Vision + Reasoning |
| DeepSeek V3.2       | 163K    | $0.28↑ / $0.38↓ /M  |                    |
| **Qwen3.5 9B**      | 262K    | **Free**            | Vision + Reasoning |
| **GLM 4.7 Flash**   | 202K    | **Free**            |                    |

### Inline reasoning effort picker

For reasoning-capable models, select effort level directly in the model picker — no separate settings required.

Levels: **No Thinking** · **Low** · **Medium** · **High**

### Vision support

Send images in chat with Kimi, Gemma, and Qwen models. Attach screenshots, diagrams, or code images directly in Copilot Chat.

**How it works under the hood:**

1. When you attach an image, the extension uploads it to **[Litterbox](https://litterbox.catbox.moe)** — a free, anonymous temporary file host (no registration needed).
2. The upload includes a `time=1h` parameter, so the image auto-deletes after **1 hour**.
3. The returned public URL is injected into the OpenAI-format request sent to the CrofAI API — no local servers, no tunnels, no ports.
4. Duplicate images are deduplicated via SHA-256 hash (cached in memory, up to 50 entries).

**No setup required.** The extension works out of the box — no `cloudflared`, no Homebrew, no port configuration needed.

**Error handling:** If the upload fails, the extension retries up to 2 times and shows a descriptive error message. The request is never sent to CrofAI without a valid image URL.

### Tool calling & agent mode

Full tool calling support — works with Copilot's built-in agent tools (file edits, terminal, search) and custom MCP tools.

### Live usage display

Credits and remaining daily requests shown in the status bar. Click to see full usage details.

### Per-model temperature

Fine-tune temperature per model via `CrofAI: Configure Model Temperature`.

---

## CrofAI Plans

| Plan  | Price  | Daily Requests |
| ----- | ------ | -------------- |
| Free  | $0     | Pay-per-token  |
| Hobby | $5/mo  | 500            |
| Pro   | $10/mo | 1,000          |
| Scale | $50/mo | 7,500          |

See full pricing at [crof.ai](https://crof.ai).

---

## Commands

| Command                               | Description                             |
| ------------------------------------- | --------------------------------------- |
| `CrofAI: Manage CrofAI Provider`      | Set or update your API key              |
| `CrofAI: Show Usage`                  | Show current credits and request quota  |
| `CrofAI: Refresh Models`              | Force reload the model list             |
| `CrofAI: Configure Model Temperature` | Set per-model temperature               |
| `CrofAI: Configure Reasoning Effort`  | Set per-model reasoning effort override |

---

## Requirements

- [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) — required for model chat UI
- [CrofAI account](https://crof.ai) — free tier available

---

## Known Issues Fixed

### Image attachments not working with CrofAI API (April 2026)

**Symptom:** Attaching an image to the chat resulted in an API error or "no response" — the CrofAI API rejects base64 data URIs and cannot reach `localhost` URLs from local servers or tunnels.

**Root cause and solution:**

The image hosting implementation was changed from a **local HTTP server + Cloudflare Tunnel** to a **remote upload** approach using [Litterbox](https://litterbox.catbox.moe) (catbox.moe's temporary file service).

**Why the tunnel approach was abandoned:** Cloudflare Tunnel (cloudflared) was unreliable — QUIC protocol connections would drop on some networks, and the tunnel URL parsing was fragile across cloudflared versions. The tunnel also required users to install cloudflared via Homebrew.

**Current implementation (`imageServer.ts`):**
1. A `RemoteImageServer` class uploads image data to `https://litterbox.catbox.moe/resources/internals/api.php` via `multipart/form-data` POST.
2. The `time=1h` parameter ensures images auto-delete after 1 hour.
3. SHA-256 deduplication prevents re-uploading identical images (in-memory cache, up to 50 entries).
4. Upload happens inside the retry/try-catch loop — failures are retried up to 2 times and show descriptive error messages.
5. No local server, no ports, no tunnels, no dependencies required.

**Error handling:** If the upload fails, the user sees a message like:
> `Image upload failed: <reason>. The request was not sent to CrofAI.`

### Empty response stream during agentic sessions (April 2026)

**Symptom:** Extension threw `Empty response stream from CrofAI` after a few tool-call round-trips in agent mode. Retries made things worse by burning additional requests.

**Root causes fixed:**

1. **`stream_options: { include_usage: true }` removed** — CrofAI does not support this parameter. Sending it caused the API to silently return HTTP 200 with an empty body on certain request shapes.

2. **Parallel tool calls merged into one message** — The VS Code API delivers parallel tool calls as multiple `LanguageModelToolCallPart` entries on a single message. The extension was incorrectly creating one `assistant` message per tool call part, which violates the OpenAI message format and caused CrofAI to reject subsequent requests. All tool call parts from the same message are now correctly combined into a single `assistant` message with a `tool_calls` array.

3. **Mixed assistant messages fixed** — When an assistant message contained both text and tool calls, the text was emitted as a separate `assistant` message between the `assistant(tool_calls)` and `tool` result messages. This is now correctly merged into one `assistant` message with both `content` and `tool_calls`.

**Other improvements made at the same time:**
- Empty streams no longer trigger retries (pricing is per-request — retries on empty streams waste credits)
- Single 60 s timeout replaced with a 90 s connection timeout + 120 s per-chunk idle timeout, so long agentic responses are not cut off mid-stream
- Proper event-based SSE parser replaces line-by-line split, correctly handling multi-line data fields
- `reasoning_content` dynamically falls back to plain text for models that send all output in that field
- Partial responses are preserved instead of failing if the stream drops after content has started
- Diagnostic logging added: `[Request]`, `[Response]`, `[Stream]` lines in the CrofAI output channel

---

## Privacy

Your API key is stored in VS Code's encrypted `SecretStorage` and never written to settings files or logs. Requests go directly from your machine to `crof.ai` — no data passes through any third-party proxy.

---

## License

[EUPL-1.2](LICENSE)
