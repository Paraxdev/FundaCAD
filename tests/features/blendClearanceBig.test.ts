// On a big pick the clearance is measured on the picks nearest the arrow only. It sizes the opening value and never
// bounds the drag, and 20,000 picks against every model edge took 22 s on the main thread.

import { describe, expect, it } from "vitest";
import { CLEARANCE_SAMPLE, localClearance, type ClearanceEdge } from "../../src/features/blendClearance";

const seg = (id: string, x: number, y: number, len = 1): ClearanceEdge => ({
  id,
  points: [
    [x, y, 0],
    [x + len, y, 0],
  ],
});

describe("localClearance on a big pick", () => {
  it("20,000 picks against 100k edges finish under 2 s, a scan per pick took 11 s", () => {
    const all: ClearanceEdge[] = [];
    for (let i = 0; i < 100_000; i++) all.push(seg(`e${i}`, (i % 400) * 3, Math.floor(i / 400) * 3));
    const selected = all.filter((_, i) => i % 2 === 0 && i < 40_000);
    expect(selected.length).toBe(20_000);
    const t0 = performance.now();
    const c = localClearance({ selected, all, modelScale: 1700, near: [0, 0, 0] });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(c).toBeCloseTo(2, 6);
  });

  it("measures the picks nearest the arrow when there are more than the sample", () => {
    const all: ClearanceEdge[] = [];
    const selected: ClearanceEdge[] = [];
    // Near the arrow every pick has a free edge 5 away; far off, a free edge 0.5 away.
    for (let i = 0; i < CLEARANCE_SAMPLE + 50; i++) {
      const pick = seg(`n${i}`, 0, i * 20);
      selected.push(pick);
      all.push(pick, seg(`nf${i}`, 6, i * 20));
    }
    for (let i = 0; i < 1000; i++) {
      const pick = seg(`f${i}`, 100_000, i * 20);
      selected.push(pick);
      all.push(pick, seg(`ff${i}`, 100_001.5, i * 20));
    }
    expect(localClearance({ selected, all, modelScale: 100, near: [0, 0, 0] })).toBeCloseTo(5, 6);
    expect(localClearance({ selected, all, modelScale: 100 })).toBeCloseTo(0.5, 6);
  });

  it("a pick within the sample is measured whole, near or not", () => {
    const selected = [seg("a", 0, 0), seg("b", 1000, 0)];
    const all = [...selected, seg("c", 0, 7), seg("d", 1000, 3)];
    expect(localClearance({ selected, all, modelScale: 1000, near: [0, 0, 0] })).toBeCloseTo(3, 6);
  });
});
