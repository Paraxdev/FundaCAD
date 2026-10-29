// A row of bodies, each `facesPer` unit squares of two triangles in three shades with an edge between neighbours,
// plus a snapshot of everything the highlighter paints, to compare a box delta with a clear and select build.
import * as THREE from "three";
import { BodyEdges, type EdgeRef } from "../../src/viewport/edgeLines";
import type { Highlighter } from "../../src/viewport/highlight";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

export function bodiesRig(bodies: number, facesPer: number) {
  const list: BodyMesh[] = [];
  const draws: BodyEdges[] = [];
  for (let b = 0; b < bodies; b++) {
    const faceStart = b * facesPer;
    const tris = facesPer * 2;
    const pos = new Float32Array(tris * 9);
    const colors = new Float32Array(tris * 9);
    const faceIds: number[] = [];
    const faceTriangles = new Map<number, number[]>();
    let t = 0;
    for (let f = 0; f < facesPer; f++) {
      const own: number[] = [];
      const shade = f % 3 === 0 ? 0.9 : f % 3 === 1 ? 0.15 : 0.55;
      for (let k = 0; k < 2; k++, t++) {
        const q = k === 0 ? [f, 0, f + 1, 0, f + 1, 1] : [f, 0, f + 1, 1, f, 1];
        for (let v = 0; v < 3; v++) {
          pos.set([q[v * 2]! + b * 1000, q[v * 2 + 1]!, 0], t * 9 + v * 3);
          colors.set([shade, shade * 0.8, shade * 0.6], t * 9 + v * 3);
        }
        faceIds.push(faceStart + f);
        own.push(t);
      }
      faceTriangles.set(faceStart + f, own);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(
      new THREE.BufferAttribute(
        Uint32Array.from({ length: tris * 3 }, (_, i) => i),
        1,
      ),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(colors.slice(), 3));
    const edgeList = Array.from({ length: facesPer - 1 }, (_, i) => ({
      id: `e${i}`,
      body: `b${b}`,
      points: [
        [i + 1 + b * 1000, 0, 0],
        [i + 1 + b * 1000, 1, 0],
      ],
    }));
    const draw = new BodyEdges(edgeList as never, new THREE.Vector2(800, 600));
    draws.push(draw);
    list.push({
      id: `b${b}`,
      faceStart,
      faceCount: facesPer,
      mesh: new THREE.Mesh(geometry),
      faceIds,
      faceTriangles,
      baseColors: colors,
      edges: draw,
    } as unknown as BodyMesh);
  }
  return { view: { bodies: list } as unknown as ModelView, draws, bodies: list, refs: draws.flatMap((d) => d.refs) };
}

export type BodiesRig = ReturnType<typeof bodiesRig>;

interface Painted {
  selectedFaces: Set<number>;
  selectedEdges: Set<EdgeRef>;
  selectedBodies: Set<string>;
  bodyGlows: Map<string, THREE.Mesh>;
  selectLines: Map<BodyEdges, { edges: EdgeRef[]; starts: number[]; hexes: number[]; col: Float32Array }>;
  overlays: Record<"hover" | "select", { meshes: THREE.Mesh[]; shown: boolean } | null>;
  hoverLine: { edge: EdgeRef } | null;
}

const r4 = (a: ArrayLike<number>) => Array.from(a, (x) => +x.toFixed(4));
const edgeName = (e: EdgeRef) => `${e.body}:${e.id}`;

/** Every colour, overlay and wide line the highlighter shows, in an order that does not depend on how it got there,
 *  apart from the selection lists, whose order the starters read. */
export function painted(h: Highlighter, rig: BodiesRig) {
  const p = h as unknown as Painted;
  const own = (d: BodyEdges) => d as unknown as { rgb: Float32Array; colorBuf: Float32Array };
  const overlay = (kind: "hover" | "select") => {
    const o = p.overlays[kind];
    if (!o?.shown) return null;
    return o.meshes
      .map((m) => ({
        body: m.userData.body as string,
        parent: rig.bodies.findIndex((b) => b.mesh === m.parent),
        pos: r4(m.geometry.getAttribute("position").array).join(),
        col: r4(m.geometry.getAttribute("color").array).join(),
      }))
      .sort((a, b) => a.body.localeCompare(b.body));
  };
  return {
    faces: h.getSelectedFaces(),
    edges: h.getSelectedEdges().map(edgeName),
    bodies: h.getSelectedBodies(),
    glows: [...p.bodyGlows.keys()].sort(),
    faceColours: rig.bodies.map((b) => r4(b.mesh.geometry.getAttribute("color").array)),
    edgeColours: rig.draws.map((d) => r4(own(d).rgb)),
    edgeBuffers: rig.draws.map((d) => r4(own(d).colorBuf)),
    lines: [...p.selectLines]
      .map(([d, g]) => ({
        draw: rig.draws.indexOf(d),
        edges: g.edges
          .map((e, i) => [edgeName(e), g.hexes[i], r4(g.col.slice(g.starts[i], g.starts[i + 1])).join()])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      }))
      .sort((a, b) => a.draw - b.draw),
    hoverOverlay: overlay("hover"),
    selectOverlay: overlay("select"),
    hoverLine: p.hoverLine ? edgeName(p.hoverLine.edge) : null,
  };
}

/** The selection queues its overlay and wide lines per microtask. */
export const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
