import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;

export function getOutputChannel(): vscode.LogOutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('CrofAI Provider', { log: true });
  }
  return outputChannel;
}

export function disposeOutputChannel(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}

export function logInfo(message: string, ...args: unknown[]): void {
  getOutputChannel().info(message, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  getOutputChannel().warn(message, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  getOutputChannel().error(message, ...args);
}

export function logDebug(message: string, ...args: unknown[]): void {
  getOutputChannel().debug(message, ...args);
}

export function logRequestStart(model: string, messageCount: number): void {
  logInfo(`[Request] model=${model} messages=${messageCount}`);
}

export function logRequestEnd(opts: {
  model: string;
  ttfms: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  retries: number;
}): void {
  const usage =
    opts.totalTokens !== undefined
      ? ` prompt=${opts.promptTokens} completion=${opts.completionTokens} total=${opts.totalTokens}`
      : '';
  const retry = opts.retries > 0 ? ` retries=${opts.retries}` : '';
  logInfo(`[Response] model=${opts.model} ttf=${opts.ttfms}ms${usage}${retry}`);
}

export function logRequestError(model: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  logError(`[Error] model=${model} ${msg}`);
}
