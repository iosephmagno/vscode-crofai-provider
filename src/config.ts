import * as vscode from 'vscode';
import type { CrofAIModel, ReasoningEffort } from './types.js';
import type { CrofAIModelsService } from './models.js';

export function getModelTemperature(modelId: string): number | undefined {
  const config = vscode.workspace.getConfiguration('crofai');
  const temperatures = config.get<Record<string, number>>('modelTemperatures');
  return temperatures?.[modelId];
}

export async function setModelTemperature(
  modelId: string,
  temperature: number | undefined
): Promise<void> {
  const config = vscode.workspace.getConfiguration('crofai');
  const existing = config.get<Record<string, number>>('modelTemperatures') || {};
  const temperatures: Record<string, number> = { ...existing };

  if (temperature === undefined) {
    delete temperatures[modelId];
  } else {
    temperatures[modelId] = temperature;
  }

  await config.update('modelTemperatures', temperatures, vscode.ConfigurationTarget.Global);
}

export function getModelReasoningEffort(modelId: string): ReasoningEffort | undefined {
  const config = vscode.workspace.getConfiguration('crofai');
  const efforts = config.get<Record<string, ReasoningEffort>>('modelReasoningEfforts');
  return efforts?.[modelId];
}

export async function setModelReasoningEffort(
  modelId: string,
  effort: ReasoningEffort | undefined
): Promise<void> {
  const config = vscode.workspace.getConfiguration('crofai');
  const existing = config.get<Record<string, ReasoningEffort>>('modelReasoningEfforts') || {};
  const efforts: Record<string, ReasoningEffort> = { ...existing };

  if (effort === undefined) {
    delete efforts[modelId];
  } else {
    efforts[modelId] = effort;
  }

  await config.update('modelReasoningEfforts', efforts, vscode.ConfigurationTarget.Global);
}

export async function showReasoningConfigUI(
  secrets: vscode.SecretStorage,
  modelsService: CrofAIModelsService
): Promise<void> {
  const apiKey = await modelsService.ensureApiKey(secrets, false);
  if (!apiKey) {
    vscode.window.showInformationMessage('Please configure your CrofAI API key first.');
    return;
  }

  try {
    const response = await modelsService.fetchModels(apiKey);
    if (!response?.data || response.data.length === 0) {
      vscode.window.showInformationMessage('No models available.');
      return;
    }

    const reasoningModels = response.data.filter(
      (m) => m.custom_reasoning === true || m.reasoning_effort === true
    );

    if (reasoningModels.length === 0) {
      vscode.window.showInformationMessage('No reasoning models available.');
      return;
    }

    interface ModelItem {
      label: string;
      description: string;
      modelId: string;
    }

    const modelItems: ModelItem[] = reasoningModels.map((m: CrofAIModel) => {
      const stored = getModelReasoningEffort(m.id);
      return {
        label: m.name || m.id,
        description: stored ? `$(gear) ${stored}` : '$(circle-outline) default',
        modelId: m.id,
      };
    });

    const selectedModel = await vscode.window.showQuickPick(modelItems, {
      placeHolder: 'Select a model to configure reasoning effort',
      ignoreFocusOut: true,
    });

    if (!selectedModel) {
      return;
    }

    const current = getModelReasoningEffort(selectedModel.modelId);

    interface EffortItem {
      label: string;
      description?: string;
      detail?: string;
      value: ReasoningEffort | undefined;
    }

    const effortItems: EffortItem[] = [
      {
        label: current === undefined ? '$(check) Default' : 'Default',
        description: 'inherited from model variant selection',
        detail:
          'Use whichever reasoning effort is encoded in the selected model variant (e.g. model#high)',
        value: undefined,
      },
      {
        label: current === 'none' ? '$(check) None' : 'None',
        description: 'no thinking tokens',
        detail: 'Disables reasoning regardless of model variant — fastest, lowest cost',
        value: 'none' as ReasoningEffort,
      },
      {
        label: current === 'low' ? '$(check) Low' : 'Low',
        description: 'brief reasoning pass',
        detail: 'Short reasoning chain — good balance for simple tasks',
        value: 'low' as ReasoningEffort,
      },
      {
        label: current === 'medium' ? '$(check) Medium' : 'Medium',
        description: 'standard reasoning depth',
        detail: 'Balanced reasoning — recommended for most tasks',
        value: 'medium' as ReasoningEffort,
      },
      {
        label: current === 'high' ? '$(check) High' : 'High',
        description: 'deep reasoning chain',
        detail: 'Maximum thinking tokens — best for complex problems, highest cost',
        value: 'high' as ReasoningEffort,
      },
    ];

    const selectedEffort = await vscode.window.showQuickPick(effortItems, {
      placeHolder: `${selectedModel.label} — current: ${current ?? 'default'}`,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });

    if (selectedEffort === undefined) {
      return;
    }

    await setModelReasoningEffort(selectedModel.modelId, selectedEffort.value);
    vscode.window.showInformationMessage(
      selectedEffort.value
        ? `Reasoning effort for ${selectedModel.modelId} set to ${selectedEffort.value}.`
        : `Reasoning effort for ${selectedModel.modelId} reset to default.`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Failed to configure reasoning effort: ${errorMessage}`);
  }
}

export async function showTemperatureConfigUI(
  secrets: vscode.SecretStorage,
  modelsService: CrofAIModelsService
): Promise<void> {
  const apiKey = await modelsService.ensureApiKey(secrets, false);
  if (!apiKey) {
    vscode.window.showInformationMessage('Please configure your CrofAI API key first.');
    return;
  }

  try {
    const response = await modelsService.fetchModels(apiKey);
    if (!response?.data || response.data.length === 0) {
      vscode.window.showInformationMessage('No models available.');
      return;
    }

    interface ModelItem {
      label: string;
      description: string;
      modelId: string;
    }

    const modelItems: ModelItem[] = response.data.map((m: CrofAIModel) => ({
      label: m.name || m.id,
      description: getModelTemperature(m.id)?.toFixed(2) || 'Default',
      modelId: m.id,
    }));

    const selectedModel = await vscode.window.showQuickPick(modelItems, {
      placeHolder: 'Select a model to configure temperature',
      ignoreFocusOut: true,
    });

    if (!selectedModel) {
      return;
    }

    const currentTemp = getModelTemperature(selectedModel.modelId);
    const temperatureInput = await vscode.window.showInputBox({
      title: `Set Temperature for ${selectedModel.modelId}`,
      prompt: 'Enter temperature value (0-2, or leave empty to use default)',
      value: currentTemp?.toString() || '',
      validateInput: (value) => {
        if (value === '') {
          return null;
        }
        const num = parseFloat(value);
        if (isNaN(num)) {
          return 'Please enter a valid number';
        }
        if (num < 0 || num > 2) {
          return 'Temperature must be between 0 and 2';
        }
        return null;
      },
      ignoreFocusOut: true,
    });

    if (temperatureInput === undefined) {
      return;
    }

    const temperature = temperatureInput === '' ? undefined : parseFloat(temperatureInput);
    await setModelTemperature(selectedModel.modelId, temperature);

    if (temperature === undefined) {
      vscode.window.showInformationMessage(
        `Temperature for ${selectedModel.modelId} reset to default.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Temperature for ${selectedModel.modelId} set to ${temperature}.`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Failed to configure temperature: ${errorMessage}`);
  }
}
