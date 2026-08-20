import { ApiCompletionOptions, ApiFormat } from "./types";
import { buildApiUrl, redactSecret } from "./security";

export interface PreparedApiRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class CompletionApiError extends Error {
  public readonly status: number | undefined;

  public constructor(message: string, status: number | undefined = undefined) {
    super(message);
    this.name = "CompletionApiError";
    this.status = status;
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;

export function prepareApiRequest(options: ApiCompletionOptions): PreparedApiRequest {
  const commonHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  switch (options.apiFormat) {
    case "openai-chat":
      return {
        url: buildApiUrl(options.baseUrl, "chat/completions"),
        headers: {
          ...commonHeaders,
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: {
          model: options.model,
          messages: [
            { role: "system", content: options.prompt.system },
            { role: "user", content: options.prompt.user },
          ],
          [options.chatTokenField]: options.maxOutputTokens,
          stream: false,
        },
      };

    case "openai-responses":
      return {
        url: buildApiUrl(options.baseUrl, "responses"),
        headers: {
          ...commonHeaders,
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: {
          model: options.model,
          instructions: options.prompt.system,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: options.prompt.user,
                },
              ],
            },
          ],
          max_output_tokens: options.maxOutputTokens,
          store: false,
          stream: false,
        },
      };

    case "anthropic-messages":
      return {
        url: buildApiUrl(options.baseUrl, "messages"),
        headers: {
          ...commonHeaders,
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: options.model,
          system: options.prompt.system,
          messages: [{ role: "user", content: options.prompt.user }],
          max_tokens: options.maxOutputTokens,
          stream: false,
        },
      };
  }
}

export async function requestCompletion(
  options: ApiCompletionOptions,
  signal: AbortSignal,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<string | undefined> {
  const request = prepareApiRequest(options);
  const response = await fetchImplementation(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
    redirect: "error",
  });

  const rawBody = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES);
  const parsedBody = parseJson(rawBody);

  if (!response.ok) {
    const remoteMessage = extractRemoteErrorMessage(parsedBody);
    const safeRemoteMessage = remoteMessage
      ? `: ${redactSecret(remoteMessage, options.apiKey)}`
      : "";
    throw new CompletionApiError(
      `Completion API request failed with HTTP ${response.status}${safeRemoteMessage}`,
      response.status,
    );
  }

  if (parsedBody === undefined) {
    throw new CompletionApiError("Completion API returned invalid JSON.", response.status);
  }

  return parseApiResponse(options.apiFormat, parsedBody);
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CompletionApiError(
      `Completion API response exceeded ${maximumBytes} bytes.`,
      response.status,
    );
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";

  while (true) {
    const result = await reader.read();
    if (result.done) {
      return text + decoder.decode();
    }
    byteCount += result.value.byteLength;
    if (byteCount > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CompletionApiError(
        `Completion API response exceeded ${maximumBytes} bytes.`,
        response.status,
      );
    }
    text += decoder.decode(result.value, { stream: true });
  }
}

export function parseApiResponse(apiFormat: ApiFormat, value: unknown): string | undefined {
  const root = asRecord(value);
  if (!root) {
    return undefined;
  }

  switch (apiFormat) {
    case "openai-chat":
      return parseOpenAiChatResponse(root);
    case "openai-responses":
      return parseOpenAiResponsesResponse(root);
    case "anthropic-messages":
      return parseAnthropicMessagesResponse(root);
  }
}

function parseOpenAiChatResponse(root: Record<string, unknown>): string | undefined {
  const firstChoice = asRecord(asArray(root.choices)?.[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => block !== undefined)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text || undefined;
}

function parseOpenAiResponsesResponse(root: Record<string, unknown>): string | undefined {
  if (typeof root.output_text === "string") {
    return root.output_text;
  }

  const textBlocks: string[] = [];
  for (const outputItem of asArray(root.output) ?? []) {
    const output = asRecord(outputItem);
    if (!output || output.type !== "message") {
      continue;
    }
    for (const contentItem of asArray(output.content) ?? []) {
      const content = asRecord(contentItem);
      if (content?.type === "output_text" && typeof content.text === "string") {
        textBlocks.push(content.text);
      }
    }
  }
  const text = textBlocks.join("");
  return text || undefined;
}

function parseAnthropicMessagesResponse(root: Record<string, unknown>): string | undefined {
  const text = (asArray(root.content) ?? [])
    .map(asRecord)
    .filter((block): block is Record<string, unknown> => block !== undefined)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text || undefined;
}

function parseJson(value: string): unknown | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractRemoteErrorMessage(value: unknown): string | undefined {
  const root = asRecord(value);
  const nestedError = asRecord(root?.error);
  const candidate = nestedError?.message ?? root?.message;
  if (typeof candidate !== "string") {
    return undefined;
  }
  return candidate.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
