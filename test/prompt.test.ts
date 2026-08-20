import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COMPLETION_SYSTEM_PROMPT,
  buildCompletionPrompt,
  normalizeCompletion,
} from "../src/prompt";

describe("completion prompt", () => {
  it("includes language, file, prefix, suffix, and cursor boundaries", () => {
    const prompt = buildCompletionPrompt({
      languageId: "typescript",
      fileName: "src/example.ts",
      prefix: "const value = ",
      suffix: ";\n",
    });

    assert.equal(prompt.system, COMPLETION_SYSTEM_PROMPT);
    assert.deepEqual(JSON.parse(prompt.user), {
      languageId: "typescript",
      fileName: "src/example.ts",
      codeBeforeCursor: "const value = ",
      codeAfterCursor: ";\n",
    });
  });
});

describe("completion normalization", () => {
  it("preserves leading indentation and newlines", () => {
    assert.equal(
      normalizeCompletion("\n  return value;", 100),
      "\n  return value;",
    );
  });

  it("unwraps a single Markdown code fence", () => {
    assert.equal(
      normalizeCompletion("```ts\n  value + 1\n```", 100),
      "  value + 1",
    );
  });

  it("does not strip indentation or coincidental suffix characters", () => {
    assert.equal(
      normalizeCompletion("    child", 100),
      "    child",
    );
    assert.equal(
      normalizeCompletion("foo", 100),
      "foo",
    );
  });

  it("rejects empty, oversized, and NUL-containing responses", () => {
    assert.equal(normalizeCompletion("", 100), undefined);
    assert.equal(normalizeCompletion("12345", 4), undefined);
    assert.equal(normalizeCompletion("a\0b", 100), undefined);
  });
});
