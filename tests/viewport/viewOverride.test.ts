import { describe, expect, it } from "vitest";
import type { PlaneDef, ViewOverride } from "../../src/types";
import { overrideRowAnswer, viewOverrideOf } from "../../src/viewport/viewOverride";
import type { TreePick } from "../../src/ui/treePick";

const plane = (normal: PlaneDef["normal"], xdir: PlaneDef["xdir"]): PlaneDef => ({
  origin: [7, -2, 5],
  normal,
  xdir,
});

const near = (v: readonly number[]) => v.map((x) => Math.round(x * 1e9) / 1e9 + 0);

describe("viewOverrideOf", () => {
  it("normalises a slanted normal and takes up as normal x xdir", () => {
    const o = viewOverrideOf(plane([0, 3, 4], [1, 0, 0]));
    expect(near(o.normal)).toEqual([0, 0.6, 0.8]);
    expect(near(o.up)).toEqual([0, 0.8, -0.6]);
  });

  it("normalises an unnormalised xdir too", () => {
    const o = viewOverrideOf(plane([0, 3, 4], [5, 0, 0]));
    expect(near(o.up)).toEqual([0, 0.8, -0.6]);
  });

  it("falls back to straight up when xdir runs along the normal", () => {
    for (const xdir of [
      [0, 0, 2],
      [0, 0, -2],
    ] as PlaneDef["xdir"][]) {
      expect(viewOverrideOf(plane([0, 0, 3], xdir))).toEqual({ normal: [0, 0, 1], up: [0, 0, 1] });
    }
  });

  it("keeps a face just off parallel on the cross product", () => {
    const o = viewOverrideOf(plane([0, 0, 1], [1, 0, 0.01]));
    expect(near(o.up)[1]).toBeCloseTo(1, 4);
  });
});

describe("overrideRowAnswer", () => {
  const slanted = plane([2, 0, 0], [0, 3, 4]);
  const run = (pick: TreePick, planeOf: (id: number) => PlaneDef | null) => {
    const taken: ViewOverride[] = [];
    const planes: number[] = [];
    const answer = overrideRowAnswer(
      pick,
      (id) => {
        planes.push(id);
        return planeOf(id);
      },
      (o) => taken.push(o),
    );
    return { answer, taken, planes };
  };

  it("takes a flat face row once with its override", () => {
    const r = run({ kind: "face", faceId: 17 }, () => slanted);
    expect(r.answer).toBe(true);
    expect(r.planes).toEqual([17]);
    expect(r.taken).toEqual([viewOverrideOf(slanted)]);
    const only = r.taken[0]!;
    expect(near(only.normal)).toEqual([1, 0, 0]);
    expect(near(only.up)).toEqual([0, -0.8, 0.6]);
  });

  it("refuses a curved or unknown face row as curved and takes nothing", () => {
    const r = run({ kind: "face", faceId: 4 }, () => null);
    expect(r.answer).toMatch(/curved/);
    expect(r.taken).toEqual([]);
  });

  it("refuses an edge row and a base plane row naming a flat face, without asking for a plane", () => {
    const edge = run(
      {
        kind: "edge",
        edge: {
          points: [
            [1, 2, 3],
            [4, 5, 6],
          ],
        } as never,
      },
      () => slanted,
    );
    const base = run({ kind: "basePlane", plane: "XY" as never }, () => slanted);
    for (const r of [edge, base]) {
      expect(r.answer).toMatch(/flat face/);
      expect(r.answer).not.toBe(true);
      expect(r.taken).toEqual([]);
      expect(r.planes).toEqual([]);
    }
  });
});
