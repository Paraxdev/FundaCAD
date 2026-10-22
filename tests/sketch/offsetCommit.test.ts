// An offset commits what its preview showed: modifyFlow previews offsetChain's
// copies, then commits them with one `offset` constraint and solves.
import { describe, it, expect, vi } from "vitest";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import * as THREE from "three";
import { solveKeepingAxes } from "../../src/sketch/sketchSolve";
import { breakLink, offsetChain, offsetEntity, signedOffsetAt } from "../../src/sketch/modify";
import { asRound } from "../../src/sketch/entityDims";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { OffsetPair, ProjectedCurve, SketchConstraint } from "../../src/types";

type P = [number, number];
type Xf = (x: number, y: number) => P;
const frame = (ox: number, oy: number, a: number): Xf => (x, y) =>
  [ox + x * Math.cos(a) - y * Math.sin(a), oy + x * Math.sin(a) + y * Math.cos(a)];
const ident: Xf = (x, y) => [x, y];
const turned = frame(137.5, -42.25, 0.6);

const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const projected = (id: string, curve: ProjectedCurve): ResolvedEntity => ({ type: "projected", id, source: SRC, curve });
const unlinked = (ents: ResolvedEntity[]) => breakLink(ents, new Set(ents.filter((e) => e.type === "projected").map((e) => e.id)));
const line = (xf: Xf, id: string, a: P, b: P) => {
  const [x1, y1] = xf(...a), [x2, y2] = xf(...b);
  return projected(id, { kind: "line", x1, y1, x2, y2 });
};
/** a CCW arc from angle t0 to t1 */
const arc = (xf: Xf, id: string, c: P, r: number, t0: number, t1: number) => {
  const on = (t: number) => xf(c[0] + r * Math.cos(t), c[1] + r * Math.sin(t));
  const [x1, y1] = on(t0), [x2, y2] = on(t1), [mx, my] = on((t0 + t1) / 2);
  return projected(id, { kind: "arc", x1, y1, x2, y2, mx, my });
};

// The report's top face: an 85.97 x 76.03 block, its (+x,-y) vertical edge
// filleted Rv, then the arc, the right and the front top edges R17. `mixed`
// stores two lines against the loop, as OCCT's edge parameter may run.
const W = 85.96578286299416, H = 76.03237166824204;
const xL = -W / 2, xR = W / 2 - 17, yB = -H / 2 + 17, yT = H / 2;
const centre = (Rv: number): P => [W / 2 - Rv, -H / 2 + Rv];
function faceOutline(xf: Xf, opts: { mixed?: boolean; poly?: boolean; Rv?: number } = {}): ResolvedEntity[] {
  const Rv = opts.Rv ?? 64.92, C = centre(Rv), R = Rv - 17;
  const f = opts.poly
    ? projected("f", { kind: "poly", pts: Array.from({ length: 17 }, (_, k) => {
      const t = -Math.PI / 2 + (k / 16) * (Math.PI / 2);
      return xf(C[0] + R * Math.cos(t), C[1] + R * Math.sin(t));
    }) })
    : arc(xf, "f", C, R, -Math.PI / 2, 0);
  const e = opts.mixed ? line(xf, "e", [C[0], yB], [xL, yB]) : line(xf, "e", [xL, yB], [C[0], yB]);
  const b = opts.mixed ? line(xf, "b", [xL, yT], [xR, yT]) : line(xf, "b", [xR, yT], [xL, yT]);
  return [e, f, line(xf, "c", [xR, C[1]], [xR, yT]), b, line(xf, "a", [xL, yT], [xL, yB])];
}

async function previewAndCommit(ents: ResolvedEntity[], idx: number, inside: P, mag: number) {
  const work = unlinked(ents);
  const side = signedOffsetAt(unlinked([ents[idx]!])[0]!, new THREE.Vector2(...inside))! < 0 ? -1 : 1;
  const res = (offsetChain(work, idx, side * mag) ?? offsetEntity(work, idx, side * mag))!;
  const preview = res.entities.slice(work.length);
  const c: SketchConstraint = { type: "offset", pairs: res.pairs, value: side * mag };
  const solved = await solveKeepingAxes([...ents, ...preview], [c]);
  return { preview, pairs: res.pairs, c, solved, committed: solved.entities.slice(ents.length) };
}

