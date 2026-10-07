export interface DispatchLoopOptions {
  readonly dispatch: () => Promise<unknown>;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
}

/**
 * ponytail: a single in-process `setInterval` relay for the job dispatch
 * outbox. Safe (if a little noisy — every replica dispatches every pending
 * row) to run on more than one replica, because Temporal workflow IDs
 * dedupe `start` calls; it does not need distributed leader election.
 */
export function startDispatchLoop(options: DispatchLoopOptions): () => void {
  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void options
      .dispatch()
      .catch((error: unknown) => {
        options.onError(error);
      })
      .finally(() => {
        inFlight = false;
      });
  }, options.intervalMs);

  return () => {
    clearInterval(timer);
  };
}
