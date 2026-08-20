import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CompletionApiError,
  FetchImplementation,
  parseApiResponse,
  prepareApiRequest,
  requestCompletion,
} from "../src/api";
import { ApiCompletionOptions, ApiFormat } from "../src/types";

const prompt = {
  system: "Return code only.",
  user: "const answer = <cursor>",
};

function options(apiFormat: ApiFormat): ApiCompletionOptions {
  return {
    apiFormat,
    chatTokenField: "max_completion_tokens",
    baseUrl: "https://api.example.com/custom/v1/",
    apiKey: "test-secret-key",
    model: "test-model",
    maxOutputTokens: 123,
    prompt,
  };
}

describe("API request adapters", () => {
  it("creates an OpenAI Chat Completions request", () => {
    const request = prepareApiRequest(options("openai-chat"));

    assert.equal(request.url, "https://api.example.com/custom/v1/chat/completions");
    assert.equal(request.headers.Authorization, "Bearer test-secret-key");
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.equal(request.headers["x-api-key"], undefined);
    assert.deepEqual(request.body, {
      model: "test-model",
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_completion_tokens: 123,
      stream: false,
    });
  });

  it("can use the legacy Chat Completions token field for compatible gateways", () => {
    const request = prepareApiRequest({
      ...options("openai-chat"),
      chatTokenField: "max_tokens",
    });

    assert.equal(request.body.max_tokens, 123);
    assert.equal(request.body.max_completion_tokens, undefined);
  });

  it("creates an OpenAI Responses request", () => {
    const request = prepareApiRequest(options("openai-responses"));

    assert.equal(request.url, "https://api.example.com/custom/v1/responses");
    assert.equal(request.headers.Authorization, "Bearer test-secret-key");
    assert.deepEqual(request.body, {
      model: "test-model",
      instructions: prompt.system,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt.user }],
        },
      ],
      max_output_tokens: 123,
      store: false,
      stream: false,
    });
  });

  it("creates an Anthropic Messages request", () => {
    const request = prepareApiRequest(options("anthropic-messages"));

    assert.equal(request.url, "https://api.example.com/custom/v1/messages");
    assert.equal(request.headers["x-api-key"], "test-secret-key");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers.Authorization, undefined);
    assert.deepEqual(request.body, {
      model: "test-model",
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      max_tokens: 123,
      stream: false,
    });
  });

  it("posts JSON without allowing redirects", async () => {
    let capturedInput: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock: FetchImplementation = async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({ output_text: "completion" }), { status: 200 });
    };
    const controller = new AbortController();

    const result = await requestCompletion(
      options("openai-responses"),
      controller.signal,
      fetchMock,
    );

    assert.equal(result, "completion");
    assert.equal(String(capturedInput), "https://api.example.com/custom/v1/responses");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.redirect, "error");
    assert.equal(capturedInit?.signal, controller.signal);
  });

  it("reports HTTP errors without exposing the configured key", async () => {
    const fetchMock: FetchImplementation = async () =>
      new Response(
        JSON.stringify({ error: { message: "bad key test-secret-key" } }),
        { status: 401 },
      );

    let caught: unknown;
    try {
      await requestCompletion(
        options("openai-chat"),
        new AbortController().signal,
        fetchMock,
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof CompletionApiError);
    assert.equal(caught.status, 401);
    assert.match(caught.message, /\[redacted\]/);
    assert.doesNotMatch(caught.message, /test-secret-key/);
  });

  it("rejects malformed success JSON", async () => {
    const fetchMock: FetchImplementation = async () =>
      new Response("not-json", { status: 200 });

    await assert.rejects(
      requestCompletion(
        options("openai-chat"),
        new AbortController().signal,
        fetchMock,
      ),
      /invalid JSON/,
    );
  });

  it("rejects a response whose declared body is too large", async () => {
    const fetchMock: FetchImplementation = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "1048577" },
      });

    await assert.rejects(
      requestCompletion(
        options("openai-responses"),
        new AbortController().signal,
        fetchMock,
      ),
      /exceeded 1048576 bytes/,
    );
  });
});

describe("API response adapters", () => {
  it("parses Chat Completions string and text-block content", () => {
    assert.equal(
      parseApiResponse("openai-chat", {
        choices: [{ message: { content: "() => 42" } }],
      }),
      "() => 42",
    );
    assert.equal(
      parseApiResponse("openai-chat", {
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "first" },
                { type: "ignored", value: "no" },
                { type: "text", text: " second" },
              ],
            },
          },
        ],
      }),
      "first second",
    );
  });

  it("parses both Responses API output representations", () => {
    assert.equal(
      parseApiResponse("openai-responses", { output_text: "direct" }),
      "direct",
    );
    assert.equal(
      parseApiResponse("openai-responses", {
        output: [
          { type: "reasoning", content: [{ type: "output_text", text: "ignore" }] },
          {
            type: "message",
            content: [
              { type: "output_text", text: "first" },
              { type: "refusal", refusal: "ignore" },
              { type: "output_text", text: " second" },
            ],
          },
        ],
      }),
      "first second",
    );
  });

  it("concatenates Anthropic text blocks and ignores tool use", () => {
    assert.equal(
      parseApiResponse("anthropic-messages", {
        content: [
          { type: "text", text: "first" },
          { type: "tool_use", id: "1" },
          { type: "text", text: " second" },
        ],
      }),
      "first second",
    );
  });

  for (const apiFormat of [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
  ] as const) {
    it(`returns undefined for an unknown ${apiFormat} response`, () => {
      assert.equal(parseApiResponse(apiFormat, { unexpected: true }), undefined);
    });
  }
});
