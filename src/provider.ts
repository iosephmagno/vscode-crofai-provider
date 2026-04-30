import * as vscode from 'vscode';
import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import {
  BASE_URL,
  CrofAIModelsService,
  getModelMaxOutputTokens,
  getEffortFromModelId,
  reasoningModelIds,
} from './models.js';
import { getModelTemperature, getModelReasoningEffort } from './config.js';
import type { ReasoningEffort } from './types.js';
import { logInfo, logWarn, logError, logDebug, logRequestStart, logRequestEnd, logRequestError } from './logger.js';
import { logPayloadToFile } from './fileLogger.js';
import { imageServer } from './imageServer.js';

const MAX_RETRIES = 2; // Only for real errors (network / 5xx) — NOT for empty streams
const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER_FACTOR = 0.2;
// Time to wait for the first byte from the API (connection timeout).
const CONNECTION_TIMEOUT_MS = 90_000;
// Max time between successive SSE chunks once streaming has started (idle timeout).
const IDLE_TIMEOUT_MS = 120_000;

const VALID_REASONING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);

interface ChunkData {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      thinking?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type: 'function';
        function: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface SseEvent {
  event?: string;
  data: string;
}

function extractSseEvents(
  buffer: string,
  pendingEventName?: string
): { events: SseEvent[]; rest: string; pendingEventName?: string } {
  const events: SseEvent[] = [];
  const lines = buffer.split(/\r?\n/);
  let rest = '';
  let eventName = pendingEventName;
  let dataLines: string[] = [];
  let sawTerminator = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (index === lines.length - 1 && !buffer.endsWith('\n') && !buffer.endsWith('\r')) {
      rest = [eventName ? `event:${eventName}` : '', ...dataLines.map((entry) => `data:${entry}`), line]
        .filter(Boolean)
        .join('\n');
      return { events, rest, pendingEventName: undefined };
    }

    if (line === '') {
      if (dataLines.length > 0) {
        events.push({ event: eventName, data: dataLines.join('\n') });
      }
      eventName = undefined;
      dataLines = [];
      sawTerminator = true;
      continue;
    }

    sawTerminator = false;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
  }

  if (!sawTerminator && (eventName !== undefined || dataLines.length > 0)) {
    rest = [eventName ? `event:${eventName}` : '', ...dataLines.map((entry) => `data:${entry}`)]
      .filter(Boolean)
      .join('\n');
  }

  return { events, rest, pendingEventName: undefined };
}

function emitChunkToProgress(
  chunk: ChunkData,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  shouldShowThinking: boolean,
  toolCallBuffer: Map<number, { id: string; name: string; arguments: string }>,
  dynamicReasoningAsText?: { value: boolean }
): boolean {
  // Consider usage/choices as a valid non-empty signal even before text arrives.
  let gotContent = !!(chunk.usage || Array.isArray(chunk.choices));

  const choice = chunk.choices?.[0];
  if (!choice) return gotContent;

  const delta = choice.delta ?? {};

  // Reasoning is handled by the streaming loop buffer — skip it here to avoid double emission
  const reasoningText = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (reasoningText != null) {
    gotContent = true;
    return gotContent;
  }

  if (delta.content != null) {
    gotContent = true;
    const text = typeof delta.content === 'string' ? delta.content : JSON.stringify(delta.content);
    progress.report(new vscode.LanguageModelTextPart(text));
  }

  if (delta?.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const idx = toolCall.index;
      if (toolCall.id && toolCall.function?.name !== undefined) {
        toolCallBuffer.set(idx, {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments || '',
        });
      } else if (toolCall.function?.arguments) {
        const existing = toolCallBuffer.get(idx);
        if (existing) {
          existing.arguments += toolCall.function.arguments;
        }
      }
    }
  }

  if (choice.finish_reason && choice.finish_reason !== 'tool_calls') {
    gotContent = true;
  }

  if (choice.finish_reason === 'tool_calls') {
    gotContent = true;
    for (const [, tc] of toolCallBuffer) {
      let args: object = {};
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        // Keep empty object
      }
      progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
    }
    toolCallBuffer.clear();
  }

  return gotContent;
}

