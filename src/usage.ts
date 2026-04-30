import * as vscode from 'vscode';
import { z } from 'zod';

export const UsageResponseSchema = z.object({
  usable_requests: z.number().nullable(),
  credits: z.number(),
});

export type UsageResponse = z.infer<typeof UsageResponseSchema>;

const USAGE_API_URL = 'https://crof.ai/usage_api/';
const STATUS_BAR_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_USAGE_TIMEOUT_MS = 15_000;

export class CrofAIUsageService {
  constructor(private readonly userAgent: string) {}

  async fetchUsage(apiKey: string): Promise<UsageResponse | null> {
    try {
      const response = await fetch(USAGE_API_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(FETCH_USAGE_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const result = UsageResponseSchema.safeParse(data);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  formatCredits(credits: number): string {
    return `$${credits.toFixed(2)}`;
  }
}

export function createUsageStatusBar(
  context: vscode.ExtensionContext,
  usageService: CrofAIUsageService
): { statusBarItem: vscode.StatusBarItem; updateStatus: () => void } {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'crofai.showUsage';
  context.subscriptions.push(statusBarItem);

  let running = false;
  let queued = false;

  const runUpdate = async () => {
    const apiKey = await context.secrets.get('crofai.apiKey');
    if (!apiKey) {
      statusBarItem.text = '$(pulse) CrofAI';
      statusBarItem.tooltip = 'CrofAI Provider - Click Manage to configure';
      statusBarItem.show();
      return;
    }

    const usage = await usageService.fetchUsage(apiKey);
    if (usage) {
      const credits = usageService.formatCredits(usage.credits);
      if (usage.usable_requests !== null) {
        statusBarItem.text = `$(pulse) CrofAI: ${credits} (${usage.usable_requests} req)`;
        statusBarItem.tooltip = `CrofAI Usage\nCredits: ${credits}\nRequests left: ${usage.usable_requests}`;
      } else {
        statusBarItem.text = `$(pulse) CrofAI: ${credits}`;
        statusBarItem.tooltip = `CrofAI Usage\nCredits: ${credits}`;
      }
    } else {
      statusBarItem.text = '$(pulse) CrofAI';
      statusBarItem.tooltip = 'CrofAI Provider';
    }
    statusBarItem.show();
  };

  const updateStatus = () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    queued = false;
    runUpdate().finally(() => {
      running = false;
      if (queued) {
        updateStatus();
      }
    });
  };

  updateStatus();
  const interval = setInterval(updateStatus, STATUS_BAR_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  return { statusBarItem, updateStatus };
}
