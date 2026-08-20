export interface SharedRequestContext {
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

interface ActiveRequest<T> {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
}

export class SharedRequestCoordinator<T> {
  private readonly activeRequests = new Map<string, ActiveRequest<T>>();

  public request(
    scope: string,
    key: string,
    start: (context: SharedRequestContext) => Promise<T>,
  ): Promise<T> {
    const current = this.activeRequests.get(scope);
    if (current && current.key === key && !current.controller.signal.aborted) {
      return current.promise;
    }

    this.cancel(scope);

    const controller = new AbortController();
    let activeRequest: ActiveRequest<T>;
    const startedRequest = Promise.resolve().then(() =>
      start({
        signal: controller.signal,
        abort: () => controller.abort(),
      }),
    );
    const promise = rejectOnAbort(startedRequest, controller.signal).finally(
      () => {
        if (this.activeRequests.get(scope) === activeRequest) {
          this.activeRequests.delete(scope);
        }
      },
    );

    activeRequest = { key, controller, promise };
    this.activeRequests.set(scope, activeRequest);

    // A request can outlive all of its subscribers. Keep a rejection from becoming
    // unhandled while preserving it for any subscriber that is still awaiting it.
    void promise.catch(() => undefined);
    return promise;
  }

  public cancel(scope: string): void {
    const current = this.activeRequests.get(scope);
    if (!current) {
      return;
    }
    this.activeRequests.delete(scope);
    current.controller.abort();
  }

  public reset(): void {
    const requests = [...this.activeRequests.values()];
    this.activeRequests.clear();
    for (const request of requests) {
      request.controller.abort();
    }
  }
}

export function waitForSharedResult<T>(
  request: Promise<T>,
  subscriberSignal: AbortSignal,
): Promise<T | undefined> {
  if (subscriberSignal.aborted) {
    return Promise.resolve(undefined);
  }

  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      subscriberSignal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => resolve(undefined));

    subscriberSignal.addEventListener("abort", onAbort, { once: true });
    void request.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );

    // Cover cancellation between the initial check and listener registration.
    if (subscriberSignal.aborted) {
      onAbort();
    }
  });
}

function rejectOnAbort<T>(
  request: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() => {
        const error = new Error("Shared request aborted.");
        error.name = "AbortError";
        reject(error);
      });

    signal.addEventListener("abort", onAbort, { once: true });
    void request.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );

    if (signal.aborted) {
      onAbort();
    }
  });
}
