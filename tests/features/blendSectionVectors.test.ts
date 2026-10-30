// tests/vectors/blend_sections.json (scripts/make-blend-vectors.py) holds the sections the engine builds, replayed on
// the same prisms by crates/fundacad-geom/tests/blend_section_vectors.rs, so the ghost and the fillet cannot drift apart.

import { describe, it, expect } from "vitest";
import RAW from "../vectors/blend_sections.json";
import { ARC_SEGMENTS, sectionOutline, sweepBlendGhost, type EdgeSample } from "../../src/features/blendGhost";
import type { Continuity } from "../../src/features/continuity";

type V2 = [number, number];

interface Entry {
  corner: "convex" | "concave";
  angle: number;
  radius: number;
  continuity: Continuity;
  bend1?: number;
  bend2?: number;
  points: V2[];
}

const SECTIONS = (RAW as unknown as { sections: Entry[] }).sections;

/** One of the two faces of `e` in the section frame, leaving the origin along `dir` and curling toward `side`. */
function faceOf(e: Entry, which: 1 | 2) {
  const t = (e.angle * Math.PI) / 180;
  const dir: V2 = which === 1 ? [1, 0] : [Math.cos(t), Math.sin(t)];
  const side: V2 = which === 1 ? [0, 1] : [Math.sin(t), -Math.cos(t)];
  const bend = (which === 1 ? e.bend1 : e.bend2) ?? 0;
  const at = (s: number): V2 => {
    const a = bend ? Math.sin(bend * s) / bend : s;
    const c = bend ? (1 - Math.cos(bend * s)) / bend : 0;
    return [a * dir[0] + c * side[0], a * dir[1] + c * side[1]];
  };
  return { side, bend, at };
}

const reachOf = (e: Entry) => (e.bend1 || e.bend2 ? 30 : 60);

/** The prism's section as the Rust side builds it, the curved faces in small chords as a mesh would have them. */
function outlineOf(e: Entry): Float64Array {
  const reach = reachOf(e);
  const [f1, f2] = [faceOf(e, 1), faceOf(e, 2)];
  const chords = 64;
  const loop: V2[] = [];
  for (let i = 0; i <= chords; i++) loop.push(f1.at((reach * i) / chords));
  const [a, b] = [f1.at(reach), f2.at(reach)];
  if (e.corner === "concave") {
    loop.push([a[0], -100], [-100, -100], [-100, 100], [b[0], 100]);
  }
  for (let i = chords; i > 0; i--) loop.push(f2.at((reach * i) / chords));
  const segs = new Float64Array(loop.length * 4);
  loop.forEach((p, i) => segs.set([...p, ...loop[(i + 1) % loop.length]!], i * 4));
  return segs;
}

function sampleOf(e: Entry, z: number): EdgeSample {
  const t = (e.angle * Math.PI) / 180;
  const reach = reachOf(e);
  return {
    point: [0, 0, z],
    tangent: [0, 0, 1],
    into1: [1, 0, 0],
    into2: [Math.cos(t), Math.sin(t), 0],
    bend1: e.bend1 ?? 0,
    bend2: e.bend2 ?? 0,
    reach1: reach,
    reach2: reach,
  };
}

function withOutline(e: Entry, z: number): EdgeSample {
  const sample = sampleOf(e, z);
  const segs = outlineOf(e);
  const outline = sectionOutline(sample, segs, segs.length / 4);
  expect(outline?.refInside).toBe(e.corner === "convex");
  return { ...sample, outline: outline! };
}

/** The first section's points in order, read back from the strips of the triangle soup. */
function ghostSection(samples: EdgeSample[], e: Entry, continuity: Continuity): V2[] {
  const geo = sweepBlendGhost(samples, e.radius, "fillet", false, undefined, continuity);
  expect(geo).not.toBeNull();
  const p = geo!.positions;
  const out: V2[] = [];
  for (let j = 0; j < ARC_SEGMENTS; j++) out.push([p[j * 18]!, p[j * 18 + 1]!]);
  const last = (ARC_SEGMENTS - 1) * 18 + 3;
  out.push([p[last]!, p[last + 1]!]);
  return out;
}

const bare = (e: Entry, c = e.continuity) => ghostSection([sampleOf(e, 0), sampleOf(e, 10)], e, c);
const judged = (e: Entry, c = e.continuity) => ghostSection([withOutline(e, 0), withOutline(e, 10)], e, c);

const gap = (a: V2[], b: V2[]) => Math.max(...a.map((q, i) => Math.hypot(q[0] - b[i]![0], q[1] - b[i]![1])));

const title = (e: Entry) =>
  `${e.corner} ${e.continuity} at ${e.angle} degrees, radius ${e.radius}, bends ${e.bend1 ?? 0} ${e.bend2 ?? 0}`;

describe("fillet ghost against the engine's sections", () => {
  it("has the sections to replay, both corners and every curled face", () => {
    expect(SECTIONS.length).toBe(48);
    for (const e of SECTIONS) expect(e.points.length).toBe(ARC_SEGMENTS + 1);
    const count = (f: (e: Entry) => boolean) => SECTIONS.filter(f).length;
    expect(count((e) => e.corner === "concave")).toBe(24);
    expect(count((e) => (e.bend1 ?? 0) > 0)).toBe(4);
    expect(count((e) => (e.bend1 ?? 0) < 0)).toBe(4);
    expect(count((e) => (e.bend2 ?? 0) > 0)).toBe(4);
    expect(count((e) => (e.bend2 ?? 0) < 0)).toBe(4);
  });

  for (const e of SECTIONS) {
    it(`draws ${title(e)}, with and without the body's outline`, () => {
      expect(gap(bare(e), e.points)).toBeLessThan(1e-6 * e.radius);
      expect(gap(judged(e), e.points)).toBeLessThan(1e-6 * e.radius);
    });
  }

  for (const e of SECTIONS.filter((s) => s.continuity !== "G1")) {
    it(`draws ${title(e)} apart from G1`, () => {
      expect(gap(judged(e), judged(e, "G1"))).toBeGreaterThan(0.05 * e.radius);
    });
  }

  // The engine refuses G2 and G3 here and the tool drops to G1, but a drag reaches them for one debounce.
  for (const e of SECTIONS.filter((s) => s.bend1 || s.bend2)) {
    for (const c of ["G2", "G3"] as const) {
      it(`keeps ${c}'s feet on the faces for ${title(e)}`, () => {
        const pts = bare(e, c);
        expect(offFace(e, 1, pts[0]!)).toBeLessThan(1e-9);
        expect(offFace(e, 2, pts[ARC_SEGMENTS]!)).toBeLessThan(1e-9);
      });
    }
  }

  it("leaves a chamfer as it is whatever continuity is passed", () => {
    const e = SECTIONS.find((s) => s.angle === 90)!;
    const samples = [sampleOf(e, 0), sampleOf(e, 10)];
    const g1 = sweepBlendGhost(samples, 4, "chamfer", false, undefined, "G1");
    expect(g1).not.toBeNull();
    expect(sweepBlendGhost(samples, 4, "chamfer", false, undefined, "G3")!.positions).toEqual(g1!.positions);
  });
});

function offFace(e: Entry, which: 1 | 2, p: V2): number {
  const { side, bend } = faceOf(e, which);
  if (!bend) return Math.abs(p[0] * side[0] + p[1] * side[1]);
  const o: V2 = [side[0] / bend, side[1] / bend];
  return Math.abs(Math.hypot(p[0] - o[0], p[1] - o[1]) - 1 / Math.abs(bend));
}
