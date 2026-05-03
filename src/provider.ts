import * as vscode from 'vscode';
import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import {
  BASE_URL,
  CrofAIModelsService,
  getModelMaxOutputTokens,
  getEffortFromModelId,
  resolveModelVariant,
  reasoningModelIds,
} from './models.js';
import { getModelTemperature, getModelReasoningEffort } from './config.js';
import type { ReasoningEffort } from './types.js';
import { logInfo, logWarn, logError, logDebug, logRequestStart, logRequestEnd, logRequestError } from './logger.js';
import { logPayloadToFile } from './fileLogger.js';
import { imageServer } from './imageServer.js';

// Type guards for VS Code chat parts
function isToolCallPart(p: unknown): p is vscode.LanguageModelToolCallPart {
  return !!p && typeof p === 'object' && 'callId' in p && 'name' in p;
}
function isToolResultPart(p: unknown): p is vscode.LanguageModelToolResultPart {
  return !!p && typeof p === 'object' && 'callId' in p && 'content' in p;
}
function isTextPart(p: unknown): p is vscode.LanguageModelTextPart {
  return !!p && typeof p === 'object' && 'value' in p && typeof (p as { value: unknown }).value === 'string';
}
function isDataPart(p: unknown): p is vscode.LanguageModelDataPart {
  return !!p && typeof p === 'object' && 'mimeType' in p && 'data' in p;
}

const MAX_RETRIES = 2; // Only for real errors (network / 5xx) — NOT for empty streams
const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER_FACTOR = 0.2;
// Time to wait for the first byte from the API (connection timeout).
const CONNECTION_TIMEOUT_MS = 90_000;
// Max time between successive SSE chunks once streaming has started (idle timeout).
const IDLE_TIMEOUT_MS = 120_000;
const MAX_CONTEXT_MESSAGES = 40;
const MAX_CONTEXT_CHARS = 120_000;

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

