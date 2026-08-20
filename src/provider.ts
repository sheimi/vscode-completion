import { basename } from "node:path";
import * as vscode from "vscode";
import { CompletionApiError, requestCompletion } from "./api";
import { readApiKey, readRuntimeSettings } from "./config";
import { buildCompletionPrompt, normalizeCompletion } from "./prompt";
import {
  SharedRequestContext,
  SharedRequestCoordinator,
  waitForSharedResult,
} from "./requestCoordinator";
import { redactSecret } from "./security";
import { ApiCompletionOptions } from "./types";

export class InlineAiCompletionProvider
  implements vscode.InlineCompletionItemProvider, vscode.Disposable
{
  private readonly requests = new SharedRequestCoordinator<string | undefined>();
  private generation = 0;
  private cooldownUntil = 0;
  private setupNoticeVisible = false;
  private errorNoticeVisible = false;
  private lastErrorNoticeAt = 0;

  public constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const documentKey = document.uri.toString();
    if (token.isCancellationRequested) {
      return undefined;
    }
    if (!vscode.workspace.isTrusted) {
      this.requests.cancel(documentKey);
      return undefined;
    }

    let settings;
    try {
      settings = readRuntimeSettings(document.uri);
    } catch (error) {
      this.showSetupNotice(context, safeMessage(error));
      return undefined;
    }

    if (
      !settings.enabled ||
      settings.excludedLanguages.includes(document.languageId) ||
      (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic &&
        Date.now() < this.cooldownUntil)
    ) {
      return undefined;
    }
    if (!settings.model) {
      this.showSetupNotice(context, "A model has not been configured.");
      return undefined;
    }

    const subscriberController = new AbortController();
    const cancellation = token.onCancellationRequested(() =>
      subscriberController.abort(),
    );
    const generation = this.generation;
    const documentVersion = document.version;
    let apiKey = "";
    const isSubscriberCurrent = (): boolean =>
      !subscriberController.signal.aborted &&
      !token.isCancellationRequested &&
      !document.isClosed &&
      document.version === documentVersion &&
      this.generation === generation;

    try {
      const debounceMs =
        context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
          ? settings.debounceMs
          : 0;
      if (
        !(await waitForDelay(debounceMs, subscriberController.signal)) ||
        !isSubscriberCurrent()
      ) {
        return undefined;
      }

      apiKey = (await readApiKey(this.secrets, settings)) ?? "";
      if (!isSubscriberCurrent()) {
        return undefined;
      }
      if (!apiKey) {
        this.showSetupNotice(context, `No API key is stored for ${settings.baseUrl}.`);
        return undefined;
      }

      const sourceContext = extractSourceContext(
        document,
        position,
        settings.maxPrefixCharacters,
        settings.maxSuffixCharacters,
        context.selectedCompletionInfo,
      );
      const prompt = buildCompletionPrompt({
        languageId: document.languageId,
        fileName: displayFileName(document),
        prefix: sourceContext.prefix,
        suffix: sourceContext.suffix,
      });
      const options: ApiCompletionOptions = {
        apiFormat: settings.apiFormat,
        chatTokenField: settings.chatTokenField,
        baseUrl: settings.baseUrl,
        apiKey,
        model: settings.model,
        maxOutputTokens: settings.maxOutputTokens,
        prompt,
      };
      const sharedRequest = this.requests.request(
        documentKey,
        completionRequestKey(options, settings.requestTimeoutMs, generation),
        (requestContext) =>
          this.runCompletionRequest(
            options,
            settings.requestTimeoutMs,
            requestContext,
          ),
      );
      const rawCompletion = await waitForSharedResult(
        sharedRequest,
        subscriberController.signal,
      );

      if (!rawCompletion || !isSubscriberCurrent()) {
        return undefined;
      }

      const completion = normalizeCompletion(
        rawCompletion,
        settings.maxSuggestionCharacters,
      );
      if (!completion) {
        return undefined;
      }

      return [
        new vscode.InlineCompletionItem(
          sourceContext.insertionPrefix + completion,
          sourceContext.insertionRange,
        ),
      ];
    } catch (error) {
      if (!isAbortError(error) && !subscriberController.signal.aborted) {
        this.applyErrorCooldown(error);
        this.reportError(safeMessage(error), apiKey);
      }
      return undefined;
    } finally {
      cancellation.dispose();
    }
  }

  public reset(): void {
    this.generation += 1;
    this.requests.reset();
    this.cooldownUntil = 0;
  }

  public dispose(): void {
    this.reset();
  }

  private async runCompletionRequest(
    options: ApiCompletionOptions,
    requestTimeoutMs: number,
    context: SharedRequestContext,
  ): Promise<string | undefined> {
    if (context.signal.aborted) {
      return undefined;
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      if (!context.signal.aborted) {
        timedOut = true;
        context.abort();
      }
    }, requestTimeoutMs);

    try {
      const completion = await requestCompletion(options, context.signal);
      return context.signal.aborted ? undefined : completion;
    } catch (error) {
      if (timedOut) {
        this.reportError(
          `Completion request timed out after ${requestTimeoutMs} ms.`,
          options.apiKey,
        );
      } else if (!isAbortError(error) && !context.signal.aborted) {
        this.applyErrorCooldown(error);
        this.reportError(safeMessage(error), options.apiKey);
      }
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private showSetupNotice(
    context: vscode.InlineCompletionContext,
    reason: string,
  ): void {
    if (
      context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke ||
      this.setupNoticeVisible
    ) {
      return;
    }
    this.setupNoticeVisible = true;
    void vscode.window
      .showInformationMessage(
        `Inline AI Suggestions is not configured: ${reason}`,
        "Set Up",
      )
      .then((selection) => {
        this.setupNoticeVisible = false;
        if (selection === "Set Up") {
          void vscode.commands.executeCommand("inlineAi.setup");
        }
      });
  }

  private applyErrorCooldown(error: unknown): void {
    if (!(error instanceof CompletionApiError)) {
      return;
    }
    if (error.status === 401 || error.status === 403) {
      this.cooldownUntil = Date.now() + 60_000;
    } else if (error.status === 429) {
      this.cooldownUntil = Date.now() + 30_000;
    } else if (error.status !== undefined && error.status >= 500) {
      this.cooldownUntil = Date.now() + 5_000;
    }
  }

  private reportError(message: string, apiKey: string): void {
    const safe = redactSecret(message, apiKey)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .slice(0, 500);
    this.output.appendLine(`[${new Date().toISOString()}] ${safe}`);

    const now = Date.now();
    if (this.errorNoticeVisible || now - this.lastErrorNoticeAt < 30_000) {
      return;
    }
    this.lastErrorNoticeAt = now;
    this.errorNoticeVisible = true;
    void vscode.window
      .showWarningMessage(
        "Inline AI Suggestions could not get a completion.",
        "Show Output",
      )
      .then((selection) => {
        this.errorNoticeVisible = false;
        if (selection === "Show Output") {
          this.output.show(true);
        }
      });
  }
}