function chunkHasAnyPayload(chunk: ChunkData): boolean {
  if (chunk.usage) {
    return true;
  }

  const choice = chunk.choices?.[0];
  if (!choice) {
    return false;
  }

  const delta = choice.delta ?? {};
  return (
    delta.content != null ||
    delta.reasoning_content != null ||
    delta.reasoning != null ||
    delta.thinking != null ||
    !!delta.tool_calls?.length ||
    choice.finish_reason != null
  );
}

function emitNonStreamingCompletion(
  payload: unknown,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  shouldShowThinking: boolean
): boolean {
  logDebug(`[emitNonStreaming] payload type=${typeof payload} isArray=${Array.isArray(payload)}`);
  const data = payload as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        reasoning?: string | null;
        thinking?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: unknown;
  };

  const message = data.choices?.[0]?.message;
  logDebug(`[emitNonStreaming] choices=${data.choices?.length ?? 0} hasMessage=${!!message} usage=${!!data.usage}`);
  if (message) {
    logDebug(`[emitNonStreaming] contentLen=${message.content?.length ?? 0} reasoning=${!!(message.reasoning_content ?? message.reasoning ?? message.thinking)} toolCalls=${message.tool_calls?.length ?? 0}`);
  }
  if (!message) {
    const ret = !!(data.choices?.[0]?.finish_reason || data.usage || Array.isArray(data.choices));
    logDebug(`[emitNonStreaming] No message, returning gotContent=${ret}`);
    return ret;
  }

  let gotContent = !!(data.choices?.[0]?.finish_reason || data.usage);

  const reasoningText = message.reasoning_content ?? message.reasoning ?? message.thinking;
  if (reasoningText != null) {
    gotContent = true;
    const text = String(reasoningText);
    if (shouldShowThinking) {
      const thinkingPart = new vscode.LanguageModelThinkingPart(text);
      progress.report(thinkingPart as unknown as vscode.LanguageModelResponsePart);
    } else {
      progress.report(new vscode.LanguageModelTextPart(text));
    }
  }

  if (message.content != null && message.content !== '') {
    gotContent = true;
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    progress.report(new vscode.LanguageModelTextPart(text));
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    gotContent = true;
    for (const tc of message.tool_calls) {
      const callId = tc.id || `tool_${Math.random().toString(36).slice(2)}`;
      const name = tc.function?.name || 'tool_call';
      let args: object = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        // Keep empty object
      }
      progress.report(new vscode.LanguageModelToolCallPart(callId, name, args));
    }
  }

  logDebug(`[emitNonStreaming] Returning gotContent=${gotContent}`);
  return gotContent;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.name === 'AbortError' ||
      error.message.includes('aborted') ||
      error.message.includes('abort')
    );
  }
  return false;
}

function resolveErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Failed to get response from CrofAI. Please try again.';
  }
  const msg = error.message;
  if (msg.includes('401')) {
    return 'Invalid CrofAI API key. Please run "CrofAI: Manage Provider" to update it.';
  }
  if (msg.includes('403')) {
    return 'Access denied. Please check your CrofAI API key permissions.';
  }
  if (msg.includes('429')) {
    return 'Rate limit exceeded. Please wait before retrying.';
  }
  if (/API error 5\d\d/.test(msg)) {
    return `CrofAI server error: ${msg}`;
  }
  if (msg.includes('upload') || msg.includes('Litterbox') || msg.includes('catbox')) {
    return `Image upload failed: ${msg.substring(0, 200)}. The request was not sent to CrofAI.`;
  }
  if (msg.includes('Connection timeout') || msg.includes('Idle timeout')) {
    return `CrofAI request timed out: ${msg}.`;
  }
  return `CrofAI error: ${msg}`;
}

