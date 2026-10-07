import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDispatchLoop } from "../src/temporal/dispatch-loop.js";

describe("startDispatchLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls dispatch on every tick", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startDispatchLoop({ dispatch, intervalMs: 10, onError });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("skips a tick while the previous dispatch is still pending", async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const dispatch = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startDispatchLoop({ dispatch, intervalMs: 10, onError });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatch).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatch).toHaveBeenCalledTimes(2);

    stop();
  });

  it("calls onError on a rejected dispatch and keeps ticking", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startDispatchLoop({ dispatch, intervalMs: 10, onError });

    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(new Error("boom"));

    await vi.advanceTimersByTimeAsync(10);
    expect(dispatch).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stop() halts further ticks", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startDispatchLoop({ dispatch, intervalMs: 10, onError });

    await vi.advanceTimersByTimeAsync(10);
    expect(dispatch).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
