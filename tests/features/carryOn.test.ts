// The carry taker takes a face or an edge only, commits the open step only when nothing blocks it, and hands the
// coordinator a target that is a kind and a world point.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  carryTaker,
  carryWords,
  pickOfHit,
  pointOnFace,
  targetOf,
  type CarryCommit,
  type CarrySource,
  type CarryTarget,
} from "../../src/features/carryOn";
import type { TreePick } from "../../src/ui/treePick";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { Hit } from "../../src/viewport/picking";

const tri = (a: number[], b: number[], c: number[]) =>
  new THREE.Triangle(new THREE.Vector3(...a), new THREE.Vector3(...b), new THREE.Vector3(...c));

// A slanted L made of a small and a large triangle, well off the origin.
const SMALL = tri([5, 2, 3], [6, 2, 3], [5, 3, 3.5]);
const LARGE = tri([5, 2, 3], [9, 4, 3], [5, 8, 3.5]);
const centre = (t: THREE.Triangle): [number, number, number] => [
  (t.a.x + t.b.x + t.c.x) / 3,
  (t.a.y + t.b.y + t.c.y) / 3,
  (t.a.z + t.b.z + t.c.z) / 3,
];

const faces: Record<number, THREE.Triangle[]> = { 4: [SMALL, LARGE], 5: [LARGE, SMALL], 6: [] };
const vp = { faceTriangles: (id: number) => faces[id] ?? [] };

const edge = (points: [number, number, number][]): EdgeRef => ({ id: "e1", points }) as unknown as EdgeRef;
// Three samples: the arc length middle is the second one, the vertex average is not.
const BENT = edge([
  [2, 3, 4],
  [4, 3, 4],
  [4, 3, 6],
]);

function source(over: Partial<CarrySource> = {}) {
  const commitForCarry = vi.fn<() => CarryCommit>(() => ({ kind: "added", id: "f7" }));
  const src: CarrySource = { carryBlocked: () => null, commitForCarry, ...over };
  return { src, commitForCarry };
}

describe("pointOnFace", () => {
  it("is the centre of the largest triangle, whichever order they come in", () => {
    expect(pointOnFace([SMALL, LARGE])).toEqual(centre(LARGE));
    expect(pointOnFace([LARGE, SMALL])).toEqual(centre(LARGE));
    expect(pointOnFace([SMALL])).toEqual(centre(SMALL));
  });

  it("is null for a face with no triangles", () => {
    expect(pointOnFace([])).toBeNull();
  });
});

describe("targetOf", () => {
  it("gives a face its largest triangle centre and an edge its arc length middle", () => {
    expect(targetOf({ kind: "face", faceId: 4 }, vp)).toEqual({ kind: "face", point: centre(LARGE) });
    expect(targetOf({ kind: "edge", edge: BENT }, vp)).toEqual({ kind: "edge", point: [4, 3, 4] });
  });

  it("says the model is still building for a face without triangles or an edge without points", () => {
    expect(targetOf({ kind: "face", faceId: 6 }, vp)).toBe(carryWords.wait());
    expect(targetOf({ kind: "edge", edge: edge([]) }, vp)).toBe(carryWords.wait());
  });
});

describe("pickOfHit", () => {
  it("maps a face hit and an edge hit, and nothing else", () => {
    const faceHit = { kind: "face", faceId: 9, selector: {}, point: [1, 2, 3] } as unknown as Hit;
    const edgeHit = { kind: "edge", edge: BENT, selector: {} } as unknown as Hit;
    expect(pickOfHit(faceHit)).toEqual({ kind: "face", faceId: 9 });
    expect(pickOfHit(edgeHit)).toEqual({ kind: "edge", edge: BENT });
    expect(pickOfHit(null)).toBeNull();
    expect(pickOfHit({ kind: "plane" } as unknown as Hit)).toBeNull();
  });
});

describe("carryTaker", () => {
  const rows: TreePick[] = [
    { kind: "basePlane", plane: "XY" },
    { kind: "body", id: "body2" },
    { kind: "sketch", id: "s3" },
    { kind: "feature", id: "f4" },
    { kind: "datumPoint", id: "p1", point: [1, 2, 3] },
  ];

  it("refuses a plane, a body, a sketch and the rest with the noun, and commits nothing", () => {
    const { src, commitForCarry } = source();
    const after = vi.fn();
    const take = carryTaker(src, { after }, vp);
    for (const pick of rows) {
      const answer = take(pick);
      expect(typeof answer).toBe("string");
      expect(answer).toContain("a face or an edge");
    }
    expect(take(rows[1]!)).toContain("a body");
    expect(take(rows[2]!)).toContain("a sketch");
    expect(commitForCarry).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("answers a blocked source's reason and commits nothing, on a face and on an edge", () => {
    const { src, commitForCarry } = source({ carryBlocked: () => "still building" });
    const after = vi.fn();
    const take = carryTaker(src, { after }, vp);
    expect(take({ kind: "face", faceId: 4 })).toBe("still building");
    expect(take({ kind: "edge", edge: BENT })).toBe("still building");
    expect(commitForCarry).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("commits nothing when the pick has no target", () => {
    const { src, commitForCarry } = source();
    const take = carryTaker(src, { after: vi.fn() }, vp);
    expect(typeof take({ kind: "face", faceId: 6 })).toBe("string");
    expect(commitForCarry).not.toHaveBeenCalled();
  });

  it("answers why a stayed commit stays and does not call after", () => {
    const commitForCarry = vi.fn<() => CarryCommit>(() => ({ kind: "stayed", why: "depth refused" }));
    const after = vi.fn();
    const take = carryTaker({ carryBlocked: () => null, commitForCarry }, { after }, vp);
    expect(take({ kind: "face", faceId: 4 })).toBe("depth refused");
    expect(commitForCarry).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });

  it("calls after once with the added step and the face target, and answers true", () => {
    const { src, commitForCarry } = source();
    const after = vi.fn<(d: unknown, t: CarryTarget) => void>();
    expect(carryTaker(src, { after }, vp)({ kind: "face", faceId: 5 })).toBe(true);
    expect(commitForCarry).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ kind: "added", id: "f7" }, { kind: "face", point: centre(LARGE) });
  });

  it("calls after with the edge midpoint when nothing was added", () => {
    const { src } = source({ commitForCarry: () => ({ kind: "nothing" }) });
    const after = vi.fn();
    expect(carryTaker(src, { after }, vp)({ kind: "edge", edge: BENT })).toBe(true);
    expect(after).toHaveBeenCalledWith({ kind: "nothing" }, { kind: "edge", point: [4, 3, 4] });
  });
});

describe("carryWords", () => {
  it("has four distinct lines, and the refusal carries the reason it was given", () => {
    const lines = [
      carryWords.wait(),
      carryWords.badValue(),
      carryWords.refused("depth 0.3 is under 0.5"),
      carryWords.prompt(),
    ];
    expect(new Set(lines).size).toBe(4);
    expect(lines.every((l) => l.length > 0 && !l.includes("carry."))).toBe(true);
    expect(lines[2]).toContain("depth 0.3 is under 0.5");
    expect(carryWords.refused("other reason")).toContain("other reason");
  });
});