async function buildOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<Array<{
  role: string;
  content: string | Array<unknown>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}>> {
  const result: Array<{
    role: string;
    content: string | Array<unknown>;
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }> = [];

  for (const msg of messages) {
    const role = msg.role === 1 ? 'user' : msg.role === 2 ? 'assistant' : 'system';

    const toolCallParts = msg.content.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    const toolResultParts = msg.content.filter(
      (p): p is vscode.LanguageModelToolResultPart => p instanceof vscode.LanguageModelToolResultPart
    );
    const textParts = msg.content.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    const dataParts = msg.content.filter(
      (p): p is vscode.LanguageModelDataPart => p instanceof vscode.LanguageModelDataPart
    );

    // Log message parts breakdown
    logDebug(`[buildMessages] role=${role} textParts=${textParts.length} dataParts=${dataParts.length} toolCalls=${toolCallParts.length} toolResults=${toolResultParts.length} name=${msg.name ?? '(none)'}`);
    for (const dp of dataParts) {
      logDebug(`[buildMessages]   dataPart mimeType=${dp.mimeType} dataSize=${('byteLength' in dp.data ? (dp.data as Uint8Array).byteLength : dp.data instanceof ArrayBuffer ? dp.data.byteLength : typeof dp.data === 'object' && 'length' in dp.data ? (dp.data as { length: number }).length : '?')}`);
    }

    // Tool call messages
    if (toolCallParts.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.map((p) => p.value).join(''),
        tool_calls: toolCallParts.map((part) => ({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
          },
        })),
      });
      logDebug(`[buildMessages] Pushed tool_calls role=assistant toolCalls=${toolCallParts.length}`);
      continue;
    }

    // Tool result messages
    if (toolResultParts.length > 0) {
      for (const part of toolResultParts) {
        let toolContent: string;
        if (typeof part.content === 'string') {
          toolContent = part.content;
        } else if (Array.isArray(part.content)) {
          toolContent = part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : '')).join('');
        } else {
          toolContent = JSON.stringify(part.content);
        }
        result.push({ role: 'tool', content: toolContent, tool_call_id: part.callId });
      }
      logDebug(`[buildMessages] Pushed tool_results role=tool count=${toolResultParts.length}`);
      continue;
    }

    // Images present → use array format (OpenAI vision API)
    const imageParts = dataParts.filter((p) => p.mimeType.startsWith('image/'));
    if (imageParts.length > 0) {
      logInfo(`[buildMessages] Images detected: ${imageParts.length} image(s), ${textParts.length} text part(s)`);
      const content: Array<unknown> = [];
      const textValue = textParts.map((p) => p.value).join('');
      if (textValue) {
        logDebug(`[buildMessages]   text content: "${textValue.substring(0, 200)}"`);
        content.push({ type: 'text', text: textValue });
      }
      for (const part of imageParts) {
        logInfo(`[buildMessages] Uploading image mimeType=${part.mimeType} size=${('byteLength' in part.data ? (part.data as Uint8Array).byteLength : '?')}`);
        const url = await imageServer.upload(Buffer.from(part.data), part.mimeType);
        logInfo(`[buildMessages] Image uploaded url=${url}`);
        content.push({ type: 'image_url', image_url: { url } });
      }
      const contentSummary = content.map((c: unknown) => {
        const entry = c as { type: string; text?: string; image_url?: { url: string } };
        return entry.type === 'text' ? `text:${(entry.text?.substring(0, 50) ?? '')}` : `image:${(entry.image_url?.url?.substring(0, 80) ?? '')}`;
      }).join(' | ');
      logInfo(`[buildMessages] Pushed image message role=${role} content=[${contentSummary}]`);
      result.push({ role, content, name: msg.name });
      continue;
    }

    // Plain text (or non-image data — treat as text)
    for (const part of textParts) {
      logDebug(`[buildMessages]   text: "${part.value.substring(0, 100)}"`);
      result.push({ role, content: part.value, name: msg.name });
    }
    for (const part of dataParts) {
      logDebug(`[buildMessages]   non-image data: ${part.mimeType}`);
      result.push({ role, content: `[${part.mimeType} data]`, name: msg.name });
    }
  }

  logInfo(`[buildMessages] Total messages constructed: ${result.length}`);
  return result;
}

