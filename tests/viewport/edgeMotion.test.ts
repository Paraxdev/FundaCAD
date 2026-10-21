// The edge lines get cheaper while the camera moves only where they cost, and
// come back at rest on a fade nobody notices (src/viewport/edgeMotion.ts).
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BLEND_DELAY_MS, BLEND_MS, EdgeBlend, EdgeMotionRule, MERGE_OFF_DRAWS, MERGE_ON_DRAWS, ease, type EdgeLoad,
} from "../../src/viewport/edgeMotion";
import { EdgeBatches, type EdgeFrame } from "../../src/viewport/edgeBatches";
import { BodyEdges } from "../../src/viewport/edgeLines";

const PART: EdgeLoad = { draws: 40, segments: 20_000, triangles: 400_000 };
const ASSEMBLY: EdgeLoad = { draws: 1310, segments: 821_690, triangles: 11_350_000 };
const PLATES: EdgeLoad = { draws: 64, segments: 46_848, triangles: 165_000 };

function gesture(rule: EdgeMotionRule, load: EdgeLoad, periods: number[], now: number): string[] {
  const modes = [rule.gestureStart(load, now)];
  for (const p of periods) {
    now += p;
    modes.push(rule.sample(p, now));
  }
  return modes;
}

describe("the edge level rule", () => {
  it("leaves a small part's edges full on every frame", () => {
    const r = new EdgeMotionRule();
    expect(new Set(gesture(r, PART, Array(40).fill(8), 0))).toEqual(new Set(["full"]));
  });

  it("merges a big assembly's edges from the first moving frame, with hysteresis on the draw count", () => {
    const r = new EdgeMotionRule();
    expect(r.gestureStart(ASSEMBLY, 0)).toBe("merged");
    const at = (draws: number) => r.gestureStart({ ...ASSEMBLY, draws }, 0);
    expect(at(MERGE_ON_DRAWS + 16)).toBe("merged");
    expect(at(300)).toBe("merged");
    expect(at(MERGE_OFF_DRAWS + 4)).toBe("merged");
    expect(at(MERGE_OFF_DRAWS - 6)).toBe("full");
    expect(at(300)).toBe("full");
    expect(at(MERGE_ON_DRAWS)).toBe("merged");
  });

  it("never changes merging mid gesture", () => {
    const r = new EdgeMotionRule();
    r.gestureStart(ASSEMBLY, 0);
    expect(new Set(gesture(r, ASSEMBLY, Array(20).fill(10), 0).slice(1))).toEqual(new Set(["merged"]));
  });

  it("draws a slow renderer's edges thin after two slow windows, and remembers it once the next gesture's fat lines are slow too", () => {
    const r = new EdgeMotionRule();
    const modes = gesture(r, PLATES, [...Array(8).fill(470), ...Array(8).fill(92)], 0);
    expect(new Set(modes.slice(0, 8))).toEqual(new Set(["full"]));
    expect(new Set(modes.slice(8))).toEqual(new Set(["thin"]));
    const next = gesture(r, PLATES, [...Array(4).fill(470), ...Array(8).fill(92)], 5000);
    expect(new Set(next.slice(0, 4))).toEqual(new Set(["full"]));
    expect(new Set(next.slice(4))).toEqual(new Set(["thin"]));
    expect(r.gestureStart(PLATES, 9000)).toBe("thin");
  });

  it("brings the fat lines back for good when thin ones did not make the frames faster", () => {
    const r = new EdgeMotionRule();
    const modes = gesture(r, PLATES, [...Array(8).fill(470), ...Array(6).fill(400)], 0);
    expect(modes[8]).toBe("thin");
    expect(modes.at(-1)).toBe("full");
    expect(gesture(r, PLATES, Array(16).fill(470), 9000).includes("thin")).toBe(false);
    expect(gesture(r, { ...PLATES, segments: 10_000 }, Array(8).fill(470), 18_000).at(-1)).toBe("thin");
  });

  it("goes back to full when the model's segments change by more than half", () => {
    const r = new EdgeMotionRule();
    gesture(r, PLATES, Array(8).fill(470), 0);
    gesture(r, PLATES, Array(4).fill(470), 4000);
    expect(r.gestureStart({ ...PLATES, segments: PLATES.segments * 0.7 }, 6000)).toBe("thin");
    expect(r.gestureStart({ ...PLATES, segments: PLATES.segments * 0.4 }, 6000)).toBe("full");
  });

  it("goes back to full on reset, and probes the fat lines again once the verdict is old", () => {
    const r = new EdgeMotionRule();
    gesture(r, PLATES, Array(8).fill(470), 0);
    r.reset();
    expect(r.gestureStart(PLATES, 2000)).toBe("full");
    gesture(r, PLATES, Array(8).fill(470), 2000);
    // Confirmed by the next gesture, the verdict starts at that window's end.
    gesture(r, PLATES, Array(4).fill(470), 6000);
    const t = 6000 + 4 * 470;
    expect(r.gestureStart(PLATES, t + 25_000)).toBe("thin");
    expect(r.gestureStart(PLATES, t + 40_000)).toBe("full");
    // Found slow again: thin, and kept twice as long this time.
    expect(gesture(r, PLATES, Array(4).fill(470), t + 40_000).at(-1)).toBe("thin");
    const t2 = t + 40_000 + 4 * 470;
    expect(r.gestureStart(PLATES, t2 + 50_000)).toBe("thin");
    expect(r.gestureStart(PLATES, t2 + 70_000)).toBe("full");
  });

  it("is not turned on by one stall among fast frames", () => {
    const r = new EdgeMotionRule();
    expect(gesture(r, PLATES, [10, 600, 10, 10, 10, 10, 10, 10], 0).at(-1)).toBe("full");
  });

  it("is not turned on by a stall of a few frames on a fast GPU", () => {
    const r = new EdgeMotionRule();
    const modes = gesture(r, ASSEMBLY, [45, 45, 45, 10, ...Array(40).fill(10)], 0);
    expect(modes.includes("thin")).toBe(false);
    expect(modes.at(-1)).toBe("merged");
  });

  it("keeps a long stall's thin lines to that gesture, the next one finds the merged lines fast", () => {
    const r = new EdgeMotionRule();
    const modes = gesture(r, ASSEMBLY, [...Array(8).fill(45), ...Array(40).fill(10)], 0);
    expect(modes[8]).toBe("thin");
    expect(modes.at(-1)).toBe("thin");
    expect(new Set(gesture(r, ASSEMBLY, Array(40).fill(10), 3000))).toEqual(new Set(["merged"]));
    expect(new Set(gesture(r, ASSEMBLY, Array(40).fill(10), 40_000))).toEqual(new Set(["merged"]));
  });

  it("does not judge thin frames drawn on a canvas the motion level shrank since", () => {
    const r = new EdgeMotionRule();
    r.gestureStart(PLATES, 0);
    let now = 0;
    const run = (ms: number, n: number, scale: number) => {
      for (let i = 0; i < n; i++) r.sample(ms, (now += ms), scale);
      return r.mode;
    };
    expect(run(470, 8, 1)).toBe("thin");
    expect(run(60, 8, 0.7)).toBe("thin");
    // Not judged, so the next gesture measures the fat lines on the smaller canvas.
    expect(r.gestureStart(PLATES, now)).toBe("full");
    expect(run(250, 4, 0.7)).toBe("thin");
    expect(run(240, 8, 0.7)).toBe("full");
  });

  it("keeps a GPU that keeps up at 18 ms frames full", () => {
    const r = new EdgeMotionRule();
    expect(gesture(r, PLATES, Array(40).fill(18), 0).includes("thin")).toBe(false);
  });

  it("leaves a model whose edges are a small share of the frame full however slow", () => {
    const r = new EdgeMotionRule();
    expect(gesture(r, { draws: 30, segments: 5000, triangles: 2_000_000 }, Array(8).fill(200), 0).includes("thin")).toBe(false);
  });

  it("does not judge the frame that built the batches", () => {
    const r = new EdgeMotionRule();
    r.gestureStart(PLATES, 0);
    r.skipNext();
    expect([900, 10, 10, 10].map((p, i) => r.sample(p, i * 10)).at(-1)).toBe("full");
    expect(r.sample(10, 50)).toBe("full");
  });
});