type OpenAIRequestMessage = {
  role: string;
  content: string | Array<unknown>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

function messageContentLength(content: string | Array<unknown>): number {
  if (typeof content === 'string') {
    return content.length;
  }

  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

function truncateOpenAIMessages(openaiMessages: OpenAIRequestMessage[], modelId: string): OpenAIRequestMessage[] {
  if (openaiMessages.length <= MAX_CONTEXT_MESSAGES) {
    const totalChars = openaiMessages.reduce((sum, m) => sum + messageContentLength(m.content), 0);
    if (totalChars <= MAX_CONTEXT_CHARS) {
      return openaiMessages;
    }
  }

  // Keep assistant(tool_calls)+tool results as atomic units so truncation does
  // not break tool-call/result chains.
  const units: Array<{ indices: number[]; chars: number }> = [];
  let pendingToolUnit: number[] | undefined;
  for (let i = 0; i < openaiMessages.length; i++) {
    const message = openaiMessages[i];
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

    if (message.role === 'assistant' && hasToolCalls) {
      if (pendingToolUnit && pendingToolUnit.length > 0) {
        units.push({
          indices: pendingToolUnit,
          chars: pendingToolUnit.reduce((sum, idx) => sum + messageContentLength(openaiMessages[idx].content), 0),
        });
      }
      pendingToolUnit = [i];
      continue;
    }

    if (message.role === 'tool') {
      if (pendingToolUnit) {
        pendingToolUnit.push(i);
      } else {
        units.push({ indices: [i], chars: messageContentLength(message.content) });
      }
      continue;
    }

    if (pendingToolUnit && pendingToolUnit.length > 0) {
      units.push({
        indices: pendingToolUnit,
        chars: pendingToolUnit.reduce((sum, idx) => sum + messageContentLength(openaiMessages[idx].content), 0),
      });
      pendingToolUnit = undefined;
    }

    units.push({ indices: [i], chars: messageContentLength(message.content) });
  }
  if (pendingToolUnit && pendingToolUnit.length > 0) {
    units.push({
      indices: pendingToolUnit,
      chars: pendingToolUnit.reduce((sum, idx) => sum + messageContentLength(openaiMessages[idx].content), 0),
    });
  }

  // Ensure at least the newest system message is retained for instruction continuity.
  const latestSystemIndex = (() => {
    for (let i = openaiMessages.length - 1; i >= 0; i--) {
      if (openaiMessages[i].role === 'system') {
        return i;
      }
    }
    return -1;
  })();

  const selectedUnitIds = new Set<number>();
  let selectedCount = 0;
  let selectedChars = 0;

  const includeUnit = (unitId: number, force = false): boolean => {
    if (selectedUnitIds.has(unitId)) {
      return true;
    }

    const unit = units[unitId];
    const nextCount = selectedCount + unit.indices.length;
    const nextChars = selectedChars + unit.chars;
    if (!force && (nextCount > MAX_CONTEXT_MESSAGES || nextChars > MAX_CONTEXT_CHARS)) {
      return false;
    }

    selectedUnitIds.add(unitId);
    selectedCount = nextCount;
    selectedChars = nextChars;
    return true;
  };

  if (latestSystemIndex >= 0) {
    const systemUnitId = units.findIndex((u) => u.indices.includes(latestSystemIndex));
    if (systemUnitId >= 0) {
      includeUnit(systemUnitId, true);
    }
  }

  for (let unitId = units.length - 1; unitId >= 0; unitId--) {
    includeUnit(unitId, false);
  }

  const selectedIndices = Array.from(selectedUnitIds)
    .flatMap((unitId) => units[unitId].indices)
    .sort((a, b) => a - b);

  const truncated = selectedIndices.map((idx) => openaiMessages[idx]);

  if (truncated.length === 0 && openaiMessages.length > 0) {
    // Last-resort fallback: always send at least the newest message.
    return [openaiMessages[openaiMessages.length - 1]];
  }

  const originalChars = openaiMessages.reduce((sum, m) => sum + messageContentLength(m.content), 0);
  const truncatedChars = truncated.reduce((sum, m) => sum + messageContentLength(m.content), 0);

  if (truncated.length < openaiMessages.length) {
    logWarn(
      `[Truncate] model=${modelId} messages=${openaiMessages.length} -> ${truncated.length} (dropped ${openaiMessages.length - truncated.length})`
    );
  }
  if (truncatedChars < originalChars) {
    logWarn(
      `[Truncate] model=${modelId} totalChars=${originalChars} -> ${truncatedChars}`
    );
  }
  if (latestSystemIndex >= 0 && !truncated.some((m) => m.role === 'system')) {
    logWarn(`[Truncate] model=${modelId} no system message survived truncation`);
  }

  return truncated;
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
  // Return whether this chunk produced at least one emitted response part.
  let emittedPart = false;

  const choice = chunk.choices?.[0];
  if (!choice) return emittedPart;

  const delta = choice.delta ?? {};

  // Reasoning is handled by the streaming loop buffer — skip it here to avoid double emission
  const reasoningText = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
  if (reasoningText != null) {
    return emittedPart;
  }

  if (delta.content != null) {
    emittedPart = true;
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

  if (choice.finish_reason === 'tool_calls') {
    for (const [, tc] of toolCallBuffer) {
      const args = parseToolArgumentsOrThrow(tc.arguments, tc.name, 'stream');
      emittedPart = true;
      progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, args));
    }
    toolCallBuffer.clear();
  }

  return emittedPart;
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

function parseToolArgumentsOrThrow(rawArgs: string | undefined, toolName: string, source: string): object {
  const input = rawArgs?.trim() || '{}';

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    const preview = input.slice(0, 200);
    logWarn(`Malformed tool call arguments from ${source} for tool "${toolName}"; using {}. preview=${preview}`);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    logWarn(
      `Malformed tool call arguments from ${source} for tool "${toolName}": expected JSON object, got ${kind}; using {}`
    );
    return {};
  }

  return parsed as object;
}

function isServerGenerationError(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes('api error 500') ||
    msg.includes('internal_error') ||
    msg.includes('failed to generate response')
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
    logDebug('[emitNonStreaming] No message, returning emitted=false');
    return false;
  }

  let emittedPart = false;

  const reasoningText = message.reasoning_content ?? message.reasoning ?? message.thinking;
  if (reasoningText != null) {
    emittedPart = true;
    const text = String(reasoningText);
    progress.report(new vscode.LanguageModelTextPart(text));
  }

  if (message.content != null && message.content !== '') {
    emittedPart = true;
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    progress.report(new vscode.LanguageModelTextPart(text));
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    emittedPart = true;
    for (const tc of message.tool_calls) {
      const callId = tc.id || `tool_${Math.random().toString(36).slice(2)}`;
      const name = tc.function?.name || 'tool_call';
      const args = parseToolArgumentsOrThrow(tc.function?.arguments, name, 'non-stream');
      progress.report(new vscode.LanguageModelToolCallPart(callId, name, args));
    }
  }

  logDebug(`[emitNonStreaming] Returning emitted=${emittedPart}`);
  return emittedPart;
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
  if (msg.includes('Malformed tool call arguments')) {
    return `CrofAI returned malformed tool-call arguments: ${msg}`;
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

  // Identify the last 10 messages and the latest 2 vision prompts among them
  const last10 = messages.slice(-10);
  // Find indices (relative to last10) of vision prompts (messages with image/* data parts)
  const visionIndices: number[] = [];
  last10.forEach((msg, idx) => {
    const dataParts = msg.content.filter(isDataPart);
    if (dataParts.some((p) => p.mimeType.startsWith('image/'))) {
      visionIndices.push(idx);
    }
  });
  // Only keep the last 2 vision prompt indices
  const keepVisionIndices = new Set(visionIndices.slice(-2));

  // For each message, determine if its images should be included
  // Map: message index in messages -> includeImages (true/false)
  const includeImagesMap = new Map<number, boolean>();
  messages.forEach((msg, i) => {
    // If this message is in the last 10, and is one of the last 2 vision prompts, include images
    const last10Idx = i - (messages.length - last10.length);
    if (last10Idx >= 0 && keepVisionIndices.has(last10Idx)) {
      includeImagesMap.set(i, true);
    } else {
      includeImagesMap.set(i, false);
    }
  });

  for (let i = 0; i < messages.length; ++i) {
    const msg = messages[i];
    const role = msg.role === 1 ? 'user' : msg.role === 2 ? 'assistant' : 'system';

    const toolCallParts = msg.content.filter(isToolCallPart);
    const toolResultParts = msg.content.filter(isToolResultPart);
    const textParts = msg.content.filter(isTextPart);
    const dataParts = msg.content.filter(isDataPart);

    // Log message parts breakdown
    logDebug(`[buildMessages] role=${role} textParts=${textParts.length} dataParts=${dataParts.length} toolCalls=${toolCallParts.length} toolResults=${toolResultParts.length} name=${msg.name ?? '(none)'}`);
    for (const dp of dataParts) {
      let dataSize: number | string = '?';
      if (dp.data && typeof dp.data === 'object') {
        if ('byteLength' in dp.data && typeof (dp.data as any).byteLength === 'number') {
          dataSize = (dp.data as { byteLength: number }).byteLength;
        } else if ('length' in dp.data && typeof (dp.data as any).length === 'number') {
          dataSize = (dp.data as { length: number }).length;
        }
      }
      logDebug(`[buildMessages]   dataPart mimeType=${dp.mimeType} dataSize=${dataSize}`);
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
    const includeImages = includeImagesMap.get(i) ?? false;
    if (imageParts.length > 0) {
      if (includeImages) {
        logInfo(`[buildMessages] Images detected: ${imageParts.length} image(s), ${textParts.length} text part(s)`);
        const content: Array<unknown> = [];
        const textValue = textParts.map((p) => p.value).join('');
        if (textValue) {
          logDebug(`[buildMessages]   text content: "${textValue.substring(0, 200)}"`);
          content.push({ type: 'text', text: textValue });
        }
        for (const part of imageParts) {
          // If part.data is a string and looks like a public URL, use it directly
          let url: string | undefined;
          if (typeof part.data === 'string' && /^https?:\/\//.test(part.data)) {
            url = part.data;
            logInfo(`[buildMessages] Using existing image URL: ${url}`);
          } else {
            logInfo(`[buildMessages] Uploading image mimeType=${part.mimeType} size=${('byteLength' in part.data ? (part.data as Uint8Array).byteLength : '?')}`);
            url = await imageServer.upload(Buffer.from(part.data), part.mimeType);
            logInfo(`[buildMessages] Image uploaded url=${url}`);
          }
          content.push({ type: 'image_url', image_url: { url } });
        }
        const contentSummary = content.map((c: unknown) => {
          const entry = c as { type: string; text?: string; image_url?: { url: string } };
          return entry.type === 'text' ? `text:${(entry.text?.substring(0, 50) ?? '')}` : `image:${(entry.image_url?.url?.substring(0, 80) ?? '')}`;
        }).join(' | ');
        logInfo(`[buildMessages] Pushed image message role=${role} content=[${contentSummary}]`);
        result.push({ role, content, name: msg.name });
      } else {
        // Skip images, but include text if present
        const textValue = textParts.map((p) => p.value).join('');
        if (textValue) {
          logInfo(`[buildMessages] Skipping images for message (not in latest 2 vision prompts in last 10). Including text only.`);
          result.push({ role, content: textValue, name: msg.name });
        } else {
          logInfo(`[buildMessages] Skipping entire vision message (no text, not in latest 2 vision prompts in last 10).`);
        }
      }
      continue;
    }

    // Plain text (or non-image data — treat as text)
    for (const part of textParts) {
      logDebug(`[buildMessages]   text: "${part.value.substring(0, 100)}"`);
      result.push({ role, content: part.value, name: msg.name });
    }
    for (const part of dataParts) {
      // Decode text/* and application/json files dragged into the chat field.
      const isDecodableText =
        part.mimeType.startsWith('text/') ||
        part.mimeType === 'application/json' ||
        part.mimeType === 'application/xml';
      if (isDecodableText) {
        try {
          const text =
            typeof part.data === 'string'
              ? part.data
              : new TextDecoder('utf-8', { fatal: false }).decode(part.data as Uint8Array);
          if (text.trim()) {
            logDebug(`[buildMessages]   decoded data part mimeType=${part.mimeType} len=${text.length}`);
            result.push({ role, content: text, name: msg.name });
          } else {
            logDebug(`[buildMessages]   decoded data part was empty: ${part.mimeType}`);
          }
        } catch {
          logWarn(`[buildMessages]   failed to decode data part mimeType=${part.mimeType}`);
          result.push({ role, content: `[${part.mimeType} data]`, name: msg.name });
        }
      } else {
        logDebug(`[buildMessages]   non-decodable data: ${part.mimeType}`);
        result.push({ role, content: `[${part.mimeType} data]`, name: msg.name });
      }
    }
  }

  logInfo(`[buildMessages] Total messages constructed: ${result.length}`);
  return result;
}

export class CrofAIChatModelProvider implements vscode.LanguageModelChatProvider<LanguageModelChatInformation> {
  private readonly _onDidChangeModelInfo = new vscode.EventEmitter<void>();
  private _isActive = true;
  private _modelInfoCache: LanguageModelChatInformation[] | undefined;
  private _modelInfoCallCount = 0;
  private _activeModelConfigKey: string | undefined;
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeModelInfo.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly modelsService: CrofAIModelsService
  ) {}

  fireModelChange(): void {
    this._modelInfoCache = undefined;
    this._activeModelConfigKey = undefined;
    this._onDidChangeModelInfo.fire();
  }

  async refreshModelPickerCache(): Promise<void> {
    this._modelInfoCache = undefined;
    this._activeModelConfigKey = undefined;
    // Single event to avoid duplicate accumulation in the first picker panel.
    this._onDidChangeModelInfo.fire();
  }

  async prepareForDeactivate(): Promise<void> {
    this._isActive = false;
    this._modelInfoCache = undefined;
    this._activeModelConfigKey = undefined;
    this._onDidChangeModelInfo.fire();
  }

  dispose(): void {
    this._onDidChangeModelInfo.dispose();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    this._modelInfoCallCount += 1;
    const configuration = (options as vscode.PrepareLanguageModelChatModelOptions & {
      readonly configuration?: Record<string, unknown>;
    }).configuration;
    const configKey = JSON.stringify(configuration ?? {});
    if (!this._isActive) {
      logInfo(`[ModelInfo] call=${this._modelInfoCallCount} inactive -> 0 models`);
      return [];
    }

    if (this._activeModelConfigKey === undefined) {
      this._activeModelConfigKey = configKey;
    } else if (this._activeModelConfigKey !== configKey) {
      logInfo(
        `[ModelInfo] call=${this._modelInfoCallCount} skipped alternate-config active=${this._activeModelConfigKey} current=${configKey}`
      );
      return [];
    }

    const describeModels = (models: readonly LanguageModelChatInformation[]): string =>
      models.map((model) => `${model.id}|${model.name}|${model.family}`).join(',');

    if (this._modelInfoCache) {
      logInfo(
        `[ModelInfo] call=${this._modelInfoCallCount} config=${configKey} cache-hit count=${this._modelInfoCache.length} models=${describeModels(this._modelInfoCache)}`
      );
      return this._modelInfoCache;
    }

    const infos = await this.modelsService.prepareLanguageModelChatInformation(this.secrets, options, token);
    const seenIds = new Set<string>();
    const uniqueInfos: LanguageModelChatInformation[] = [];
    for (const info of infos) {
      if (seenIds.has(info.id)) {
        continue;
      }
      seenIds.add(info.id);
      uniqueInfos.push(info);
    }

    this._modelInfoCache = uniqueInfos;
    logInfo(
      `[ModelInfo] call=${this._modelInfoCallCount} config=${configKey} built count=${uniqueInfos.length} models=${describeModels(uniqueInfos)}`
    );
    return uniqueInfos;
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
    const configEffortRaw =
      options.modelConfiguration?.reasoningEffort ??
      (options as vscode.ProvideLanguageModelChatResponseOptions & {
        readonly configuration?: Record<string, unknown>;
      }).configuration?.reasoningEffort;
    const configVariantRaw =
      options.modelConfiguration?.modelVariant ??
      (options as vscode.ProvideLanguageModelChatResponseOptions & {
        readonly configuration?: Record<string, unknown>;
      }).configuration?.modelVariant;
    const selectedApiModelId = resolveModelVariant(baseModelId, configVariantRaw);
    const configEffort =
      typeof configEffortRaw === 'string' && VALID_REASONING_EFFORTS.has(configEffortRaw)
        ? (configEffortRaw as ReasoningEffort)
        : undefined;
    const selectedEffort = configEffort ?? suffixEffort ?? getModelReasoningEffort(baseModelId);
    const modelSupportsThinking = reasoningModelIds.has(baseModelId);
    const shouldShowThinking = modelSupportsThinking && selectedEffort !== 'none';

    const temperature = getModelTemperature(baseModelId);
    let disableReasoningEffortForRequest = false;
    let forceNonStreamingForRequest = false;
    const hasTools = !!(options.tools && options.tools.length > 0);

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
      let emittedAnyPart = false;
      let usedStreamOnAttempt = false;

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
        const builtMessages = await buildOpenAIMessages(messages);
        const openaiMessages = truncateOpenAIMessages(builtMessages, baseModelId);

        // Detect vision requests (any message with array content = image_url format)
        const hasVisionContent = openaiMessages.some((m) => Array.isArray(m.content));
        // CrofAI vision API bug: system messages + stream=true returns 0 tokens.
        // Fall back to non-streaming for vision requests as a workaround.
        const useStream = !hasVisionContent && !forceNonStreamingForRequest;
        usedStreamOnAttempt = useStream;

        const requestBody: Record<string, unknown> = {
          model: selectedApiModelId,
          messages: openaiMessages,
          stream: useStream,
          max_tokens: getModelMaxOutputTokens(selectedApiModelId),
        };
        if (temperature !== undefined) requestBody.temperature = temperature;
        // Only send reasoning_effort for models that explicitly support reasoning.
        if (modelSupportsThinking && selectedEffort && !disableReasoningEffortForRequest) {
          requestBody.reasoning_effort = selectedEffort;
        }
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
        logInfo(`[Request]${visionTag} model=${baseModelId} apiModel=${selectedApiModelId} stream=${useStream} messages=${openaiMessages.length} totalChars=${totalMessageChars} roles=[${roleSequence}]`);
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
          emittedAnyPart = emitNonStreamingCompletion(payload, progress, shouldShowThinking);
          logInfo(`[NonStreaming] emitNonStreamingCompletion returned emitted=${emittedAnyPart}`);
          logRequestEnd({
            model: baseModelId,
            ttfms: Date.now() - startMs,
            promptTokens,
            completionTokens,
            totalTokens,
            retries,
          });

          if (!emittedAnyPart) {
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
          emittedAnyPart = true;
          progress.report(new vscode.LanguageModelTextPart(reasoningBuffer));
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
            logInfo(`[Stream] done totalBytes=${totalBytesReceived} emittedAnyPart=${emittedAnyPart}`);
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
                emittedAnyPart = true;
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
                  emittedAnyPart = true;
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
          const args = parseToolArgumentsOrThrow(tc.arguments, tc.name, 'stream-trailing');
          emittedAnyPart = true;
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
        if (!emittedAnyPart) {
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
        const isMalformedToolCallError = errorMsg.includes('Malformed tool call arguments');
        const isEmptyStreamError = errorMsg.includes('Empty response stream from CrofAI');
        logError(`[Catch] model=${baseModelId} attempt=${retries}/${MAX_RETRIES} emittedAnyPart=${emittedAnyPart} error=${errorMsg} stack=${errorStack ?? '(no stack)'}`);

        if (isAbortError(error)) {
          // User cancelled — not an error
          return;
        }

        // If we already emitted content, preserve the partial answer instead of
        // converting it into a hard failure due to a late stream/provider error.
        if (emittedAnyPart && !isMalformedToolCallError) {
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

        // Malformed tool call arguments are payload issues and retries won't help.
        if (isMalformedToolCallError) {
          break;
        }

        // Empty streams are provider payload failures; retries waste request quota.
        if (isEmptyStreamError) {
          break;
        }

        if (
          isServerGenerationError(errorMsg) &&
          modelSupportsThinking &&
          selectedEffort &&
          !disableReasoningEffortForRequest
        ) {
          disableReasoningEffortForRequest = true;
          retries++;
          logWarn(
            `[RetryMode] model=${baseModelId} disabling reasoning_effort after generation error: ${errorMsg}`
          );
          continue;
        }

        if (
          isServerGenerationError(errorMsg) &&
          usedStreamOnAttempt &&
          !forceNonStreamingForRequest &&
          !hasTools
        ) {
          forceNonStreamingForRequest = true;
          retries++;
          logWarn(
            `[RetryMode] model=${baseModelId} forcing non-stream retry after streaming generation error: ${errorMsg}`
          );
          continue;
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
