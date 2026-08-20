import * as vscode from "vscode";
import { resolveBaseUrl, secretStorageKey } from "./security";
import {
  ApiFormat,
  RuntimeSettings,
  isApiFormat,
  isChatTokenField,
} from "./types";

export const CONFIG_SECTION = "inlineAi";

export function readRuntimeSettings(resource?: vscode.Uri): RuntimeSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const configuredFormat = config.get<unknown>("apiFormat", "openai-responses");
  if (!isApiFormat(configuredFormat)) {
    throw new Error(`Unsupported API format: ${String(configuredFormat)}`);
  }

  const configuredTokenField = config.get<unknown>(
    "chatTokenField",
    "max_completion_tokens",
  );
  if (!isChatTokenField(configuredTokenField)) {
    throw new Error(`Unsupported Chat Completions token field: ${String(configuredTokenField)}`);
  }

  const baseUrl = resolveBaseUrl(configuredFormat, stringValue(config, "baseUrl", ""));
  const configuredExcludedLanguages = config.get<unknown>("excludedLanguages", []);
  const excludedLanguages = Array.isArray(configuredExcludedLanguages)
    ? configuredExcludedLanguages
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  return {
    enabled: booleanValue(config, "enabled", true),
    apiFormat: configuredFormat,
    chatTokenField: configuredTokenField,
    baseUrl,
    model: stringValue(config, "model", "gpt-5.6-luna").trim(),
    debounceMs: boundedNumber(config, "debounceMs", 250, 0, 5000),
    requestTimeoutMs: boundedNumber(config, "requestTimeoutMs", 15000, 1000, 120000),
    maxOutputTokens: boundedNumber(config, "maxOutputTokens", 8000, 1, 8000),
    maxPrefixCharacters: boundedNumber(
      config,
      "maxPrefixCharacters",
      12000,
      0,
      100000,
    ),
    maxSuffixCharacters: boundedNumber(
      config,
      "maxSuffixCharacters",
      4000,
      0,
      50000,
    ),
    maxSuggestionCharacters: boundedNumber(
      config,
      "maxSuggestionCharacters",
      8000,
      1,
      50000,
    ),
    excludedLanguages,
  };
}

function stringValue(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string,
): string {
  const value = config.get<unknown>(key, fallback);
  return typeof value === "string" ? value : fallback;
}

function booleanValue(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean,
): boolean {
  const value = config.get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
}

export async function readApiKey(
  secrets: vscode.SecretStorage,
  settings: Pick<RuntimeSettings, "apiFormat" | "baseUrl">,
): Promise<string | undefined> {
  const value = await secrets.get(secretStorageKey(settings.apiFormat, settings.baseUrl));
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export async function storeApiKey(
  secrets: vscode.SecretStorage,
  apiFormat: ApiFormat,
  baseUrl: string,
  apiKey: string,
): Promise<void> {
  await secrets.store(secretStorageKey(apiFormat, baseUrl), apiKey.trim());
}

export async function deleteApiKey(
  secrets: vscode.SecretStorage,
  apiFormat: ApiFormat,
  baseUrl: string,
): Promise<void> {
  await secrets.delete(secretStorageKey(apiFormat, baseUrl));
}

function boundedNumber(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = config.get<unknown>(key, fallback);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(configured)));
}
