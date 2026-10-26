// The face hover overlay on a selected body copies the hovered triangles into a
// geometry of its own. Every rebuild replaces the Highlighter and reuses the body
// mesh, so an overlay left on the mesh or cached by the old highlighter leaked one
// geometry per rebuild (NV3R-2).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Highlighter } from "../../src/viewport/highlight";
import type { BodyMesh, ModelView } from "../../src/viewport/render";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import { MIN_CONTRAST, contrastRatio } from "../../src/viewport/pickColors";

function view(): { view: ModelView; mesh: THREE.Mesh } {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const n = geometry.getAttribute("position").count;
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const mesh = new THREE.Mesh(geometry);
  const tris = geometry.getIndex()!.count / 3;
  const faceIds = Array.from({ length: tris }, (_, t) => Math.floor(t / 2));
  const faceTriangles = new Map<number, number[]>();
  faceIds.forEach((f, t) => faceTriangles.set(f, [...(faceTriangles.get(f) ?? []), t]));
  const body = {
    id: "b1",
    name: "Body1",
    faceStart: 0,
    faceCount: 6,
    mesh,
    faceIds,
    baseColors: new Float32Array(n * 3),
    faceTriangles,
  } as unknown as BodyMesh;
  return { view: { bodies: [body] } as unknown as ModelView, mesh };
}

/** Live overlay geometries: every one ever made, minus the disposed ones. */
function tracker(mesh: THREE.Mesh) {
  const live = new Set<THREE.BufferGeometry>();
  return {
    live,
    note() {
      for (const c of mesh.children) {
        if (c.name !== "face-hover-overlay") continue;
        const g = (c as THREE.Mesh).geometry;
        if (live.has(g)) continue;
        live.add(g);
        g.addEventListener("dispose", () => live.delete(g));
      }
    },
  };
}

describe("face hover overlay lifetime", () => {
  it("draws a hovered face again over the body, glowing or not, only while it is hovered", () => {
    const { view: v, mesh } = view();
    const h = new Highlighter(v);
    const overlays = () => mesh.children.filter((c) => c.name === "face-hover-overlay");
    h.hoverFace(0);
    expect(overlays()).toHaveLength(1);
    h.toggleSelectBody("b1");
    expect(overlays()).toHaveLength(1);
    h.hoverFace(null);
    expect(overlays()).toHaveLength(0);
  });

  it("a repaint of the base under a selected face uploads the whole buffer, not only the face's range", () => {
    const { view: v, mesh } = view();
    const h = new Highlighter(v);
    h.selectFace(0);
    h.setBase(() => new THREE.Color(0x2a2d33));
    const attr = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    expect(attr.updateRanges).toHaveLength(0);
    h.dispose();
  });

  it("draws the selected faces once a batch of picks is done, and takes them down on clear", async () => {
    const { view: v, mesh } = view();
    const h = new Highlighter(v);
    const overlays = () => mesh.children.filter((c) => c.name === "face-select-overlay");
    h.selectFace(0);
    h.selectFace(1);
    await Promise.resolve();
    expect(overlays()).toHaveLength(1);
    expect((overlays()[0] as THREE.Mesh).geometry.getAttribute("position").count).toBe(12);
    h.clearSelection();
    expect(overlays()).toHaveLength(0);
    h.dispose();
  });

  it("does not leak a geometry per rebuild, shown or cached when the rebuild lands", () => {
    const { view: v, mesh } = view();
    const t = tracker(mesh);
    let h: Highlighter | null = null;
    for (let rebuild = 0; rebuild < 6; rebuild++) {
      // what viewport.setModel does with a reused body
      h?.dispose();
      h = new Highlighter(v);
      h.toggleSelectBody("b1");
      h.hoverFace(rebuild % 3);
      t.note();
      // every other rebuild lands while the overlay is hidden and only cached
      if (rebuild % 2) h.hoverFace(null);
    }
    expect(t.live.size).toBeLessThanOrEqual(1);
    h!.dispose();
    expect(t.live.size).toBe(0);
  });

  it("a new highlighter frees an overlay the old one left on the mesh without being disposed", () => {
    const { view: v, mesh } = view();
    const t = tracker(mesh);
    const old = new Highlighter(v);
    old.toggleSelectBody("b1");
    old.hoverFace(1);
    t.note();
    expect(t.live.size).toBe(1);
    new Highlighter(v);
    expect(t.live.size).toBe(0);
  });

  it("hovers a face of 200k triangles on a selected body without throwing", () => {
    const tris = 200_000;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setIndex(
      new THREE.BufferAttribute(
        new Uint32Array(tris * 3).map((_, i) => i % 3),
        1,
      ),
    );
    const mesh = new THREE.Mesh(geometry);
    const faceTriangles = new Map<number, number[]>([[0, Array.from({ length: tris }, (_, t) => t)]]);
    const body = {
      id: "b1",
      name: "Body1",
      faceStart: 0,
      faceCount: 1,
      mesh,
      faceIds: new Array(tris).fill(0),
      baseColors: new Float32Array(9),
      faceTriangles,
    } as unknown as BodyMesh;
    const h = new Highlighter({ bodies: [body] } as unknown as ModelView);
    h.toggleSelectBody("b1");
    expect(() => h.hoverFace(0)).not.toThrow();
    const overlay = mesh.children.find((c) => c.name === "face-hover-overlay") as THREE.Mesh;
    expect(overlay.geometry.getAttribute("position").count).toBe(tris * 3);
    h.dispose();
  });
});