const KEYS = ["x1", "y1", "x2", "y2", "mx", "my", "x", "y", "radius"];
function maxDev(a: ResolvedEntity[], b: ResolvedEntity[]): number {
  expect(b.map((e) => [e.type, e.id])).toEqual(a.map((e) => [e.type, e.id]));
  let dev = 0;
  a.forEach((p, k) => {
    for (const key of KEYS) if (key in p) dev = Math.max(dev, Math.abs((b[k] as any)[key] - (p as any)[key]));
  });
  return dev;
}
const flips = (pairs: OffsetPair[]) =>
  [...pairs].sort((p, q) => (p.src < q.src ? -1 : 1)).map((p) => ({ ...p, cpy: typeof p.cpy }));
const round = (e: ResolvedEntity | undefined) => {
  const g = e && asRound(e);
  return g && { x: +g.x.toFixed(6), y: +g.y.toFixed(6), r: +g.r.toFixed(6) };
};
const byId = (ents: ResolvedEntity[], id: string | undefined) => ents.find((e) => e.id === id);
const copyOf = (ents: ResolvedEntity[], pairs: OffsetPair[], src: string) => round(byId(ents, pairs.find((p) => p.src === src)?.cpy));

describe("offset of a projected filleted face outline commits its preview", () => {
  const picks = [[0, "the short line"], [1, "the arc"], [3, "the long line"]] as const;
  for (const [name, xf] of [["axis aligned at the origin", ident], ["turned 0.6 rad off the origin", turned]] as const) {
    for (const mixed of [false, true]) {
      for (const [pick, what] of picks) {
        it(`${name}, lines ${mixed ? "mixed" : "with the loop"}, picking ${what}`, async () => {
          const r = await previewAndCommit(faceOutline(xf, { mixed }), pick, xf(0, 10), 6.04);
          expect(r.solved.conflicts).toEqual([]);
          expect(maxDev(r.preview, r.committed)).toBeLessThan(1e-6);
          const [cx, cy] = xf(...centre(64.92));
          expect(copyOf(r.committed, r.pairs, "f")).toEqual({ x: +cx.toFixed(6), y: +cy.toFixed(6), r: +(64.92 - 17 - 6.04).toFixed(6) });
          // the arc shrinks, so it flips exactly when the pick's sign says grow
          expect(flips(r.pairs)).toEqual([
            { src: "a", cpy: "string" }, { src: "b", cpy: "string" }, { src: "c", cpy: "string" },
            { src: "e", cpy: "string" }, { src: "f", cpy: "string", ...(r.c.value > 0 ? { flip: true } : {}) },
          ]);
        });
      }
    }
  }

  it("keeps the copy inside after the fillet shrinks by more than the offset", async () => {
    const first = await previewAndCommit(faceOutline(turned), 3, turned(0, 10), 6.04);
    expect(first.c.value).toBe(6.04);
    // Rv 64.92 to 50 takes the face arc from r 47.92 to 33, inside the copy's 41.88
    const moved = faceOutline(turned, { Rv: 50 });
    const again = await solveKeepingAxes([...moved, ...first.committed], [first.c]);
    expect(again.conflicts).toEqual([]);
    const fresh = await previewAndCommit(moved, 3, turned(0, 10), 6.04);
    const [cx, cy] = turned(...centre(50));
    expect(copyOf(fresh.committed, fresh.pairs, "f")).toEqual({ x: +cx.toFixed(6), y: +cy.toFixed(6), r: 26.96 });
    expect(copyOf(again.entities, first.pairs, "f")).toEqual(copyOf(fresh.committed, fresh.pairs, "f"));
  });

  it("leaves a B-spline edge out of the chain, and the lines commit as previewed", async () => {
    const r = await previewAndCommit(faceOutline(turned, { mixed: true, poly: true }), 3, turned(0, 10), 6.04);
    expect(r.solved.conflicts).toEqual([]);
    expect(maxDev(r.preview, r.committed)).toBeLessThan(1e-6);
    expect(r.preview.map((e) => e.type)).toEqual(["line", "line", "line", "line"]);
    expect(flips(r.pairs)).toEqual(["a", "b", "c", "e"].map((src) => ({ src, cpy: "string" })));
  });

  it("flips every corner of a rounded rectangle offset inward from a line", async () => {
    const xf = frame(-23.4, 71.9, -1.1), w = 50, h = 30, k = 5;
    const ents = [
      line(xf, "l0", [k, 0], [w - k, 0]), arc(xf, "a0", [w - k, k], k, -Math.PI / 2, 0),
      line(xf, "l1", [w, k], [w, h - k]), arc(xf, "a1", [w - k, h - k], k, 0, Math.PI / 2),
      line(xf, "l2", [w - k, h], [k, h]), arc(xf, "a2", [k, h - k], k, Math.PI / 2, Math.PI),
      line(xf, "l3", [0, h - k], [0, k]), arc(xf, "a3", [k, k], k, Math.PI, 1.5 * Math.PI),
    ];
    const r = await previewAndCommit(ents, 2, xf(w / 2, h / 2), 1.5);
    expect(r.solved.conflicts).toEqual([]);
    expect(maxDev(r.preview, r.committed)).toBeLessThan(1e-6);
    expect(["a0", "a1", "a2", "a3"].map((s) => copyOf(r.committed, r.pairs, s)!.r)).toEqual([3.5, 3.5, 3.5, 3.5]);
    expect(flips(r.pairs)).toEqual([
      ...["a0", "a1", "a2", "a3"].map((src) => ({ src, cpy: "string", flip: true })),
      ...["l0", "l1", "l2", "l3"].map((src) => ({ src, cpy: "string" })),
    ]);
  });

  it("shrinks a convex fillet and grows a concave one in the same inward offset", async () => {
    // an L, CCW, its outer corner (40,0) filleted R8 and its inner corner (20,20) R6;
    // the loop runs f1 against its stored CCW sweep
    const xf = frame(-61.3, 18.7, -0.35);
    const ents = [
      line(xf, "l0", [0, 0], [32, 0]), arc(xf, "f0", [32, 8], 8, -Math.PI / 2, 0),
      line(xf, "l1", [40, 8], [40, 20]), line(xf, "l2", [40, 20], [26, 20]),
      arc(xf, "f1", [26, 26], 6, Math.PI, 1.5 * Math.PI),
      line(xf, "l3", [20, 26], [20, 40]), line(xf, "l4", [20, 40], [0, 40]), line(xf, "l5", [0, 40], [0, 0]),
    ];
    const cases = [[0, [5, 5], ["f0"]], [1, [33, 7], ["f1"]], [4, [18, 18], ["f0"]]] as const;
    for (const [pick, inside, flipped] of cases) {
      const r = await previewAndCommit(ents, pick, xf(inside[0], inside[1]), 2);
      expect(r.solved.conflicts).toEqual([]);
      expect(maxDev(r.preview, r.committed)).toBeLessThan(1e-6);
      expect([copyOf(r.committed, r.pairs, "f0")!.r, copyOf(r.committed, r.pairs, "f1")!.r]).toEqual([6, 8]);
      expect(r.pairs.filter((p) => p.flip).map((p) => p.src)).toEqual(flipped);
    }
  });
});

describe("an offset's round pair", () => {
  const src = projected("s", { kind: "circle", x: 31.4, y: -12.7, r: 10 });
  const cpy: ResolvedEntity = { type: "circle", id: "k", x: 31.4, y: -12.7, radius: 13 };
  const solveWith = async (pair: OffsetPair, value: number) =>
    round(byId((await solveKeepingAxes([src, cpy], [{ type: "offset", pairs: [pair], value }])).entities, "k"));
  it("moves its radius by value when not flipped", async () => {
    expect(await solveWith({ src: "s", cpy: "k" }, 4.5)).toEqual({ x: 31.4, y: -12.7, r: 14.5 });
    expect(await solveWith({ src: "s", cpy: "k", flip: false }, -1.5)).toEqual({ x: 31.4, y: -12.7, r: 8.5 });
  });
  it("moves its radius by -value when flipped", async () => {
    expect(await solveWith({ src: "s", cpy: "k", flip: true }, -4.5)).toEqual({ x: 31.4, y: -12.7, r: 14.5 });
    expect(await solveWith({ src: "s", cpy: "k", flip: true }, 1.5)).toEqual({ x: 31.4, y: -12.7, r: 8.5 });
  });
});
