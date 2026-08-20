import * as vscode from "vscode";
import {
  CONFIG_SECTION,
  deleteApiKey,
  readRuntimeSettings,
  storeApiKey,
} from "./config";
import { InlineAiCompletionProvider } from "./provider";
import { defaultBaseUrl, resolveBaseUrl } from "./security";
import { ApiFormat, isApiFormat } from "./types";

interface ApiFormatItem extends vscode.QuickPickItem {
  readonly apiFormat: ApiFormat;
}

const API_FORMAT_ITEMS: readonly ApiFormatItem[] = [
  {
    label: "OpenAI Responses API",
    description: "POST /responses",
    detail: "OpenAI's current Responses wire format",
    apiFormat: "openai-responses",
  },
  {
    label: "OpenAI Chat Completions",
    description: "POST /chat/completions",
    detail: "OpenAI-compatible Chat Completions wire format",
    apiFormat: "openai-chat",
  },
  {
    label: "Anthropic Messages (Claude)",
    description: "POST /messages",
    detail: "Anthropic Messages wire format",
    apiFormat: "anthropic-messages",
  },
];

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Inline AI Suggestions", { log: true });
  const provider = new InlineAiCompletionProvider(context.secrets, output);
  const selector: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "untitled" },
    { scheme: "vscode-remote" },
    { scheme: "vscode-notebook-cell" },
  ];

  context.subscriptions.push(
    output,
    provider,
    vscode.languages.registerInlineCompletionItemProvider(selector, provider),
    vscode.commands.registerCommand("inlineAi.setup", () =>
      setupProvider(context, provider),
    ),
    vscode.commands.registerCommand("inlineAi.setApiKey", () =>
      setApiKey(context, provider),
    ),
    vscode.commands.registerCommand("inlineAi.clearApiKey", () =>
      clearApiKey(context, provider),
    ),
    vscode.commands.registerCommand("inlineAi.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id}`,
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        provider.reset();
      }
    }),
    context.secrets.onDidChange(() => provider.reset()),
  );
}

export function deactivate(): void {
  // Disposables registered in the extension context handle shutdown.
}

async function setupProvider(
  context: vscode.ExtensionContext,
  provider: InlineAiCompletionProvider,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredFormat = config.get<unknown>("apiFormat");
  const selected = await vscode.window.showQuickPick(API_FORMAT_ITEMS, {
    title: "Set Up Inline AI Suggestions",
    placeHolder: "Choose the API wire format",
    ignoreFocusOut: true,
  });
  if (!selected) {
    return;
  }

  const configuredBase =
    isApiFormat(configuredFormat) && configuredFormat === selected.apiFormat
      ? configuredString(config, "baseUrl")
      : "";
  const baseUrlInput = await vscode.window.showInputBox({
    title: "API Base URL",
    prompt: "Enter the versioned API root; do not include /responses, /chat/completions, or /messages.",
    value: configuredBase.trim() || defaultBaseUrl(selected.apiFormat),
    ignoreFocusOut: true,
    validateInput: (value) => validationMessage(() =>
      resolveBaseUrl(selected.apiFormat, value),
    ),
  });
  if (baseUrlInput === undefined) {
    return;
  }
  const baseUrl = resolveBaseUrl(selected.apiFormat, baseUrlInput);

  const configuredModel =
    isApiFormat(configuredFormat) && configuredFormat === selected.apiFormat
      ? configuredString(config, "model")
      : "";
  const model = await vscode.window.showInputBox({
    title: "Model",
    prompt: "Enter a model identifier supported by this endpoint.",
    value: configuredModel.trim(),
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "Model is required.",
  });
  if (model === undefined) {
    return;
  }

  const apiKey = await promptForApiKey(baseUrl);
  if (apiKey === undefined) {
    return;
  }

  await config.update("apiFormat", selected.apiFormat, vscode.ConfigurationTarget.Global);
  await config.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
  await config.update("model", model.trim(), vscode.ConfigurationTarget.Global);
  await config.update("enabled", true, vscode.ConfigurationTarget.Global);
  await storeApiKey(context.secrets, selected.apiFormat, baseUrl, apiKey);
  provider.reset();

  const effectiveEnabled = vscode.workspace
    .getConfiguration(CONFIG_SECTION, activeResource())
    .get<unknown>("enabled", true);
  if (effectiveEnabled === false) {
    void vscode.window
      .showWarningMessage(
        `Inline AI Suggestions is configured for ${selected.label}, but it is disabled by the current workspace settings.`,
        "Open Settings",
      )
      .then((action) => {
        if (action === "Open Settings") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `@ext:${context.extension.id}`,
          );
        }
      });
  } else {
    void vscode.window.showInformationMessage(
      `Inline AI Suggestions is configured for ${selected.label}.`,
    );
  }
}

async function setApiKey(
  context: vscode.ExtensionContext,
  provider: InlineAiCompletionProvider,
): Promise<void> {
  let settings;
  try {
    settings = readRuntimeSettings(activeResource());
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Cannot set the API key: ${errorMessage(error)}`,
    );
    return;
  }

  const apiKey = await promptForApiKey(settings.baseUrl);
  if (apiKey === undefined) {
    return;
  }
  await storeApiKey(context.secrets, settings.apiFormat, settings.baseUrl, apiKey);
  provider.reset();
  void vscode.window.showInformationMessage(
    `API key stored securely for ${settings.baseUrl}.`,
  );
}

async function clearApiKey(
  context: vscode.ExtensionContext,
  provider: InlineAiCompletionProvider,
): Promise<void> {
  let settings;
  try {
    settings = readRuntimeSettings(activeResource());
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Cannot clear the API key: ${errorMessage(error)}`,
    );
    return;
  }

  await deleteApiKey(context.secrets, settings.apiFormat, settings.baseUrl);
  provider.reset();
  void vscode.window.showInformationMessage(
    `API key cleared for ${settings.baseUrl}.`,
  );
}

async function promptForApiKey(baseUrl: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "API Key",
    prompt: `The key will be stored in VS Code SecretStorage for ${baseUrl}.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim() ? undefined : "API key is required.",
  });
  return value?.trim() || undefined;
}

function activeResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri;
}

function validationMessage(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown configuration error.";
}

function configuredString(
  config: vscode.WorkspaceConfiguration,
  key: string,
): string {
  const value = config.get<unknown>(key, "");
  return typeof value === "string" ? value : "";
}
