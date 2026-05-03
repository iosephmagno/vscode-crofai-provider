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

const REASONING_ID_SUFFIX_REGEX = /(?:[#:_-])(none|low|medium|high)(?:[-_ ]?(?:thinking|reasoning|effort))?$/i;
const REASONING_ALIAS_SUFFIX_REGEX = /(?:[#:_-])(thinking|reasoning|reasoner)(?:[-_ ]?(?:default|medium))?$/i;
// Keep first-panel entries 1:1 with API model IDs (no variant collapsing).
const MODEL_VARIANT_SUFFIXES: readonly string[] = [];

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

function getGroupedModelId(modelId: string): string {
  const { baseModelId } = getEffortFromModelId(modelId);
  return baseModelId
    .replace(REASONING_ID_SUFFIX_REGEX, '')
    .replace(REASONING_ALIAS_SUFFIX_REGEX, '');
}

function getGroupedModelIdWithVariants(modelId: string, knownModelIds: Set<string>): string {
  const canonicalId = getGroupedModelId(modelId);
  const lowerCanonicalId = canonicalId.toLowerCase();

  for (const suffix of MODEL_VARIANT_SUFFIXES) {
    const variantSuffix = `-${suffix}`;
    if (!lowerCanonicalId.endsWith(variantSuffix)) {
      continue;
    }

    const candidateBase = canonicalId.slice(0, -variantSuffix.length);
    if (knownModelIds.has(candidateBase.toLowerCase())) {
      return candidateBase;
    }
  }

  return canonicalId;
}

function getVariantLabel(groupId: string, variantId: string): string {
  if (variantId === groupId) {
    return 'Standard';
  }

  const lowerGroupId = groupId.toLowerCase();
  const lowerVariantId = variantId.toLowerCase();
  const prefix = `${lowerGroupId}-`;

  if (lowerVariantId.startsWith(prefix)) {
    const suffix = variantId.slice(groupId.length + 1);
    return suffix
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  return variantId;
}

export function supportsReasoningEffort(model: Pick<CrofAIModel, 'id' | 'name' | 'custom_reasoning' | 'reasoning_effort'>): boolean {
  if (model.custom_reasoning === true || model.reasoning_effort === true) {
    return true;
  }

  const id = model.id.toLowerCase();
  const name = (model.name || '').toLowerCase();
  const hintText = `${id} ${name}`;

  if (REASONING_ID_SUFFIX_REGEX.test(id) || REASONING_ALIAS_SUFFIX_REGEX.test(id)) {
    return true;
  }

  // CrofAI often labels DeepSeek v4 Pro variants as fixed-medium even when
  // explicit capability flags are missing in /v1/models.
  if (id.includes('deepseek-v4-pro') || name.includes('deepseek v4 pro')) {
    return true;
  }

  return hintText.includes('reasoning');
}

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_MODELS_MAX_RETRIES = 2;
const FETCH_MODELS_BASE_DELAY_MS = 500;
const FETCH_MODELS_TIMEOUT_MS = 30_000;

const modelMaxOutputTokens = new Map<string, number>();
const groupedModelVariantIds = new Map<string, Set<string>>();
const groupedModelDefaultVariant = new Map<string, string>();

/** Set of model IDs that have actual reasoning/thinking capability (custom_reasoning or reasoning_effort). */
export const reasoningModelIds = new Set<string>();

export function getModelMaxOutputTokens(modelId: string): number {
  return modelMaxOutputTokens.get(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

export function resolveModelVariant(groupedModelId: string, configuredVariant: unknown): string {
  const variants = groupedModelVariantIds.get(groupedModelId);
  if (typeof configuredVariant === 'string' && variants?.has(configuredVariant)) {
    return configuredVariant;
  }
  return groupedModelDefaultVariant.get(groupedModelId) ?? groupedModelId;
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
    groupedModelVariantIds.clear();
    groupedModelDefaultVariant.clear();
    const result: LanguageModelChatInformation[] = [];

    type GroupedModel = {
      id: string;
      modelName: string;
      family: string;
      contextLength: number;
      maxTokens: number;
      supportsVision: boolean;
      supportsThinking: boolean;
      pricingBadge: string;
      isFree: boolean;
      quantization?: string;
      speed?: number;
      aliases: Set<string>;
      defaultVariantId: string;
    };

    const knownModelIds = new Set(models.data.map((model) => getGroupedModelId(model.id).toLowerCase()));
    const seenModelIds = new Set<string>();
    const groupedModels = new Map<string, GroupedModel>();

    for (const model of models.data) {
      const normalizedModelId = model.id.toLowerCase();
      if (seenModelIds.has(normalizedModelId)) {
        continue;
      }
      seenModelIds.add(normalizedModelId);

      const groupedId = getGroupedModelIdWithVariants(model.id, knownModelIds);
      const modelName = model.name || groupedId;
      const contextLength = model.context_length || DEFAULT_CONTEXT_LENGTH;
      const maxTokens = model.max_completion_tokens || DEFAULT_MAX_OUTPUT_TOKENS;
      const supportsVision = isVisionModel(model);
      const supportsThinking = supportsReasoningEffort(model);
      const family = getModelFamily(groupedId);
      const pricingBadge = formatPricingBadge(model.pricing);
      const isFree = pricingBadge === 'Free';

      const existing = groupedModels.get(groupedId);
      if (existing) {
        existing.maxTokens = Math.max(existing.maxTokens, maxTokens);
        existing.contextLength = Math.max(existing.contextLength, contextLength);
        existing.supportsVision = existing.supportsVision || supportsVision;
        existing.supportsThinking = existing.supportsThinking || supportsThinking;
        existing.aliases.add(model.id);
        if (model.id === groupedId) {
          existing.defaultVariantId = model.id;
        }
        continue;
      }

      groupedModels.set(groupedId, {
        id: groupedId,
        modelName,
        family,
        contextLength,
        maxTokens,
        supportsVision,
        supportsThinking,
        pricingBadge,
        isFree,
        quantization: model.quantization,
        speed: model.speed,
        aliases: new Set([model.id]),
        defaultVariantId: model.id,
      });
    }

    for (const groupedModel of groupedModels.values()) {
      const variantIds = [...groupedModel.aliases].sort((a, b) => {
        if (a === groupedModel.id) return -1;
        if (b === groupedModel.id) return 1;
        return a.localeCompare(b);
      });
      const defaultVariantId = variantIds.includes(groupedModel.id)
        ? groupedModel.id
        : groupedModel.defaultVariantId;

      groupedModelVariantIds.set(groupedModel.id, new Set(variantIds));
      groupedModelDefaultVariant.set(groupedModel.id, defaultVariantId);

      modelMaxOutputTokens.set(groupedModel.id, groupedModel.maxTokens);
      for (const aliasId of groupedModel.aliases) {
        modelMaxOutputTokens.set(aliasId, groupedModel.maxTokens);
      }
      if (groupedModel.supportsThinking) {
        reasoningModelIds.add(groupedModel.id);
        for (const aliasId of groupedModel.aliases) {
          reasoningModelIds.add(aliasId);
        }
      }

      const detailParts = ['CrofAI'];
      if (groupedModel.isFree) detailParts.push('Free');
      if (groupedModel.quantization) detailParts.push(groupedModel.quantization);

      const tooltipParts: string[] = [groupedModel.modelName];
      if (groupedModel.pricingBadge) tooltipParts.push(groupedModel.pricingBadge);
      if (groupedModel.supportsThinking) tooltipParts.push('Reasoning');
      if (groupedModel.supportsVision) tooltipParts.push('Vision');
      if (groupedModel.quantization) tooltipParts.push(groupedModel.quantization);
      if (groupedModel.speed !== undefined) tooltipParts.push(`Speed ${groupedModel.speed}`);

      const schemaProperties: Record<string, Record<string, unknown>> = {};
      if (groupedModel.supportsThinking) {
        schemaProperties.reasoningEffort = REASONING_CONFIGURATION_SCHEMA.properties.reasoningEffort;
      }
      if (variantIds.length > 1) {
        schemaProperties.modelVariant = {
          type: 'string',
          enum: variantIds,
          enumItemLabels: variantIds.map((variantId) => getVariantLabel(groupedModel.id, variantId)),
          default: defaultVariantId,
          group: 'navigation',
          description: 'Model variant for this family',
        };
      }

      const configurationSchema =
        Object.keys(schemaProperties).length > 0
          ? {
              type: 'object',
              additionalProperties: false,
              properties: schemaProperties,
            }
          : undefined;

      if (groupedModel.supportsThinking) {
        result.push({
          id: groupedModel.id,
          name: groupedModel.modelName,
          tooltip: tooltipParts.join(' • '),
          family: groupedModel.family,
          detail: detailParts.join(' • '),
          version: '1.0.0',
          maxInputTokens: groupedModel.contextLength,
          maxOutputTokens: 0,
          capabilities: {
            toolCalling: true,
            imageInput: true,
          },
          isUserSelectable: true,
          category: { label: 'CrofAI', order: 2 },
          configurationSchema,
        } satisfies LanguageModelChatInformation);
      } else {
        result.push({
          id: groupedModel.id,
          name: groupedModel.modelName,
          tooltip: tooltipParts.join(' • '),
          family: groupedModel.family,
          detail: detailParts.join(' • '),
          version: '1.0.0',
          maxInputTokens: groupedModel.contextLength,
          maxOutputTokens: 0,
          capabilities: {
            toolCalling: true,
            imageInput: true, // all models support file attachment via Litterbox upload
          },
          isUserSelectable: true,
          category: { label: 'CrofAI', order: 2 },
          configurationSchema,
        } satisfies LanguageModelChatInformation);
      }
    }

    // Defensive final pass: ensure unique IDs and avoid identical display names.
    const seenIds = new Set<string>();
    const uniqueResult: LanguageModelChatInformation[] = [];
    for (const info of result) {
      if (seenIds.has(info.id)) {
        continue;
      }
      seenIds.add(info.id);
      uniqueResult.push(info);
    }
    const nameCounts = new Map<string, number>();
    for (const info of uniqueResult) {
      const key = info.name.toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }

    return uniqueResult.map((info) => {
      const key = info.name.toLowerCase();
      if ((nameCounts.get(key) ?? 0) <= 1) {
        return info;
      }
      return {
        ...info,
        name: `${info.name} (${info.id})`,
      };
    });
  }
}
