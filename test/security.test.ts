import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildApiUrl,
  defaultBaseUrl,
  resolveBaseUrl,
  secretStorageKey,
  validateBaseUrl,
} from "../src/security";

describe("API URL security", () => {
  it("keeps a versioned path and removes trailing slashes", () => {
    assert.equal(
      validateBaseUrl(" https://example.com/custom/v1/// "),
      "https://example.com/custom/v1",
    );
    assert.equal(
      buildApiUrl("https://example.com/custom/v1///", "/responses"),
      "https://example.com/custom/v1/responses",
    );
  });

  it("resolves provider defaults for a blank configured URL", () => {
    assert.equal(resolveBaseUrl("openai-chat", ""), "https://api.openai.com/v1");
    assert.equal(
      resolveBaseUrl("openai-responses", "   "),
      "https://api.openai.com/v1",
    );
    assert.equal(
      defaultBaseUrl("anthropic-messages"),
      "https://api.anthropic.com/v1",
    );
  });

  it("rejects a base URL that already contains an operation path", () => {
    assert.throws(
      () => resolveBaseUrl("openai-responses", "https://example.com/v1/responses"),
      /operation path/,
    );
    assert.throws(
      () => resolveBaseUrl("openai-chat", "https://example.com/v1/chat/completions"),
      /operation path/,
    );
    assert.throws(
      () => resolveBaseUrl("anthropic-messages", "https://example.com/v1/messages"),
      /operation path/,
    );
  });

  for (const url of [
    "http://localhost:3000/v1",
    "http://127.0.0.1:8080/api",
    "http://[::1]:9000/v1",
    "https://internal.example.test/v1",
  ]) {
    it(`accepts secure or loopback URL ${url}`, () => {
      assert.equal(validateBaseUrl(url), url);
    });
  }

  for (const url of [
    "http://api.example.com/v1",
    "ftp://example.com/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?tenant=a",
    "https://example.com/v1#fragment",
    "not a url",
  ]) {
    it(`rejects unsafe URL ${url}`, () => {
      assert.throws(() => validateBaseUrl(url));
    });
  }

  it("shares a secret between OpenAI formats but isolates origins and Anthropic", () => {
    const baseUrl = "https://api.example.com/v1";
    assert.equal(
      secretStorageKey("openai-chat", baseUrl),
      secretStorageKey("openai-responses", baseUrl),
    );
    assert.notEqual(
      secretStorageKey("openai-chat", baseUrl),
      secretStorageKey("anthropic-messages", baseUrl),
    );
    assert.notEqual(
      secretStorageKey("openai-chat", baseUrl),
      secretStorageKey("openai-chat", "https://other.example.com/v1"),
    );
  });
});
