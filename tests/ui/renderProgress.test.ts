import { describe, expect, it } from "vitest";
import { SHOW_EVERY_MS, startProgress, stepProgress, type TraceProgress } from "../../src/ui/renderProgress";

const T0 = 1_730_000_123_457;

describe("startProgress", () => {
  it("starts at nothing shown with the total fixed", () => {
    expect(startProgress(256, 5000)).toEqual({ total: 256, shown: 0, shownAt: 5000, quarter: 0 });
  });

  it("never starts below one sample", () => {
    expect(startProgress(0, 5000)).toEqual({ total: 1, shown: 0, shownAt: 5000, quarter: 0 });
    expect(startProgress(-7, 5000).total).toBe(1);
  });

  it("keeps whole samples", () => {
    expect(startProgress(3.7, 5000)).toEqual({ total: 3, shown: 0, shownAt: 5000, quarter: 0 });
  });
});

describe("stepProgress throttle", () => {
  const p: TraceProgress = { total: 256, shown: 70, shownAt: T0, quarter: 1 };

  it("holds a change inside the second and shows it at exactly one second", () => {
    const held = stepProgress(p, 100, T0 + SHOW_EVERY_MS - 1);
    expect(held).toEqual({ progress: p, quarter: null });
    expect(held.progress).toBe(p);
    const shown = stepProgress(p, 100, T0 + SHOW_EVERY_MS);
    expect(shown).toEqual({ progress: { total: 256, shown: 100, shownAt: T0 + 1000, quarter: 1 }, quarter: null });
  });

  it("shows a change in the same quarter after the second without a quarter line", () => {
    const q: TraceProgress = { total: 256, shown: 70, shownAt: T0, quarter: 1 };
    expect(stepProgress(q, 90, T0 + 1500)).toEqual({
      progress: { total: 256, shown: 90, shownAt: T0 + 1500, quarter: 1 },
      quarter: null,
    });
  });

  it("gives the exact shown list for thirty frame reports over 2.5 seconds", () => {
    let cur = startProgress(256, T0);
    const shown: number[] = [];
    const said: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const step = stepProgress(cur, i * 3 + 1, T0 + Math.round((i * 2500) / 30));
      if (step.progress !== cur) shown.push(step.progress.shown);
      if (step.quarter) said.push(step.quarter);
      cur = step.progress;
    }
    expect(shown).toEqual([37, 64]);
    expect(said).toEqual([1]);
  });
});

describe("stepProgress quarters", () => {
  const first = (total: number, n: number) => stepProgress(startProgress(total, T0), n, T0 + 10);

  it("fires at a quarter even inside the second", () => {
    expect(first(256, 64)).toEqual({ progress: { total: 256, shown: 64, shownAt: T0 + 10, quarter: 1 }, quarter: 1 });
    expect(first(256, 63)).toEqual({ progress: startProgress(256, T0), quarter: null });
  });

  it("puts the boundaries at 64 and 1024 where the counts say", () => {
    expect(first(64, 16).quarter).toBe(1);
    expect(first(64, 15).quarter).toBeNull();
    expect(first(1024, 256).quarter).toBe(1);
    expect(first(1024, 255).quarter).toBeNull();
    expect(first(1024, 768).quarter).toBe(3);
    expect(first(1024, 767).quarter).toBe(2);
  });

  it("rounds an odd total up, 3 is the first count past 2.5 of 10", () => {
    expect(first(10, 3).quarter).toBe(1);
    expect(first(10, 2).quarter).toBeNull();
    expect(first(10, 5).quarter).toBe(2);
    expect(first(10, 8).quarter).toBe(3);
    expect(first(10, 7).quarter).toBe(2);
  });

  it("says a jump over two quarters once, then nothing for the same quarter", () => {
    const a = stepProgress(startProgress(256, T0), 10, T0 + 5);
    expect(a.quarter).toBeNull();
    const b = stepProgress(a.progress, 140, T0 + 20);
    expect(b).toEqual({ progress: { total: 256, shown: 140, shownAt: T0 + 20, quarter: 2 }, quarter: 2 });
    const c = stepProgress(b.progress, 150, T0 + 30);
    expect(c).toEqual({ progress: b.progress, quarter: null });
    expect(c.progress).toBe(b.progress);
  });

  it("says each of the three quarters on the way up and none at the total", () => {
    let cur = startProgress(256, T0);
    const said: Array<number | null> = [];
    for (const [i, n] of [64, 128, 192, 256].entries()) {
      const s = stepProgress(cur, n, T0 + 10 + i);
      said.push(s.quarter);
      cur = s.progress;
    }
    expect(said).toEqual([1, 2, 3, null]);
    expect(cur).toEqual({ total: 256, shown: 256, shownAt: T0 + 13, quarter: 3 });
  });
});

describe("stepProgress total and guards", () => {
  it("shows the total at once and says no quarter, from 0 and from 200", () => {
    expect(stepProgress(startProgress(256, T0), 256, T0 + 1)).toEqual({
      progress: { total: 256, shown: 256, shownAt: T0 + 1, quarter: 0 },
      quarter: null,
    });
    const late: TraceProgress = { total: 256, shown: 200, shownAt: T0, quarter: 3 };
    expect(stepProgress(late, 256, T0 + 2)).toEqual({
      progress: { total: 256, shown: 256, shownAt: T0 + 2, quarter: 3 },
      quarter: null,
    });
  });

  it("clamps a count over the total", () => {
    expect(stepProgress(startProgress(256, T0), 300, T0 + 1).progress.shown).toBe(256);
  });

  it("returns the same object and no quarter for a lower, equal, NaN or infinite count", () => {
    const p: TraceProgress = { total: 256, shown: 90, shownAt: T0, quarter: 1 };
    for (const n of [89, 90, 90.9, 0, -5, NaN, Infinity, -Infinity]) {
      const s = stepProgress(p, n, T0 + 5000);
      expect(s.progress).toBe(p);
      expect(s.quarter).toBeNull();
    }
  });

  it("moves one step for one sample total and none for none", () => {
    const one = startProgress(1, T0);
    expect(stepProgress(one, 1, T0)).toEqual({
      progress: { total: 1, shown: 1, shownAt: T0, quarter: 0 },
      quarter: null,
    });
    expect(stepProgress(one, 0, T0 + 9999).progress).toBe(one);
  });

  it("carries nothing from a finished picture into the next", () => {
    const done = stepProgress(startProgress(256, T0), 256, T0 + 1).progress;
    const next = startProgress(64, T0 + 90_000);
    expect(next).toEqual({ total: 64, shown: 0, shownAt: T0 + 90_000, quarter: 0 });
    expect(next).not.toBe(done);
    expect(stepProgress(next, 16, T0 + 90_001).quarter).toBe(1);
  });
});
