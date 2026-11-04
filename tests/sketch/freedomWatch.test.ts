import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreedomWatch, type FreedomRun as Run } from "../../src/sketch/freedomWatch";
import type { Freedom } from "../../src/sketch/freedom";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

const line = (x2: number): ResolvedEntity[] => [{ type: "line", id: "e1", x1: 3.5, y1: -2, x2, y2: 7.25 }];
const cons: SketchConstraint[] = [{ type: "horizontal", line: "e1" }];
const map = (x: boolean) => new Map([["e1", { x, y: true, size: false }]]);

let results: (Map<string, Freedom> | null)[];
beforeEach(() => {
  vi.useFakeTimers();
  results = [];
});
afterEach(() => vi.useRealTimers());

describe("FreedomWatch", () => {
  it("waits 300 ms after the last request, then runs once", async () => {
    const run = vi.fn<Run>(async () => map(true));
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(299);
    expect(run).not.toHaveBeenCalled();
    w.request(line(12), cons);
    await vi.advanceTimersByTimeAsync(299);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual(line(12));
    expect(results).toEqual([map(true)]);
  });

  it("drops the result of a run that a newer request overtook", async () => {
    let release: (m: Map<string, Freedom> | null) => void = () => {};
    const run = vi.fn<Run>(
      (e) =>
        new Promise((resolve) => {
          if (e[0]!.type === "line" && e[0]!.x2 === 11) release = resolve;
          else resolve(map(false));
        }),
    );
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.request(line(12), cons);
    release(map(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(results).toEqual([map(false)]);
  });

  it("tells a running probe it is stale as soon as a newer request arrives", async () => {
    let stale: () => boolean = () => false;
    const run = vi.fn<Run>(async (_e, _c, s) => {
      stale = s;
      return null;
    });
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    results.length = 0;
    expect(stale()).toBe(false);
    w.request(line(12), cons);
    expect(stale()).toBe(true);
  });

  it("starts nothing for the same sketch, and keeps two different sketches apart", async () => {
    const run = vi.fn<Run>(async (e) => map(e[0]!.type === "line" && e[0]!.x2 === 11));
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    w.request(line(13), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    expect(results).toEqual([map(true), map(false), map(true)]);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("an undo back to the shown sketch drops the newer run, in its pause or mid run", async () => {
    let release: (m: Map<string, Freedom> | null) => void = () => {};
    const run = vi.fn<Run>((e) => {
      const x2 = e[0]!.type === "line" ? e[0]!.x2 : 0;
      if (x2 === 14) return new Promise((resolve) => (release = resolve));
      return Promise.resolve(map(x2 === 11));
    });
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.request(line(13), [...cons, { type: "vertical", line: "e1" }]);
    await vi.advanceTimersByTimeAsync(120);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(600);
    expect(results).toEqual([map(true)]);
    expect(run).toHaveBeenCalledTimes(1);

    w.request(line(14), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.request(line(11), cons);
    release(map(false));
    await vi.advanceTimersByTimeAsync(600);
    expect(results).toEqual([map(true)]);
    expect(run).toHaveBeenCalledTimes(2);

    w.request(line(13), cons);
    await vi.advanceTimersByTimeAsync(300);
    expect(results).toEqual([map(true), map(false)]);
  });

  it("a cancel before the pause ends runs nothing, and a cancel mid run delivers nothing", async () => {
    let release: (m: Map<string, Freedom> | null) => void = () => {};
    const run = vi.fn<Run>(() => new Promise((resolve) => (release = resolve)));
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(200);
    w.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();

    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    w.cancel();
    release(map(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
  });

  it("runs the same sketch again after a cancel", async () => {
    const run = vi.fn<Run>(async () => map(true));
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.cancel();
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    expect(results).toEqual([map(true), map(true)]);
  });

  it("hands over a null result and a failed run alike", async () => {
    const run = vi.fn<Run>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("solver down"));
    const w = new FreedomWatch((r) => results.push(r), run);
    w.request(line(11), cons);
    await vi.advanceTimersByTimeAsync(300);
    w.request(line(12), cons);
    await vi.advanceTimersByTimeAsync(300);
    expect(results).toEqual([null, null]);
  });
});