describe("the edge blend", () => {
  it("is 0 while moving, waits for the camera to be still, then reaches 1 over BLEND_MS, never going down", () => {
    const b = new EdgeBlend();
    let t = 0;
    for (; t < 500; t += 16) expect(b.update(true, t, true)).toBeLessThanOrEqual(1);
    expect(b.update(true, t, true)).toBe(0);
    const still = t;
    let last = 0;
    const seen: number[] = [];
    for (t = still + 1; t < still + BLEND_DELAY_MS + BLEND_MS + 50; t += 4) {
      const w = b.update(false, t, true);
      if (t < still + BLEND_DELAY_MS) expect(w).toBe(0);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
      seen.push(w);
    }
    expect(last).toBe(1);
    expect(b.pending).toBe(false);
    expect(seen.some((w) => w > 0.2 && w < 0.8)).toBe(true);
  });

  it("follows the design easing", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    // cubic-bezier(0.2, 0, 0.15, 1) is past three quarters of the way at half time.
    expect(ease(0.5)).toBeGreaterThan(0.75);
    expect(ease(0.5)).toBeLessThan(0.95);
  });

  it("eases down from where it is when a gesture starts mid fade", () => {
    const b = new EdgeBlend();
    b.update(true, 0, true);
    let t = 200;
    b.update(true, t, true);
    let w = 0;
    for (t = 201; w < 0.5; t += 2) w = b.update(false, t, true);
    const first = b.update(true, t, true);
    expect(first).toBeGreaterThan(0.4);
    let prev = first;
    for (t += 4; prev > 0; t += 4) {
      const n = b.update(true, t, true);
      expect(n).toBeLessThanOrEqual(prev);
      prev = n;
    }
  });

  it("does not pulse when an orbit starts and stops in quick bursts", () => {
    const b = new EdgeBlend();
    let t = 0;
    for (let burst = 0; burst < 10; burst++) {
      for (const end = t + 50; t < end; t += 8) expect(b.update(true, t, true)).toBeLessThanOrEqual(1);
      // Within one rest the weight only ever goes one way.
      let prev = b.update(false, t, true);
      let dir = 0;
      for (const end = t + 80; t < end; t += 8) {
        const w = b.update(false, t, true);
        const d = Math.sign(w - prev);
        if (d !== 0 && dir !== 0) expect(d).toBe(dir);
        if (d !== 0) dir = d;
        prev = w;
      }
      if (burst > 0) expect(prev).toBe(0);
    }
  });

  it("steps at rest with Animations off", () => {
    const b = new EdgeBlend();
    b.update(true, 0, false);
    expect(b.update(false, BLEND_DELAY_MS - 1, false)).toBe(0);
    expect(b.update(false, BLEND_DELAY_MS, false)).toBe(1);
  });

  it("stays at 1 for a gesture that does not draw thin", () => {
    const b = new EdgeBlend();
    for (let t = 0; t < 300; t += 16) expect(b.update(false, t, true)).toBe(1);
    expect(b.pending).toBe(false);
  });
});

