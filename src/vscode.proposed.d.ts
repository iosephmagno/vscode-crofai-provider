/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Proposed APIs for LanguageModelThinkingPart and LanguageModelChatProvider extensions
// version: 4

declare module 'vscode' {
  /**
   * A language model response part containing thinking/reasoning content.
   * Thinking tokens represent the model's internal reasoning process that
   * typically streams before the final response.
   */
  export class LanguageModelThinkingPart {
    value: string | string[];
    id?: string;
    metadata?: { readonly [key: string]: any };

    constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: any });
  }

  /**
   * A language model response part containing a data (file/image) payload.
   * Used to attach images or other binary data to a chat message.
   */
  export class LanguageModelDataPart {
    readonly mimeType: string;
    readonly data: Uint8Array;

    constructor(mimeType: string, data: Uint8Array);
  }

  /**
   * Extended response part types
   */
  export type LanguageModelResponsePart2 =
    | LanguageModelTextPart
    | LanguageModelThinkingPart
    | LanguageModelToolCallPart
    | LanguageModelToolResultPart
    | unknown;

  /**
   * A JSON Schema describing per-model configuration options.
   * Properties with group:'navigation' appear as quick-access buttons
   * directly in the model picker UI.
   */
  export type LanguageModelConfigurationSchema = {
    readonly properties?: {
      readonly [key: string]: Record<string, unknown> & {
        /** Human-readable labels for enum values (same length/order as enum). */
        readonly enumItemLabels?: string[];
        /**
         * When set to 'navigation', the property appears as a primary action
         * button inside the model picker (not just in settings).
         */
        readonly group?: string;
      };
    };
  };

  export interface LanguageModelChatInformation {
    /**
     * Whether or not the model will show up in the model picker immediately
     * upon being made known via provideLanguageModelChatInformation.
     */
    readonly isUserSelectable?: boolean;

    /**
     * Optional category to group models by in the model picker.
     * The lower the order, the higher the category appears in the list.
     * Has no effect if `isUserSelectable` is false.
     *
     * WONT BE FINALIZED
     */
    readonly category?: { label: string; order: number };

    /** Optional icon shown in the model picker (e.g. ThemeIcon('warning')). */
    readonly statusIcon?: ThemeIcon;

    /**
     * Optional JSON schema for per-model configuration.
     * Values are provided in ProvideLanguageModelChatResponseOptions.modelConfiguration.
     */
    readonly configurationSchema?: LanguageModelConfigurationSchema;
  }

  export interface ProvideLanguageModelChatResponseOptions {
    /**
     * Per-model configuration resolved from the user's VS Code settings,
     * validated against the model's configurationSchema.
     */
    readonly modelConfiguration?: Record<string, unknown>;
  }
}
