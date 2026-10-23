import { afterEach, describe, expect, it, vi } from "vitest";
import { afterPaint } from "../../src/geometry/buildPhase";

describe("afterPaint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits two frames and not the fallback timer", async () => {
    vi.useFakeTimers();
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
    let done = false;
    void afterPaint(250).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect([frames.length, done]).toEqual([1, false]);
    frames.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect([frames.length, done]).toEqual([1, false]);
    frames.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("lets the commit through when frames never run, at the fallback and not before", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    let done = false;
    void afterPaint(250).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("does not wait where there are no frames", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    await expect(afterPaint()).resolves.toBeUndefined();
  });
});