function body(id: string, x: number, n: number): BodyEdges {
  const edges = Array.from({ length: n }, (_, i) => ({
    id: `${id}e${i}`, body: id, points: [[x, i, 0], [x + 1, i, 0], [x + 2, i, 1]] as [number, number, number][],
  }));
  return new BodyEdges(edges, new THREE.Vector2(800, 600));
}

describe("the merged edge batches", () => {
  const setup = () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    scene.add(group);
    const members = Array.from({ length: 12 }, (_, i) => body(`b${i}`, i * 5, 3));
    for (const m of members) group.add(m.object);
    const keep = new Set<string>();
    const frame: EdgeFrame = { members, thin: false, weight: 1, keep: (e) => keep.has(e.refs[0]!.body!) };
    return { scene, group, members, keep, frame, batches: new EdgeBatches() };
  };
  const drawn = (scene: THREE.Scene) => {
    const out: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.LineSegments).isLineSegments) out.push(o);
    });
    return out;
  };

  it("draws every segment once, hides the bodies for the render only, and puts them back", () => {
    const { scene, members, frame, batches } = setup();
    batches.begin(frame);
    expect(batches.drawn.segments).toBe(12 * 3 * 2);
    expect(members.every((m) => !m.object.visible)).toBe(true);
    expect(drawn(scene).every((o) => o.name === "edge-batch")).toBe(true);
    batches.end();
    expect(members.every((m) => m.object.visible)).toBe(true);
    expect(drawn(scene).filter((o) => o.name.startsWith("edge-batch"))).toEqual([]);
  });

  it("leaves a selected, hovered or moved body to draw its own full edges", () => {
    const { scene, members, keep, frame, batches } = setup();
    keep.add("b3");
    members[5]!.object.position.x = 4;
    batches.begin(frame);
    const own = drawn(scene).filter((o) => o.name === "edges");
    expect(own).toEqual([members[3]!.object, members[5]!.object]);
    expect(batches.drawn.segments).toBe(10 * 3 * 2);
    batches.end();
  });

  it("carries a recolour of a member into its batch", () => {
    const { scene, members, frame, batches } = setup();
    batches.begin(frame);
    batches.end();
    members[7]!.setColor(1, new THREE.Color(1, 0, 0));
    batches.begin(frame);
    const reds: number[] = [];
    for (const o of drawn(scene).filter((d) => d.name === "edge-batch")) {
      const a = (o as THREE.Mesh).geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute;
      const arr = a.data.array as Float32Array;
      for (let s = 0; s < arr.length / 6; s++) if (arr[s * 6] === 1 && arr[s * 6 + 1] === 0) reds.push(s);
    }
    expect(reds.length).toBe(2);
    batches.end();
  });

  it("draws the thin twin and the fat set at the blend weight", () => {
    const { scene, members, frame, batches } = setup();
    frame.thin = true;
    frame.weight = 0.25;
    batches.begin(frame);
    const names = drawn(scene).map((o) => o.name);
    expect(names.filter((n) => n === "edge-batch-thin").length).toBeGreaterThan(0);
    const fat = drawn(scene).find((o) => o.name === "edge-batch") as THREE.Mesh;
    expect((fat.material as THREE.Material).opacity).toBeCloseTo(members[0]!.material.opacity * 0.25);
    frame.weight = 0;
    batches.end();
    batches.begin(frame);
    expect(drawn(scene).map((o) => o.name).includes("edge-batch")).toBe(false);
    batches.end();
  });
});