interface SourceContext {
  readonly prefix: string;
  readonly suffix: string;
  readonly insertionPrefix: string;
  readonly insertionRange: vscode.Range;
}

function extractSourceContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  maxPrefixCharacters: number,
  maxSuffixCharacters: number,
  selectedCompletionInfo: vscode.SelectedCompletionInfo | undefined,
): SourceContext {
  const lastLine = document.lineAt(document.lineCount - 1);
  const documentLength = document.offsetAt(lastLine.range.end);

  if (selectedCompletionInfo) {
    const selectedRange = document.validateRange(selectedCompletionInfo.range);
    const selectedStart = document.offsetAt(selectedRange.start);
    const selectedEnd = document.offsetAt(selectedRange.end);
    const selectedTextTail =
      maxPrefixCharacters > 0
        ? selectedCompletionInfo.text.slice(-maxPrefixCharacters)
        : "";
    const remainingPrefixCharacters = Math.max(
      0,
      maxPrefixCharacters - selectedTextTail.length,
    );
    const prefixStart = Math.max(0, selectedStart - remainingPrefixCharacters);
    const suffixEnd = Math.min(
      documentLength,
      selectedEnd + maxSuffixCharacters,
    );

    return {
      prefix:
        document.getText(
          new vscode.Range(document.positionAt(prefixStart), selectedRange.start),
        ) + selectedTextTail,
      suffix: document.getText(
        new vscode.Range(selectedRange.end, document.positionAt(suffixEnd)),
      ),
      insertionPrefix: selectedCompletionInfo.text,
      insertionRange: selectedRange,
    };
  }

  const cursorOffset = document.offsetAt(position);
  const prefixStart = Math.max(0, cursorOffset - maxPrefixCharacters);
  const suffixEnd = Math.min(documentLength, cursorOffset + maxSuffixCharacters);

  return {
    prefix: document.getText(
      new vscode.Range(document.positionAt(prefixStart), position),
    ),
    suffix: document.getText(
      new vscode.Range(position, document.positionAt(suffixEnd)),
    ),
    insertionPrefix: "",
    insertionRange: new vscode.Range(position, position),
  };
}

function displayFileName(document: vscode.TextDocument): string {
  if (vscode.workspace.getWorkspaceFolder(document.uri)) {
    return vscode.workspace.asRelativePath(document.uri, false);
  }
  return basename(document.fileName || document.uri.path) || "untitled";
}

function completionRequestKey(
  options: ApiCompletionOptions,
  requestTimeoutMs: number,
  generation: number,
): string {
  return JSON.stringify([
    options.apiFormat,
    options.chatTokenField,
    options.baseUrl,
    options.model,
    options.maxOutputTokens,
    options.prompt.system,
    options.prompt.user,
    requestTimeoutMs,
    generation,
  ]);
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  if (milliseconds <= 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown completion error.";
}
