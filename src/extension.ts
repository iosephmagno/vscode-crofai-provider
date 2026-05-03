import * as vscode from 'vscode';
import { CrofAIChatModelProvider } from './provider.js';
import { CrofAIModelsService } from './models.js';
import { showTemperatureConfigUI, showReasoningConfigUI } from './config.js';
import { CrofAIUsageService, createUsageStatusBar } from './usage.js';
import { getOutputChannel, disposeOutputChannel } from './logger.js';
import { imageServer } from './imageServer.js';

let activeProvider: CrofAIChatModelProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  if (activeProvider) {
    return;
  }

  const ext = vscode.extensions.getExtension('CrofAI.crof-ai-provider');
  const extVersion = ext?.packageJSON?.version ?? 'unknown';
  const vscodeVersion = vscode.version;
  const ua = `crof-ai-provider/${extVersion} VSCode/${vscodeVersion}`;

  const modelsService = new CrofAIModelsService(ua);
  const provider = new CrofAIChatModelProvider(context.secrets, ua, modelsService);
  activeProvider = provider;
  const usageService = new CrofAIUsageService(ua);

  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('crofai', provider));
  // Force Copilot Chat to re-query model metadata instead of relying on cached entries.
  // Use a single refresh path to avoid duplicate first-panel entries from rapid multi-fire events.
  void provider.refreshModelPickerCache();
  context.subscriptions.push(provider);
  context.subscriptions.push({ dispose: disposeOutputChannel });
  getOutputChannel(); // initialize early so it appears in Output panel

  // Image hosting via 0x0.st — no local server needed, images are uploaded
  // on demand and auto-expire after 1 hour.
  imageServer.start().then((url) => {
    getOutputChannel().info('[CrofAI] Image upload service ready via ' + url);
  }).catch((err) => {
    getOutputChannel().error('[CrofAI] Image upload service failed: ' + (err instanceof Error ? err.message : String(err)));
  });

  const { updateStatus } = createUsageStatusBar(context, usageService);

  // Show setup walkthrough on first install (no API key stored yet)
  context.secrets.get('crofai.apiKey').then((key) => {
    if (!key) {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'CrofAI.crof-ai-provider#crofai.setup',
        false
      );
    }
  });

  // Refresh models and status bar when the API key changes (e.g. from another window)
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key === 'crofai.apiKey') {
        modelsService.invalidateCache();
        void provider.refreshModelPickerCache();
        updateStatus();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crofai.showUsage', async () => {
      const apiKey = await context.secrets.get('crofai.apiKey');
      if (!apiKey) {
        vscode.window.showInformationMessage('Please configure your CrofAI API key first.');
        return;
      }

      const usage = await usageService.fetchUsage(apiKey);
      if (!usage) {
        vscode.window.showErrorMessage('Failed to fetch usage data.');
        return;
      }

      let message = `**CrofAI Usage**\n\nCredits: $${usage.credits.toFixed(4)}`;
      if (usage.usable_requests !== null) {
        message += `\nRequests left today: ${usage.usable_requests}`;
      }
      vscode.window.showInformationMessage(message);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crofai.manage', async () => {
      const existing = await context.secrets.get('crofai.apiKey');
      const apiKey = await vscode.window.showInputBox({
        title: 'CrofAI API Key',
        prompt: existing ? 'Update your CrofAI API key' : 'Enter your CrofAI API key',
        ignoreFocusOut: true,
        password: true,
        value: existing ?? '',
      });

      if (apiKey === undefined) {
        return;
      }

      if (!apiKey.trim()) {
        await context.secrets.delete('crofai.apiKey');
        vscode.window.showInformationMessage('CrofAI API key cleared.');
      } else {
        await context.secrets.store('crofai.apiKey', apiKey.trim());
        vscode.window.showInformationMessage('CrofAI API key saved.');
      }

      // Refresh models and status bar immediately — don't wait for secrets.onDidChange
      modelsService.invalidateCache();
      await provider.refreshModelPickerCache();
      updateStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crofai.configureTemperature', async () => {
      await showTemperatureConfigUI(context.secrets, modelsService);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crofai.configureReasoning', async () => {
      await showReasoningConfigUI(context.secrets, modelsService);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crofai.refreshModels', async () => {
      modelsService.invalidateCache();
      await provider.refreshModelPickerCache();
      vscode.window.showInformationMessage('CrofAI models refreshed.');
    })
  );
}

export async function deactivate() {
  if (activeProvider) {
    await activeProvider.prepareForDeactivate();
    activeProvider = undefined;
  }
  imageServer.dispose();
}
