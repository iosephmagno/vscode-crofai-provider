import * as vscode from 'vscode';
import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { tryit } from 'radash';
import {
  CrofAIModelsResponseSchema,
  type CrofAIModel,
  type CrofAIModelsResponse,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ReasoningEffort,
} from './types.js';

export const BASE_URL = 'https://crof.ai/v1';

const VISION_MODEL_PATTERNS = ['kimi', 'gemma', 'qwen'];

const REASONING_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];
const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'No Thinking',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Schema placed on each reasoning-capable model. The group:'navigation' property
 *  makes VS Code render the effort picker as a button directly in the model picker. */
const REASONING_CONFIGURATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reasoningEffort: {
      type: 'string',
      enum: REASONING_EFFORTS,
      enumItemLabels: REASONING_EFFORTS.map((e) => REASONING_EFFORT_LABELS[e]),
      default: 'medium',
      group: 'navigation',
      description: 'Reasoning effort level (controls thinking tokens)',
    },
  },
} as const;

function isVisionModel(model: CrofAIModel): boolean {
  if (model.vision === true) return true;
  const id = model.id.toLowerCase();
  return VISION_MODEL_PATTERNS.some((pattern) => id.includes(pattern));
}

/** Format per-token price string (e.g. "0.00000035") → "$0.35/M" */
function formatPricePerM(priceStr: string): string {
  const perToken = parseFloat(priceStr);
  if (isNaN(perToken) || perToken === 0) return 'Free';
  const perM = perToken * 1_000_000;
  return `$${perM % 1 === 0 ? perM.toFixed(0) : perM.toPrecision(3)}/M`;
}

/** Returns pricing badge: "Free" | "↑$0.35 ↓$1.70" */
function formatPricingBadge(pricing: { prompt: string; completion: string } | undefined): string {
  if (!pricing) return '';
  const inp = parseFloat(pricing.prompt);
  const out = parseFloat(pricing.completion);
  if (inp === 0 && out === 0) return 'Free';
  return `↑${formatPricePerM(pricing.prompt)} ↓${formatPricePerM(pricing.completion)}`;
}

function getModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('glm-')) return 'glm';
  if (id.startsWith('kimi')) return 'kimi';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('qwen')) return 'qwen';
  if (id.startsWith('gemma')) return 'gemma';
  if (id.startsWith('minimax')) return 'minimax';
  return 'crofai';
}

/** Strip effort suffix from model IDs (#none, #low, #medium, #high). */
export function getEffortFromModelId(modelId: string): {
  baseModelId: string;
  effort: ReasoningEffort | undefined;
} {
  for (const effort of REASONING_EFFORTS) {
    const suffix = `#${effort}`;
    if (modelId.endsWith(suffix)) {
      return {
        baseModelId: modelId.slice(0, -suffix.length),
        effort,
      };
    }
  }
  return { baseModelId: modelId, effort: undefined };
}

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_MODELS_MAX_RETRIES = 2;
const FETCH_MODELS_BASE_DELAY_MS = 500;
const FETCH_MODELS_TIMEOUT_MS = 30_000;

const modelMaxOutputTokens = new Map<string, number>();

/** Set of model IDs that have actual reasoning/thinking capability (custom_reasoning or reasoning_effort). */
export const reasoningModelIds = new Set<string>();

