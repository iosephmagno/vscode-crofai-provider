import { z } from 'zod';

export const CrofAIModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  created: z.number().optional(),
  pricing: z
    .object({
      prompt: z.string(),
      completion: z.string(),
      cache_prompt: z.string().optional(),
    })
    .optional(),
  quantization: z.string().optional(),
  speed: z.number().optional(),
  custom_reasoning: z.boolean().optional(),
  reasoning_effort: z.boolean().optional(),
  vision: z.boolean().optional(),
});

export type CrofAIModel = z.infer<typeof CrofAIModelSchema>;

export const CrofAIModelsResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(CrofAIModelSchema),
});

export type CrofAIModelsResponse = z.infer<typeof CrofAIModelsResponseSchema>;

export const DEFAULT_CONTEXT_LENGTH = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

export interface CrofAIModelInfo {
  id: string;
  name: string;
  tooltip: string;
  family: string;
  detail: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: {
    toolCalling: boolean;
    imageInput: boolean;
    supportsThinking: boolean;
  };
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface ModelConfig {
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}
