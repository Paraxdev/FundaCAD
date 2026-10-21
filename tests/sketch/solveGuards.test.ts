// Solve guard and read-back edge cases from the sketch mutation audit, against the real planegcs.
import { describe, it, expect, vi } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

import { compileAndSolve } from "../../src/sketch/sketchSolve";
import { rectCorners, rectFromThreePoints } from "../../src/sketch/region";

const line = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ type: "line", id, x1, y1, x2, y2 }) as ResolvedEntity;
const circle = (id: string, x: number, y: number, radius: number) => ({ type: "circle", id, x, y, radius }) as ResolvedEntity;
const fixLine = (e: string): SketchConstraint[] => [{ type: "fix", e, p: 0 }, { type: "fix", e, p: 1 }];

describe("a circle centred on a line may leave it for either side", () => {
  // l runs (2,1) to (12,6); n is its unit normal, the centre (7,3.5) is l's midpoint
  const l = line("l", 2, 1, 12, 6);
  const n = { x: -5 / Math.hypot(5, 10), y: 10 / Math.hypot(5, 10) };
  const cons: SketchConstraint[] = [...fixLine("l"), { type: "radius", e: "c", value: 2 }, { type: "c2lDistance", circle: "c", line: "l", value: -1 }];

  for (const [label, t] of [["exactly on it", 0], ["within 1e-9 of it", 4e-10], ["clearly on one side", -0.25]] as const) {
    it(`accepts a c2lDistance solve with the centre ${label}`, async () => {
      const c = circle("c", 7 + t * n.x, 3.5 + t * n.y, 2);
      const r = await compileAndSolve([l, c], cons);
      const s = r.entities[1] as { x: number; y: number; radius: number };
      const dist = (s.x - 7) * n.x + (s.y - 3.5) * n.y;
      if (t < 0) expect(dist).toBeLessThan(0);
      expect({ ...r, entities: [r.entities[0], { dist: Math.abs(dist), radius: s.radius }] }).toEqual({
        entities: [l, { dist: expect.closeTo(1, 9), radius: expect.closeTo(2, 9) }],
        dof: 1, ok: true, conflicts: [], overDefined: [],
      });
    });
  }

  it("still refuses a solve that moves the centre from one side to the other", async () => {
    const q = { type: "point", id: "q", x: 7 - 0.5 * n.x, y: 3.5 - 0.5 * n.y } as ResolvedEntity;
    const c = circle("c", 7 + 0.5 * n.x, 3.5 + 0.5 * n.y, 2);
    const hop: SketchConstraint[] = [
      ...fixLine("l"), { type: "c2lDistance", circle: "c", line: "l", value: -1 },
      { type: "fix", e: "q", p: 0 }, { type: "coincident", e1: "c", p1: 0, e2: "q", p2: 0 },
    ];
    expect(await compileAndSolve([l, q, c], hop)).toEqual({ entities: [l, q, c], dof: 0, ok: false, conflicts: ["k2"], overDefined: [] });
  });
});

describe("a rotated rectangle keeps its fields exactly through solves", () => {
  const rect = { type: "rectangle", id: "r", x: 5.3, y: -2.7, width: 10, height: 4, angle: 200 } as ResolvedEntity;

  it("comes back unchanged from one solve and from many", async () => {
    let ents = [rect];
    for (let k = 0; k < 4; k++) {
      const r = await compileAndSolve(ents, []);
      expect(r).toEqual({ entities: [rect], dof: 0, ok: true, conflicts: [], overDefined: [] });
      ents = r.entities;
    }
  });

  it("is read back from its corners when one merged onto a line end", async () => {
    const [c0, c1, c2] = rectCorners(5.3, -2.7, 10, 4, 200);
    const p = { x: Math.round(c0!.x * 1000) / 1000, y: Math.round(c0!.y * 1000) / 1000 };
    const ln = line("ln", p.x, p.y, 20.5, 9.1);
    const r = await compileAndSolve([ln, rect], []);
    expect(r.entities).toEqual([ln, { ...rect, ...rectFromThreePoints(p, c1!, c2!) }]);
    expect(r.entities[1]).not.toEqual(rect);
  });
});

describe("collinear on lines that share a point adds one equation", () => {
  const a = line("a", 1.5, -2, 11.5, 0.5);
  const col: SketchConstraint[] = [{ type: "collinear", l1: "a", l2: "b" }];
  const cases = [
    ["sharing b's start", line("b", 11.5, 0.5, 21, 3.8), 5],
    ["sharing b's end", line("b", 21, 3.8, 11.5, 0.5), 5],
    ["sharing no point", line("b", 13, 1, 21, 3.8), 6],
  ] as const;
  for (const [label, b, dof] of cases) {
    it(`${label}: dof ${dof}, nothing over-defined, also when solved again`, async () => {
      const first = await compileAndSolve([a, b], col);
      const again = await compileAndSolve(first.entities, col);
      for (const r of [first, again]) {
        expect({ dof: r.dof, ok: r.ok, conflicts: r.conflicts, overDefined: r.overDefined }).toEqual({ dof, ok: true, conflicts: [], overDefined: [] });
        const [sa, sb] = r.entities as { x1: number; y1: number; x2: number; y2: number }[];
        const off = (x: number, y: number) => ((x - sa!.x1) * (sa!.y2 - sa!.y1) - (y - sa!.y1) * (sa!.x2 - sa!.x1)) / Math.hypot(sa!.x2 - sa!.x1, sa!.y2 - sa!.y1);
        expect([off(sb!.x1, sb!.y1), off(sb!.x2, sb!.y2)].map((v) => +v.toFixed(9) + 0)).toEqual([0, 0]);
      }
    });
  }
});
