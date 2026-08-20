export const API_FORMATS = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
] as const;

export type ApiFormat = (typeof API_FORMATS)[number];

export const CHAT_TOKEN_FIELDS = ["max_completion_tokens", "max_tokens"] as const;

export type ChatTokenField = (typeof CHAT_TOKEN_FIELDS)[number];

export interface RuntimeSettings {
  readonly enabled: boolean;
  readonly apiFormat: ApiFormat;
  readonly chatTokenField: ChatTokenField;
  readonly baseUrl: string;
  readonly model: string;
  readonly debounceMs: number;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxPrefixCharacters: number;
  readonly maxSuffixCharacters: number;
  readonly maxSuggestionCharacters: number;
  readonly excludedLanguages: readonly string[];
}

export interface CompletionPrompt {
  readonly system: string;
  readonly user: string;
}

export interface ApiCompletionOptions {
  readonly apiFormat: ApiFormat;
  readonly chatTokenField: ChatTokenField;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly prompt: CompletionPrompt;
}

export function isApiFormat(value: unknown): value is ApiFormat {
  return typeof value === "string" && API_FORMATS.some((item) => item === value);
}

export function isChatTokenField(value: unknown): value is ChatTokenField {
  return (
    typeof value === "string" &&
    CHAT_TOKEN_FIELDS.some((item) => item === value)
  );
}

export function apiFamily(apiFormat: ApiFormat): "openai" | "anthropic" {
  return apiFormat === "anthropic-messages" ? "anthropic" : "openai";
}
