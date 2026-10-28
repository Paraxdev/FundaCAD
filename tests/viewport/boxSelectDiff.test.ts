// A box drag replaced the whole selection on every frame that changed it: with 50,000 edges selected each pointer move
// repainted every edge, retinted them all once per face, and rebuilt every body's wide select line.
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Highlighter } from "../../src/viewport/highlight";
import type { BodyEdges, EdgeRef } from "../../src/viewport/edgeLines";
import type { BodyMesh, ModelView } from "../../src/viewport/render";
import { costRig } from "./pickCostRig";

const tick = () => Promise.resolve();
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => i + from);
const pickLines = (draw: BodyEdges) => draw.object.children.filter((c) => c.name === "edge-pick-line");
const edgeColours = (draw: BodyEdges) =>
  Array.from((draw.object.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data.array);
const faceColours = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute("color").array);

function countPaints(draw: BodyEdges) {
  const set = vi.spyOn(draw, "setColor");
  const idle = vi.spyOn(draw, "setIdleColor");
  return () => set.mock.calls.length + idle.mock.calls.length;
}

function twoDraws() {
  const a = costRig(6, 2);
  const b = costRig(6, 2);
  const bodyB = b.view.bodies[0] as BodyMesh & { id: string };
  bodyB.id = "b2";
  const view = { bodies: [a.view.bodies[0], bodyB] } as unknown as ModelView;
  return { view, a: a.draw, b: b.draw };
}

describe("a box frame changes only what entered or left the box", () => {
  it("adding one edge to 50,000 selected paints that edge alone", async () => {
    const { view, draw } = costRig(50010, 2);
    const h = new Highlighter(view);
    h.replaceSelection([], draw.refs.slice(0, 50000));
    await tick();
    const paints = countPaints(draw);
    h.replaceSelection([], draw.refs.slice(0, 50001));
    await tick();
    expect(paints()).toBeLessThanOrEqual(2);
    expect(h.getSelectedEdges()).toHaveLength(50001);
  }, 60000);

  it("adding one edge beside 50,000 selected in one body rebuilds a short stretch of its select line", async () => {
    const { view, draw } = costRig(50010, 2);
    const h = new Highlighter(view);
    h.replaceSelection([], draw.refs.slice(0, 50000));
    await tick();
    const rebuilt = vi.spyOn(LineSegmentsGeometry.prototype, "setPositions");
    h.replaceSelection([], draw.refs.slice(0, 50001));
    await tick();
    const floats = rebuilt.mock.calls.reduce((n, [pos]) => n + (pos as ArrayLike<number>).length, 0);
    rebuilt.mockRestore();
    expect(floats).toBeGreaterThan(0);
    expect(floats).toBeLessThan(20000);
    const shown = pickLines(draw).reduce(
      (n, l) => n + (l as LineSegments2).geometry.getAttribute("instanceStart").count,
      0,
    );
    expect(shown).toBe(50001);
  }, 60000);

  it("faces entering the box retint the selected edges once, not once per face", async () => {
    const { view, draw } = costRig(2001, 2);
    const h = new Highlighter(view);
    h.replaceSelection([], draw.refs);
    await tick();
    const paints = countPaints(draw);
    h.replaceSelection(range(1000), draw.refs);
    await tick();
    expect(paints()).toBeLessThanOrEqual(2 * draw.refs.length);
    expect(h.getSelectedFaces()).toHaveLength(1000);
  }, 60000);

  it("leaves the same colours as clearing and selecting again", async () => {
    const old = costRig(8, 2);
    const now = costRig(8, 2);
    const hOld = new Highlighter(old.view);
    const hNow = new Highlighter(now.view);
    const steps: [number[], number[]][] = [
      [
        [0, 1],
        [0, 1, 2],
      ],
      [
        [1, 2],
        [1, 3],
      ],
      [[], [4]],
      [[5], []],
      [[], []],
    ];
    for (const [faces, edges] of steps) {
      hOld.clearSelection();
      for (const f of faces) hOld.selectFace(f);
      for (const e of edges) hOld.selectEdge(old.draw.refs[e]!);
      hNow.replaceSelection(
        faces,
        edges.map((e) => now.draw.refs[e]!),
      );
      await tick();
      expect(hNow.getSelectedFaces().sort()).toEqual([...faces].sort());
      expect(hNow.getSelectedEdges().map((e) => e.slot)).toEqual(hOld.getSelectedEdges().map((e) => e.slot));
      expect(edgeColours(now.draw)).toEqual(edgeColours(old.draw));
      expect(faceColours(now.mesh)).toEqual(faceColours(old.mesh));
      expect(pickLines(now.draw)).toHaveLength(pickLines(old.draw).length);
    }
  });

  it("keeps the select line of a body whose edges did not change", async () => {
    const { view, a, b } = twoDraws();
    const h = new Highlighter(view);
    const pick = (draw: BodyEdges, ...slots: number[]): EdgeRef[] => slots.map((s) => draw.refs[s]!);
    h.replaceSelection([], [...pick(a, 0), ...pick(b, 0)]);
    await tick();
    const lineA = pickLines(a)[0];
    const lineB = pickLines(b)[0];
    expect(lineA).toBeDefined();
    h.replaceSelection([], [...pick(a, 0), ...pick(b, 0, 1)]);
    await tick();
    expect(pickLines(a)).toEqual([lineA]);
    expect(pickLines(b)).toHaveLength(1);
    expect(pickLines(b)[0]).not.toBe(lineB);
    h.clearSelection();
    await tick();
    expect(pickLines(a)).toHaveLength(0);
    expect(pickLines(b)).toHaveLength(0);
  });
});
