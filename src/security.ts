import { createHash } from "node:crypto";
import { ApiFormat, apiFamily } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

export function defaultBaseUrl(apiFormat: ApiFormat): string {
  return apiFormat === "anthropic-messages"
    ? DEFAULT_ANTHROPIC_BASE_URL
    : DEFAULT_OPENAI_BASE_URL;
}

export function resolveBaseUrl(apiFormat: ApiFormat, configuredBaseUrl: string): string {
  const value = configuredBaseUrl.trim() || defaultBaseUrl(apiFormat);
  const normalized = validateBaseUrl(value);
  const pathname = new URL(normalized).pathname.replace(/\/+$/, "");
  if (
    pathname.endsWith("/responses") ||
    pathname.endsWith("/messages") ||
    pathname.endsWith("/chat/completions")
  ) {
    throw new Error("Base URL must not include the API operation path.");
  }
  return normalized;
}

/**
 * Validates an API root before a credential can be attached to it.
 * Plain HTTP is intentionally limited to loopback development servers.
 */
export function validateBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) {
    throw new Error("Base URL is required.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Base URL must be a valid absolute URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL must use HTTPS, or HTTP for a loopback server.");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain a username or password.");
  }
  if (input.includes("?") || url.search) {
    throw new Error("Base URL must not contain a query string.");
  }
  if (input.includes("#") || url.hash) {
    throw new Error("Base URL must not contain a fragment.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("HTTP is allowed only for localhost or another loopback address.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function buildApiUrl(baseUrl: string, endpoint: string): string {
  const normalizedBaseUrl = validateBaseUrl(baseUrl);
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  if (!normalizedEndpoint) {
    throw new Error("API endpoint is required.");
  }
  return `${normalizedBaseUrl}/${normalizedEndpoint}`;
}

export function secretStorageKey(apiFormat: ApiFormat, baseUrl: string): string {
  const identity = `${apiFamily(apiFormat)}\0${validateBaseUrl(baseUrl)}`;
  const digest = createHash("sha256").update(identity).digest("hex");
  return `inlineAi.apiKey.${digest}`;
}

export function redactSecret(message: string, secret: string): string {
  if (!secret) {
    return message;
  }
  return message.split(secret).join("[redacted]");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
