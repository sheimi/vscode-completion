import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  SharedRequestCoordinator,
  waitForSharedResult,
} from "../src/requestCoordinator";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("shared request coordinator", () => {
  it("shares an identical in-flight request", async () => {
    const coordinator = new SharedRequestCoordinator<string>();
    const result = deferred<string>();
    let starts = 0;

    const first = coordinator.request("document", "same-context", async () => {
      starts += 1;
      return result.promise;
    });
    const second = coordinator.request("document", "same-context", async () => {
      throw new Error("duplicate request should not start");
    });

    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(starts, 1);

    result.resolve("completion");
    assert.equal(await first, "completion");
    assert.equal(await second, "completion");
  });

  it("lets a subscriber cancel without aborting the shared request", async () => {
    const coordinator = new SharedRequestCoordinator<string>();
    const result = deferred<string>();
    const subscriber = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let starts = 0;

    const sharedRequest = coordinator.request(
      "document",
      "same-context",
      async ({ signal }) => {
        starts += 1;
        requestSignal = signal;
        return result.promise;
      },
    );
    const firstSubscriber = waitForSharedResult(
      sharedRequest,
      subscriber.signal,
    );
    await Promise.resolve();

    subscriber.abort();
    assert.equal(await firstSubscriber, undefined);
    assert.equal(requestSignal?.aborted, false);

    const duplicate = coordinator.request(
      "document",
      "same-context",
      async () => {
        throw new Error("duplicate request should not start");
      },
    );
    const secondSubscriber = waitForSharedResult(
      duplicate,
      new AbortController().signal,
    );
    assert.equal(starts, 1);

    result.resolve("completion");
    assert.equal(await secondSubscriber, "completion");
  });

  it("aborts a different request and keeps its replacement registered", async () => {
    const coordinator = new SharedRequestCoordinator<string>();
    const staleResult = deferred<string>();
    const replacementResult = deferred<string>();
    let firstSignal: AbortSignal | undefined;
    let replacementStarts = 0;

    const first = coordinator.request(
      "document",
      "old-context",
      ({ signal }) => {
        firstSignal = signal;
        return staleResult.promise;
      },
    );
    await Promise.resolve();

    const replacement = coordinator.request(
      "document",
      "new-context",
      async () => {
        replacementStarts += 1;
        return replacementResult.promise;
      },
    );
    assert.equal(firstSignal?.aborted, true);
    await assert.rejects(first, { name: "AbortError" });
    staleResult.resolve("stale completion");

    const duplicateReplacement = coordinator.request(
      "document",
      "new-context",
      async () => {
        throw new Error("settled request removed its replacement");
      },
    );
    assert.equal(duplicateReplacement, replacement);
    await Promise.resolve();
    assert.equal(replacementStarts, 1);

    replacementResult.resolve("new completion");
    assert.equal(await replacement, "new completion");
  });

  it("aborts all active requests on reset", async () => {
    const coordinator = new SharedRequestCoordinator<void>();
    const signals: AbortSignal[] = [];

    const start = (scope: string): Promise<void> =>
      coordinator.request(scope, "context", async ({ signal }) => {
        signals.push(signal);
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });

    const first = start("first-document");
    const second = start("second-document");
    await Promise.resolve();
    coordinator.reset();

    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [true, true],
    );
    await Promise.all([
      assert.rejects(first, { name: "AbortError" }),
      assert.rejects(second, { name: "AbortError" }),
    ]);
  });
});
