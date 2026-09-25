import { describe, it, expect } from "vitest";
import { findSelectorAt, replaceSelectorAt, repairableDiagFor, repickedExtent, repickedSelector } from "../../src/features/repickReference";
import type { Feature, Selector } from "../../src/types";

const near = (p: [number, number, number]): Selector =>
  ({ kind: "face", by: "nearest", point: p }) as Selector;

const pressPull = (face: Selector | Selector[]): Feature =>
  ({ id: "f73", type: "press-pull", face, distance: 1, operation: "join" }) as Feature;

describe("findSelectorAt", () => {
  it("finds the selector in an array field by its stored point", () => {
    const f = { id: "f1", type: "shell", thickness: 2, faces: [near([0, 0, 0]), near([10, 2, 3])] } as Feature;
    expect(findSelectorAt(f, [10, 2, 3])).toEqual({ field: "faces", index: 1 });
  });

  it("finds a scalar selector field", () => {
    expect(findSelectorAt(pressPull(near([1, 2, 3])), [1, 2, 3])).toEqual({
      field: "face",
      index: null,
    });
  });

  // The engine rounds `at` to 6 decimals; the document keeps what the pick gave.
  it("tolerates the engine's rounding of the reported point", () => {
    const f = pressPull(near([-65.8189741234, 0.9, 7.0857141234]));
    expect(findSelectorAt(f, [-65.818974, 0.9, 7.085714])).not.toBeNull();
  });

  // Not an error: the user may have re-picked or edited since the failed build.
  it("returns null when no selector matches", () => {
    expect(findSelectorAt(pressPull(near([1, 2, 3])), [9, 9, 9])).toBeNull();
  });

  it("finds a hole's tracked face by its stored point", () => {
    const face = { kind: "face", by: "tracked", point: [3, 2, 5], normal: [0, 0, 1], center: [0, 0, 5] } as Selector;
    const f = { id: "h1", type: "hole", face, points: [[3, 2, 5]] } as Feature;
    expect(findSelectorAt(f, [3, 2, 5])).toEqual({ field: "face", index: null });
  });

  it("ignores non-nearest selectors", () => {
    const f = { id: "f1", type: "draft", angle: 3, axis: "Z", faces: [{ kind: "face", by: "normal", dir: [0, 0, 1] }] } as unknown as Feature;
    expect(findSelectorAt(f, [0, 0, 1])).toBeNull();
  });
});

describe("replaceSelectorAt", () => {
  it("preserves array arity and leaves siblings untouched", () => {
    const f = { id: "f1", type: "fillet", radius: 2, edges: [near([0, 0, 0]), near([1, 1, 1])] } as Feature;
    const patch = replaceSelectorAt(f, { field: "edges", index: 1 }, near([5, 5, 5])) as { edges: Selector[] };
    expect(patch.edges).toHaveLength(2);
    expect(patch.edges[0]).toEqual(near([0, 0, 0]));
    expect(patch.edges[1]).toEqual(near([5, 5, 5]));
  });

  it("keeps a scalar field scalar", () => {
    const patch = replaceSelectorAt(pressPull(near([1, 2, 3])), { field: "face", index: null }, near([4, 5, 6]));
    expect(patch).toEqual({ face: near([4, 5, 6]) });
  });
});

describe("repairableDiagFor", () => {
  const diags = [
    { feature_id: "f1", reason: "low confidence", kind: "face" },
    { feature_id: "f73", reason: "ambiguous nearest pick", kind: "face", at: [1, 2, 3] as [number, number, number] },
  ];
  it("picks only the ambiguous diagnostic for that feature", () => {
    expect(repairableDiagFor(diags, "f73")?.at).toEqual([1, 2, 3]);
    expect(repairableDiagFor(diags, "f1")).toBeUndefined();
    expect(repairableDiagFor(undefined, "f73")).toBeUndefined();
  });
});

describe("re-picking a hole's face", () => {
  const split = { kind: "face", by: "tracked", point: [20, 2, 5], normal: [0, 0, 1], center: [0, 0, 5], body: "body1" } as Selector;
  const hole = (face: Selector): Feature => ({ id: "ho", type: "hole", face, points: [[20, 2, 5]] }) as unknown as Feature;
  const site = { field: "face", index: null } as const;
  const picked = { kind: "face", by: "nearest", point: [22, 3, 5], body: "body1" } as Selector;
  const written = { kind: "face", by: "tracked", point: [22, 3, 5], normal: [0, 0, 1], body: "body1" } as Selector;
  const rec = (point: [number, number, number]) => ({ extent: [15, 30, -10, 10] as [number, number, number, number], point, points: [[20, 2, 5]] as [number, number, number][] });

  it("writes a tracked face on the face picked, which a hole follows from then on", () => {
    expect(repickedSelector(hole(split), site, picked, [0, 0, 2])).toEqual(written);
    const patched = { ...hole(split), ...replaceSelectorAt(hole(split), site, written) } as Feature;
    expect(findSelectorAt(patched, [22, 3, 5])).toEqual(site);
  });

  it("leaves every other re-pick as the plain pick", () => {
    expect(repickedSelector(hole(split), site, picked, null)).toBe(picked);
    expect(repickedSelector(pressPull(split), site, picked, [0, 0, 1])).toBe(picked);
  });

  it("takes the extent from the first build of the face it wrote", () => {
    expect(repickedExtent(hole(written), written, rec([22, 3, 5]))).toEqual({ face: { ...written, extent: [15, 30, -10, 10] } });
  });

  it("waits out a build of the face picked before, and gives up on a face edited since", () => {
    expect(repickedExtent(hole(written), written, rec([20, 2, 5]))).toBeNull();
    expect(repickedExtent(hole(written), written, undefined)).toBeNull();
    expect(repickedExtent(hole(split), written, rec([22, 3, 5]))).toBeNull();
    expect(repickedExtent(undefined, written, rec([22, 3, 5]))).toBeNull();
    const filled = { ...written, extent: [15, 30, -10, 10] } as Selector;
    expect(repickedExtent(hole(filled), filled, rec([22, 3, 5]))).toBeNull();
  });
});