export function getModelMaxOutputTokens(modelId: string): number {
  return modelMaxOutputTokens.get(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

export class CrofAIModelsService {
  private _cache: { data: CrofAIModelsResponse; apiKey: string; expiresAt: number } | undefined;

  constructor(private readonly userAgent: string) {}

  invalidateCache(): void {
    this._cache = undefined;
  }

  async ensureApiKey(secrets: vscode.SecretStorage, silent: boolean): Promise<string | undefined> {
    let apiKey = await secrets.get('crofai.apiKey');
    if (!apiKey && !silent) {
      const entered = await vscode.window.showInputBox({
        title: 'CrofAI API Key',
        prompt: 'Enter your CrofAI API key',
        ignoreFocusOut: true,
        password: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await secrets.store('crofai.apiKey', apiKey);
      }
    }
    return apiKey;
  }

  async fetchModels(apiKey: string): Promise<CrofAIModelsResponse> {
    const now = Date.now();
    if (this._cache && this._cache.apiKey === apiKey && this._cache.expiresAt > now) {
      return this._cache.data;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= FETCH_MODELS_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = FETCH_MODELS_BASE_DELAY_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const response = await fetch(`${BASE_URL}/models`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': this.userAgent,
          },
          signal: AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[CrofAI Provider] Failed to fetch CrofAI models', {
            status: response.status,
            statusText: response.statusText,
            detail: errorText,
          });
          const err = new Error(
            `Failed to fetch CrofAI models: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
          );
          // Don't retry auth errors
          if (response.status === 401 || response.status === 403) {
            vscode.window.showInformationMessage(
              `Failed to fetch models from CrofAI (${response.status}): Please check your API key.`
            );
            throw err;
          }
          lastError = err;
          continue;
        }

        const rawData = await response.json();
        const [parseErr, data] = tryit(() => CrofAIModelsResponseSchema.parse(rawData))();
        if (parseErr) {
          console.error('[CrofAI Provider] Model data validation failed:', parseErr);
          vscode.window.showInformationMessage(
            'Failed to parse model data from CrofAI API. The API format may have changed.'
          );
          throw new Error(
            `Invalid API response: ${parseErr instanceof Error ? parseErr.message : 'Unknown error'}`
          );
        }

        if (!data?.data || data.data.length === 0) {
          throw new Error('No models available');
        }

        this._cache = { data, apiKey, expiresAt: Date.now() + MODELS_CACHE_TTL_MS };
        return data;
      } catch (error) {
        if (error instanceof Error) {
          // Don't retry parse/validation errors or auth errors
          if (
            error.message.startsWith('Invalid API response') ||
            error.message.startsWith('No models') ||
            error.message.includes('401') ||
            error.message.includes('403')
          ) {
            throw error;
          }
        }
        lastError = error;
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new Error('Unknown error fetching models');
  }

  async prepareLanguageModelChatInformation(
    secrets: vscode.SecretStorage,
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    const apiKey = await this.ensureApiKey(secrets, options.silent);
    if (!apiKey) {
      return [];
    }

    let models: CrofAIModelsResponse;
    try {
      models = await this.fetchModels(apiKey);
    } catch (error) {
      console.error('[CrofAI Provider] Failed to prepare model information:', error);
      if (!options.silent) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showInformationMessage(`Unable to load CrofAI models: ${errorMessage}`);
      }
      return [];
    }

    modelMaxOutputTokens.clear();
    reasoningModelIds.clear();
    const result: LanguageModelChatInformation[] = [];

    for (const model of models.data) {
      const modelName = model.name || model.id;
      const contextLength = model.context_length || DEFAULT_CONTEXT_LENGTH;
      const maxTokens = model.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS;
      modelMaxOutputTokens.set(model.id, maxTokens);
      const supportsVision = isVisionModel(model);
      const supportsThinking = model.custom_reasoning === true || model.reasoning_effort === true;
      if (supportsThinking) {
        reasoningModelIds.add(model.id);
      }
      const family = getModelFamily(model.id);
      const pricingBadge = formatPricingBadge(model.pricing);
      const isFree = pricingBadge === 'Free';

      const detailParts = ['CrofAI'];
      if (isFree) detailParts.push('Free');
      if (model.quantization) detailParts.push(model.quantization);

      const tooltipParts: string[] = [modelName];
      if (pricingBadge) tooltipParts.push(pricingBadge);
      if (supportsThinking) tooltipParts.push('Reasoning');
      if (supportsVision) tooltipParts.push('Vision');
      if (model.quantization) tooltipParts.push(model.quantization);
      if (model.speed !== undefined) tooltipParts.push(`Speed ${model.speed}`);

      if (supportsThinking) {
        // Register one entry per reasoning effort level so users can choose directly from the model picker.
        for (const effort of REASONING_EFFORTS) {
          const variantId = `${model.id}#${effort}`;
          const effortLabel = REASONING_EFFORT_LABELS[effort];
          const variantName = `${modelName} (${effortLabel})`;
          result.push({
            id: variantId,
            name: variantName,
            tooltip: [...tooltipParts, effortLabel].join(' • '),
            family,
            detail: detailParts.join(' • '),
            version: '1.0.0',
            maxInputTokens: contextLength,
            maxOutputTokens: 0,
            capabilities: {
              toolCalling: true,
              imageInput: true, // all models support file attachment via Litterbox upload
            },
            isUserSelectable: true,
            category: { label: 'CrofAI', order: 2 },
          } satisfies LanguageModelChatInformation);
        }
      } else {
        result.push({
          id: model.id,
          name: modelName,
          tooltip: tooltipParts.join(' • '),
          family,
          detail: detailParts.join(' • '),
          version: '1.0.0',
          maxInputTokens: contextLength,
          maxOutputTokens: 0,
          capabilities: {
            toolCalling: true,
          imageInput: true, // all models support file attachment via Litterbox upload
          },
          isUserSelectable: true,
          category: { label: 'CrofAI', order: 2 },
        } satisfies LanguageModelChatInformation);
      }
    }

    return result;
  }
}
