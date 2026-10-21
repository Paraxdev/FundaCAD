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