describe("a selected edge is measured against the faces beside it", () => {
  function edgeRig() {
    const { view: v, mesh } = view();
    const painted: THREE.Color[] = [];
    // +x (face 0) and +y (face 2) of the box meet along x = y = 0.5
    const edge = {
      body: "b1",
      slot: 0,
      points: [
        [0.5, 0.5, -0.5],
        [0.5, 0.5, 0.5],
      ],
      draw: { setColor: (_s: number, c: THREE.Color) => painted.push(c.clone()), setIdleColor: () => {} },
    } as unknown as EdgeRef;
    return { v, mesh, edge, painted };
  }

  it("repaints a selected edge when the colours under it change", () => {
    const { v, edge, painted } = edgeRig();
    const h = new Highlighter(v);
    h.setBase(() => new THREE.Color(0xeeeeee));
    h.selectEdge(edge);
    const onLight = painted.at(-1)!.getHex();
    // an analysis colouring paints only the two faces beside the edge dark
    h.setBase((f) => new THREE.Color(f === 0 || f === 2 ? 0x1a1a1a : 0xeeeeee));
    const onDark = painted.at(-1)!.getHex();
    expect(contrastRatio(onDark, 0x1a1a1a)).toBeGreaterThanOrEqual(MIN_CONTRAST.select);
    expect(onDark).not.toBe(onLight);
    h.dispose();
  });
});

describe("a picked edge is drawn wide", () => {
  it("selected wider than hovered, both wider than idle, and gone on clear", async () => {
    const { BodyEdges, EDGE_IDLE_WIDTH } = await import("../../src/viewport/edgeLines");
    const { view: v } = view();
    const draw = new BodyEdges(
      [
        {
          id: "e1",
          body: "b1",
          points: [
            [0.5, 0.5, -0.5],
            [0.5, 0.5, 0.5],
          ],
        },
        {
          id: "e2",
          body: "b1",
          points: [
            [-0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
          ],
        },
      ] as never,
      new THREE.Vector2(800, 600),
    );
    const h = new Highlighter(v);
    const lines = () =>
      draw.object.children
        .filter((c) => c.name === "edge-pick-line")
        .map((c) => ((c as THREE.Mesh).material as THREE.Material & { linewidth: number }).linewidth)
        .sort();
    h.selectEdge(draw.refs[0]!);
    h.hoverEdge(draw.refs[1]!);
    await Promise.resolve();
    const [hover, select] = lines();
    expect(hover).toBeGreaterThan(EDGE_IDLE_WIDTH);
    expect(select).toBeGreaterThan(hover!);
    h.clearSelection();
    h.hoverEdge(null);
    await Promise.resolve();
    expect(lines()).toEqual([]);
    h.dispose();
  });
});

describe("an edge beside a selected face", () => {
  it("stands out from the face's pick colour, not only from its base", () => {
    const { view: v } = view();
    const painted: THREE.Color[] = [];
    const edge = {
      body: "b1",
      slot: 0,
      points: [
        [0.5, 0.5, -0.5],
        [0.5, 0.5, 0.5],
      ],
      draw: { setColor: (_s: number, c: THREE.Color) => painted.push(c.clone()), setIdleColor: () => {} },
    } as unknown as EdgeRef;
    const h = new Highlighter(v);
    h.setBase(() => new THREE.Color(0x2a2d33));
    h.selectEdge(edge);
    const alone = painted.at(-1)!.getHex();
    h.selectFace(0);
    const beside = painted.at(-1)!.getHex();
    expect(beside).not.toBe(alone);
    h.dispose();
  });
});