export class CrofAIChatModelProvider implements vscode.LanguageModelChatProvider<LanguageModelChatInformation> {
  private readonly _onDidChangeModelInfo = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeModelInfo.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly modelsService: CrofAIModelsService
  ) {}

  fireModelChange(): void {
    this._onDidChangeModelInfo.fire();
  }

  dispose(): void {
    this._onDidChangeModelInfo.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    return this.modelsService.prepareLanguageModelChatInformation(this.secrets, options, token);
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: CancellationToken
  ): Promise<void> {
    const apiKey = await this.secrets.get('crofai.apiKey');
    if (!apiKey) {
      throw new Error(
        'CrofAI API key not configured. Please run "CrofAI: Manage Provider" to add your API key.'
      );
    }

    const { baseModelId, effort: suffixEffort } = getEffortFromModelId(model.id);
    // Priority: VS Code model config picker → old suffix → stored setting → model default
    const configEffortRaw = options.modelConfiguration?.reasoningEffort;
    const configEffort =
      typeof configEffortRaw === 'string' && VALID_REASONING_EFFORTS.has(configEffortRaw)
        ? (configEffortRaw as ReasoningEffort)
        : undefined;
    const selectedEffort = configEffort ?? suffixEffort ?? getModelReasoningEffort(baseModelId);
    const modelSupportsThinking = reasoningModelIds.has(baseModelId);
    const shouldShowThinking = modelSupportsThinking && selectedEffort !== 'none';

    const temperature = getModelTemperature(baseModelId);

    let retries = 0;
    let lastError: unknown;

    while (retries <= MAX_RETRIES) {
      if (token.isCancellationRequested) {
        return;
      }

      if (retries > 0) {
        const base = RETRY_BASE_DELAY_MS * 2 ** (retries - 1);
        const jitter = base * RETRY_JITTER_FACTOR * (Math.random() * 2 - 1);
        const delay = Math.round(base + jitter);
        logInfo(`[Retry] attempt=${retries} delay=${delay}ms model=${baseModelId}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const abortController = new AbortController();
      const cancelDisposable = token.onCancellationRequested(() => abortController.abort());
      const startMs = Date.now();
      let ttfMs: number | undefined;
      let gotContent = false;

      // Connection timeout: fires if no bytes arrive within CONNECTION_TIMEOUT_MS.
      // Idle timeout: fires if no new chunk arrives within IDLE_TIMEOUT_MS after streaming starts.
      let timeoutId = setTimeout(
        () => abortController.abort(new Error('Connection timeout: no response from CrofAI')),
        CONNECTION_TIMEOUT_MS
      );
      const resetIdleTimeout = (): void => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(
          () => abortController.abort(new Error('Idle timeout: CrofAI stopped streaming')),
          IDLE_TIMEOUT_MS
        );
      };

      try {
        const openaiMessages = await buildOpenAIMessages(messages);

        // Detect vision requests (any message with array content = image_url format)
        const hasVisionContent = openaiMessages.some((m) => Array.isArray(m.content));
        // CrofAI vision API bug: system messages + stream=true returns 0 tokens.
        // Fall back to non-streaming for vision requests as a workaround.
        const useStream = !hasVisionContent;

        const requestBody: Record<string, unknown> = {
          model: baseModelId,
          messages: openaiMessages,
          stream: useStream,
          max_tokens: getModelMaxOutputTokens(baseModelId),
        };
        if (temperature !== undefined) requestBody.temperature = temperature;
        if (selectedEffort) requestBody.reasoning_effort = selectedEffort;
        if (options.tools && options.tools.length > 0) {
          requestBody.tools = options.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema ?? { type: 'object', properties: {}, required: [] },
            },
          }));
        }

        const totalMessageChars = openaiMessages.reduce(
          (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0
        );
        const roleSequence = openaiMessages.map((m) => {
          if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return 'assistant(tool_calls)';
          if (m.role === 'tool') return 'tool';
          return m.role;
        }).join(',');
        const visionTag = hasVisionContent ? ' [VISION]' : '';
        logInfo(`[Request]${visionTag} model=${baseModelId} stream=${useStream} messages=${openaiMessages.length} totalChars=${totalMessageChars} roles=[${roleSequence}]`);
        logPayloadToFile('request', requestBody);

        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': this.userAgent,
          },
          body: JSON.stringify({ ...requestBody, messages: openaiMessages }),
          signal: abortController.signal,
        });

        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        logInfo(`[Response] status=${response.status} content-type=${contentType}`);

        // Log response headers for debugging
        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => { respHeaders[k] = v; });
        logDebug(`[Response] headers=${JSON.stringify(respHeaders)}`);

        if (!response.ok) {
          const errorText = await response.text();
          logWarn(`[Response] Error body: ${errorText.slice(0, 500)}`);
          logPayloadToFile('response', { status: response.status, statusText: response.statusText, body: errorText, headers: respHeaders });
          throw new Error(`API error ${response.status}: ${errorText}`);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let pendingEventName: string | undefined;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let totalTokens: number | undefined;

        const toolCallBuffer = new Map<number, { id: string; name: string; arguments: string }>();

        // Some OpenAI-compatible providers ignore stream=true and return a
        // normal JSON completion payload. Handle that shape directly.
        if (!contentType.includes('text/event-stream')) {
          logInfo(`[NonStreaming] Received non-streaming response for model=${baseModelId}`);
          const payload = await response.json();
          logPayloadToFile('response', { type: 'non-streaming', model: baseModelId, payload });
          logDebug(`[NonStreaming] payload=${JSON.stringify(payload).substring(0, 1000)}`);
          gotContent = emitNonStreamingCompletion(payload, progress, shouldShowThinking);
          logInfo(`[NonStreaming] emitNonStreamingCompletion returned gotContent=${gotContent}`);
          logRequestEnd({
            model: baseModelId,
            ttfms: Date.now() - startMs,
            promptTokens,
            completionTokens,
            totalTokens,
            retries,
          });

          if (!gotContent) {
            logWarn(`[NonStreaming] Empty response payload: ${JSON.stringify(payload).substring(0, 500)}`);
            throw new Error('Empty non-streaming response from CrofAI');
          }

          return;
        }

        // Streaming path — only access response.body here, after non-streaming check
        if (!response.body) {
          throw new Error('No response body');
        }

        const reader = response.body.getReader();

        // Track reasoning_content fallback for this request stream.
        const reasoningAsTextRef = { value: !shouldShowThinking };
        // Buffer reasoning chunks to avoid character-by-character emission
        let reasoningBuffer = '';
        const flushReasoning = () => {
          if (!reasoningBuffer) return;
          gotContent = true;
          if (shouldShowThinking) {
            const thinkingPart = new vscode.LanguageModelThinkingPart(reasoningBuffer);
            progress.report(thinkingPart as unknown as vscode.LanguageModelResponsePart);
          } else {
            progress.report(new vscode.LanguageModelTextPart(reasoningBuffer));
          }
          reasoningBuffer = '';
        };
        let totalBytesReceived = 0;
        let rawStreamText = ''; // Collect raw stream for file logging
        while (true) {
          if (token.isCancellationRequested) {
            return;
          }

          const { done, value } = await reader.read();
          if (done) {
            logInfo(`[Stream] done totalBytes=${totalBytesReceived} gotContent=${gotContent}`);
            // Log the raw stream to file for debugging
            logPayloadToFile('response', { type: 'stream', model: baseModelId, totalBytes: totalBytesReceived, rawData: rawStreamText.substring(0, 100_000) });
            break;
          }
          totalBytesReceived += value.byteLength;

          const decoded = decoder.decode(value, { stream: true });
          rawStreamText += decoded;
          buffer += decoded;
          const parsedEvents = extractSseEvents(buffer, pendingEventName);
          buffer = parsedEvents.rest;
          pendingEventName = parsedEvents.pendingEventName;

          for (const sseEvent of parsedEvents.events) {
            const data = sseEvent.data;
            logDebug(`[SSE] Event=${sseEvent.event ?? 'message'} Data: ${data}`);
            if (data === '[DONE]') {
              logDebug('[SSE] [DONE] received');
              continue;
            }
            if (!data) {
              logDebug('[SSE] Empty event data');
              continue;
            }

            if (sseEvent.event === 'error') {
              logWarn(`[SSE] Error event: ${data}`);
              try {
                const errBody = JSON.parse(data) as { error?: { message?: string; code?: number } };
                const msg = errBody?.error?.message ?? data;
                throw new Error(`API error: ${msg}`);
              } catch (parseErr) {
                if (parseErr instanceof SyntaxError) {
                  throw new Error(`API error: ${data}`);
                }
                throw parseErr;
              }
            }

            let parsed: ChunkData & {
              error?: { message?: string; type?: string; code?: number | string };
            };
            try {
              parsed = JSON.parse(data) as ChunkData & {
                error?: { message?: string; type?: string; code?: number | string };
              };
            } catch (parseErr) {
              logWarn(
                `[Streaming] Invalid JSON chunk skipped: ${parseErr instanceof Error ? parseErr.message : 'parse error'}`
              );
              continue;
            }

            if (parsed.error) {
              logWarn(`[SSE] Parsed error: ${parsed.error.message || data}`);
              const msg = parsed.error.message || data;
              throw new Error(`API error: ${msg}`);
            }

            const chunk: ChunkData = parsed;

            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens;
              completionTokens = chunk.usage.completion_tokens;
              totalTokens = chunk.usage.total_tokens;
            }

            // Once CrofAI sends any valid payload, the response is not empty.
            // Also switch from connection timeout to idle timeout on first chunk.
            if (chunkHasAnyPayload(chunk)) {
              if (ttfMs === undefined) ttfMs = Date.now() - startMs;
              gotContent = true;
            }
            // Reset idle timeout on every valid chunk so long responses don't get cut off.
            resetIdleTimeout();

            const choice = chunk.choices?.[0];
            const delta = choice?.delta ?? {};
            if (delta.reasoning_content != null && !shouldShowThinking) {
              reasoningAsTextRef.value = true;
            }

            // Buffer reasoning chunks and flush on word boundaries
            const reasoningChunk = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
            if (reasoningChunk != null) {
              reasoningBuffer += reasoningChunk;
              // Flush on space (word boundary) or when reasoning is long enough
              if (reasoningBuffer.includes(' ') || reasoningBuffer.length > 80) {
                flushReasoning();
              }
            } else {
              // Flush any remaining reasoning before processing non-reasoning content
              flushReasoning();
            }

            try {
              const hadContent = emitChunkToProgress(
                chunk,
                progress,
                shouldShowThinking,
                toolCallBuffer,
                reasoningAsTextRef
              );
              if (hadContent) {
                if (ttfMs === undefined) ttfMs = Date.now() - startMs;
                gotContent = true;
                logDebug('[SSE] Content emitted to progress');
              }
            } catch (emitErr) {
              logWarn(
                `[Streaming] Progress emission failed: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`
              );
            }
          }
        }

        // Flush any remaining buffered reasoning
        flushReasoning();

        // Parse trailing buffered JSON when provider closes stream without final newline.
        const trailingEvents = extractSseEvents(buffer + '\n\n', pendingEventName);
        for (const sseEvent of trailingEvents.events) {
          const data = sseEvent.data;
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data) as ChunkData & {
                error?: { message?: string; type?: string; code?: number | string };
              };
              if (parsed?.error) {
                const msg = parsed.error.message || data;
                throw new Error(`API error: ${msg}`);
              }
              const chunk: ChunkData = parsed;
              if (chunkHasAnyPayload(chunk)) {
                if (ttfMs === undefined) ttfMs = Date.now() - startMs;
                gotContent = true;
              }
              try {
                const hadContent = emitChunkToProgress(
                  chunk,
                  progress,
                  shouldShowThinking,
                  toolCallBuffer,
                  reasoningAsTextRef
                );
                if (hadContent) {
                  if (ttfMs === undefined) ttfMs = Date.now() - startMs;
                  gotContent = true;
                }
              } catch (emitErr) {
                logWarn(
                  `[Streaming] Trailing progress emission failed: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`
                );
              }
            } catch (parseErr) {
              logWarn(
                `[Streaming] Trailing JSON chunk skipped: ${parseErr instanceof Error ? parseErr.message : 'parse error'}`
              );
            }
          }
        }

        // Emit any remaining buffered tool calls
        for (const [, tc] of toolCallBuffer) {
          let args: object = {};
          try {
            args = JSON.parse(tc.arguments || '{}');
          } catch {
            // Keep empty object
          }
          gotContent = true;
          progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
        }

        logRequestEnd({
          model: baseModelId,
          ttfms: ttfMs ?? Date.now() - startMs,
          promptTokens,
          completionTokens,
          totalTokens,
          retries,
        });

        // Retry on empty stream; if this is the last attempt, throw a real
        // error so VS Code doesn't display a generic "no response returned".
        if (!gotContent) {
          logWarn(`[EmptyStream] model=${baseModelId} totalChars=${totalMessageChars} roles=[${roleSequence}]`);
          logError(`[EmptyStream] No recovery possible for model=${baseModelId}`);
          // Log what the raw stream contained (if anything) for debugging
          const rawPreview = rawStreamText ? rawStreamText.substring(0, 2000) : '(no raw stream data)';
          logPayloadToFile('response', { type: 'empty-stream-error', model: baseModelId, totalBytes: totalBytesReceived, rawPreview, rawData: rawStreamText?.substring(0, 100_000) ?? '' });
          throw new Error('Empty response stream from CrofAI');
        }

        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        logError(`[Catch] model=${baseModelId} attempt=${retries}/${MAX_RETRIES} gotContent=${gotContent} error=${errorMsg} stack=${errorStack ?? '(no stack)'}`);

        if (isAbortError(error)) {
          // User cancelled — not an error
          return;
        }

        // If we already emitted content, preserve the partial answer instead of
        // converting it into a hard failure due to a late stream/provider error.
        if (gotContent) {
          logWarn(
            `[Stream] model=${baseModelId} ended with partial content: ${errorMsg}`
          );
          logRequestEnd({
            model: baseModelId,
            ttfms: ttfMs ?? Date.now() - startMs,
            retries,
          });
          return;
        }

        lastError = error;
        logRequestError(baseModelId, error);

        // Don't retry auth errors
        if (errorMsg.includes('401') || errorMsg.includes('403')) {
          break;
        }

        retries++;
      } finally {
        clearTimeout(timeoutId);
        cancelDisposable.dispose();
      }
    }

    // All retries exhausted
    const finalMsg = resolveErrorMessage(lastError);
    logError(`[Exhausted] model=${baseModelId} All ${MAX_RETRIES + 1} attempts failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    logPayloadToFile('response', { type: 'exhausted', model: baseModelId, lastError: lastError instanceof Error ? { message: lastError.message, stack: lastError.stack } : String(lastError) });
    throw new Error(finalMsg);
  }

  async provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    let content = '';
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content += part.value;
      }
    }
    return Math.ceil(content.length / 4);
  }
}
