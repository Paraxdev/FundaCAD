// tests/vectors/blend_sections.json holds the sections the engine builds, also replayed against the kernel by
// crates/fundacad-geom/tests/blend_section_vectors.rs, so the ghost and the real fillet cannot drift apart.

import { describe, it, expect } from "vitest";
import RAW from "../vectors/blend_sections.json";
import { ARC_SEGMENTS, sweepBlendGhost, type EdgeSample } from "../../src/features/blendGhost";
import type { Continuity } from "../../src/features/continuity";

interface Entry {
  angle: number;
  radius: number;
  continuity: Continuity;
  points: [number, number][];
}

const SECTIONS = (RAW as unknown as { sections: Entry[] }).sections;

function wedge(angle: number, z: number): EdgeSample {
  const t = (angle * Math.PI) / 180;
  return { point: [0, 0, z], tangent: [0, 0, 1], into1: [1, 0, 0], into2: [Math.cos(t), Math.sin(t), 0] };
}

/** The first section's points in order, read back from the strips of the triangle soup. */
function ghostSection(e: Entry, continuity: Continuity): [number, number][] {
  const geo = sweepBlendGhost(
    [wedge(e.angle, 0), wedge(e.angle, 10)],
    e.radius,
    "fillet",
    false,
    undefined,
    continuity,
  );
  expect(geo).not.toBeNull();
  const p = geo!.positions;
  const out: [number, number][] = [];
  for (let j = 0; j < ARC_SEGMENTS; j++) out.push([p[j * 18]!, p[j * 18 + 1]!]);
  const last = (ARC_SEGMENTS - 1) * 18 + 3;
  out.push([p[last]!, p[last + 1]!]);
  return out;
}

const gap = (a: [number, number][], b: [number, number][]) =>
  Math.max(...a.map((q, i) => Math.hypot(q[0] - b[i]![0], q[1] - b[i]![1])));

describe("fillet ghost against the engine's sections", () => {
  it("has the sections to replay", () => {
    expect(SECTIONS.length).toBe(18);
    for (const e of SECTIONS) expect(e.points.length).toBe(ARC_SEGMENTS + 1);
  });

  for (const e of SECTIONS) {
    it(`draws the ${e.continuity} section at ${e.angle} degrees, radius ${e.radius}`, () => {
      expect(gap(ghostSection(e, e.continuity), e.points)).toBeLessThan(1e-6 * e.radius);
    });
  }

  for (const e of SECTIONS.filter((s) => s.continuity !== "G1")) {
    it(`draws ${e.continuity} apart from G1 at ${e.angle} degrees, radius ${e.radius}`, () => {
      expect(gap(ghostSection(e, e.continuity), ghostSection(e, "G1"))).toBeGreaterThan(0.05 * e.radius);
    });
  }

  it("leaves a chamfer as it is whatever continuity is passed", () => {
    const samples = [wedge(90, 0), wedge(90, 10)];
    const g1 = sweepBlendGhost(samples, 4, "chamfer", false, undefined, "G1");
    expect(g1).not.toBeNull();
    expect(sweepBlendGhost(samples, 4, "chamfer", false, undefined, "G3")!.positions).toEqual(g1!.positions);
  });
});
