// A sketch solve must not depend on the solves before it. planegcs orders its
// unknowns by heap address and DogLeg's Gauss-Newton step on an under-constrained
// sketch depends on that order, so a reused wasm heap used to change the answer:
// the arc below grew symmetrically on a fresh solver and lopsided the second time.
import { describe, it, expect, vi } from "vitest";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

declare const process: { cwd(): string };
vi.mock("@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url", () => ({
  default: process.cwd() + "/node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm",
}));

/** A sketchSolve on its own new solver module, so no earlier test has used its heap. */
async function pristine() {
  vi.resetModules();
  return (await import("../../src/sketch/sketchSolve")).compileAndSolve;
}

const deg = Math.PI / 180;
const at = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a * deg), cy + r * Math.sin(a * deg)];

// an off-origin, tilted arc of radius 0.5 dimensioned to 0.8, nothing else holds it
function arcSketch(): [ResolvedEntity[], SketchConstraint[]] {
  const [x1, y1] = at(3.7, -2.1, 0.5, 20);
  const [x2, y2] = at(3.7, -2.1, 0.5, 170);
  const [mx, my] = at(3.7, -2.1, 0.5, 95);
  return [
    [{ type: "arc", id: "a", x1, y1, x2, y2, mx, my } as ResolvedEntity],
    [{ type: "radius", e: "a", value: 0.8 }],
  ];
}

// the centred arc the audit found it on
function centredArc(): [ResolvedEntity[], SketchConstraint[]] {
  return [
    [{ type: "arc", id: "a", x1: 0.5, y1: 0, x2: -0.5, y2: 0, mx: 0, my: 0.5 } as ResolvedEntity],
    [{ type: "radius", e: "a", value: 0.8 }],
  ];
}

function lineAndCircle(): [ResolvedEntity[], SketchConstraint[]] {
  return [
    [
      { type: "line", id: "l", x1: 3, y1: 7, x2: 13, y2: 9.5 } as ResolvedEntity,
      { type: "circle", id: "c", x: 40.5, y: 38.2, radius: 5 } as ResolvedEntity,
    ],
    [
      { type: "horizontal", line: "l" },
      { type: "radius", e: "c", value: 9 },
    ],
  ];
}

function chainedLines(): [ResolvedEntity[], SketchConstraint[]] {
  return [
    [
      { type: "line", id: "m", x1: -4, y1: 1.5, x2: 6.2, y2: 3 } as ResolvedEntity,
      { type: "line", id: "n", x1: 6.2, y1: 3, x2: 9, y2: 11.4 } as ResolvedEntity,
    ],
    [
      { type: "perpendicular", l1: "m", l2: "n" },
      { type: "distance", line: "n", value: 7 },
    ],
  ];
}

const sketches = { arcSketch, centredArc, lineAndCircle, chainedLines };
type Name = keyof typeof sketches;

async function run(order: Name[]) {
  const solve = await pristine();
  const out = [];
  for (const name of order) out.push(await solve(...sketches[name]()));
  return out;
}

describe("every sketch solve starts from the same solver state", () => {
  it("the same solve twice in one process gives the same answer", async () => {
    for (const name of ["arcSketch", "centredArc"] as Name[]) {
      const passes = await run([name, name]);
      expect(passes[0]?.ok).toBe(true);
      expect(passes[1]).toEqual(passes[0]);
    }
  });

  it("an arc after another solve matches it solved first, in both orders", async () => {
    const arcFirst = await run(["arcSketch", "lineAndCircle"]);
    const otherFirst = await run(["lineAndCircle", "arcSketch"]);
    expect(otherFirst[1]).toEqual(arcFirst[0]);
    expect(arcFirst[1]).toEqual(otherFirst[0]);
    const between = await run(["arcSketch", "lineAndCircle", "arcSketch"]);
    expect(between[2]).toEqual(arcFirst[0]);
  });

  it("a solve after many others matches it solved first", async () => {
    const alone = await run(["centredArc"]);
    const passes = await run(["chainedLines", "arcSketch", "lineAndCircle", "chainedLines", "arcSketch", "centredArc"]);
    expect(passes[5]).toEqual(alone[0]);
    expect(passes[3]).toEqual(passes[0]);
    expect(passes[4]).toEqual(passes[1]);
  });

  it("the centred arc grows symmetrically about its centre", async () => {
    const passes = await run(["centredArc", "centredArc"]);
    const arc = passes[1]?.entities[0] as { x1: number; y1: number; x2: number; y2: number } | undefined;
    expect(arc && [arc.x1, arc.y1, arc.x2, arc.y2].map((v) => +v.toFixed(9) + 0)).toEqual([0.8, 0, -0.8, 0]);
  });
});
