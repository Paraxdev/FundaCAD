// Where on the canvas a face, edge or plane can be clicked, each point checked with the app's own picker first.

import * as THREE from "three";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "../sketch/plane";
import { HarnessError } from "./locate";

export type CanvasTest = (x: number, y: number) => boolean;

/** Inside the canvas and not under a panel or a popover. */
export function canvasTest(canvas: HTMLCanvasElement, doc: Document = canvas.ownerDocument): CanvasTest {
  return (x, y) => {
    const r = canvas.getBoundingClientRect();
    if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return false;
    return doc.elementFromPoint(x, y) === canvas;
  };
}

export interface PickHost {
  store: Pick<DocumentStore, "buildState">;
  viewport: Pick<
    Viewport,
    "faceTriangles" | "projectToScreen" | "pickEntity" | "pickEdgeAt" | "pickConstructionAt" | "scene" | "domElement"
  >;
  sketch: { readonly active: boolean; readonly activePlane: Pick<SketchPlane, "to3D"> };
}

import * as sel from "../viewport/modelSelectors";
import { SelectorError, along, axisWord, edgeName, edgePts, type FaceInfo } from "../viewport/modelSelectors";

export type { FaceInfo };
export const faceInfo = sel.faceInfo;

function asHarness<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof SelectorError) throw new HarnessError(err.message, err.kind, err.candidates);
    throw err;
  }
}

export const facesOf = (h: PickHost, body: Parameters<typeof sel.facesOf>[1]) => sel.facesOf(h, body);
export const resolveFace = (h: PickHost, s: string) => asHarness(() => sel.resolveFace(h, s));
export const resolveEdge = (h: PickHost, s: string) => asHarness(() => sel.resolveEdge(h, s));

const VIEW_FOR: Record<string, string> = {
  "+z": "top",
  "-z": "bottom",
  "-y": "front",
  "+y": "back",
  "+x": "right",
  "-x": "left",
};

/** Points worth trying on a face: middles of its biggest triangles first. */
export function faceSamples(f: FaceInfo): THREE.Vector3[] {
  const big = f.tris
    .slice()
    .sort((a, b) => b.getArea() - a.getArea())
    .slice(0, 12);
  const out = big.map((t) => t.getMidpoint(new THREE.Vector3()));
  for (const t of big.slice(0, 4)) {
    for (const [u, v, w] of [
      [0.6, 0.2, 0.2],
      [0.2, 0.6, 0.2],
      [0.2, 0.2, 0.6],
    ] as const) {
      out.push(new THREE.Vector3().addScaledVector(t.a, u).addScaledVector(t.b, v).addScaledVector(t.c, w));
    }
  }
  return out;
}

export function facePoint(h: PickHost, sel: string, onCanvas: CanvasTest = canvasTest(h.viewport.domElement)) {
  const f = resolveFace(h, sel);
  const what = `${f.body}:index=${f.index} ${f.planar ? axisWord(f.normal) : "curved"} area ${Math.round(f.area)}`;
  for (const w of faceSamples(f)) {
    const p = h.viewport.projectToScreen(w);
    if (!onCanvas(p.x, p.y)) continue;
    const hit = h.viewport.pickEntity(p.x, p.y);
    if (hit?.kind === "face" && hit.faceId === f.faceId) {
      return { x: p.x, y: p.y, faceId: f.faceId, body: f.body, index: f.index, what };
    }
  }
  const view = f.planar ? (VIEW_FOR[axisWord(f.normal)] ?? "iso") : "iso";
  throw new HarnessError(`face ${what} cannot be clicked from this view, try s.view("${view}")`, "Occluded");
}

const EDGE_FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];

/** `via: "edge"` checks the point with the edge tools' own pick (fillet, chamfer). */
export function edgePoint(
  h: PickHost,
  sel: string,
  via: "select" | "edge" = "select",
  onCanvas: CanvasTest = canvasTest(h.viewport.domElement),
) {
  const e = resolveEdge(h, sel);
  const pts = edgePts(e);
  for (const f of EDGE_FRACTIONS) {
    const p = h.viewport.projectToScreen(along(pts, f));
    if (!onCanvas(p.x, p.y)) continue;
    const hit = via === "edge" ? h.viewport.pickEdgeAt(p.x, p.y) : h.viewport.pickEntity(p.x, p.y);
    if (hit?.kind === "edge" && hit.edge.id === e.id)
      return { x: p.x, y: p.y, edgeId: e.id, body: e.body ?? null, what: `edge ${edgeName(e)}` };
  }
  throw new HarnessError(`edge ${edgeName(e)} cannot be clicked from this view, try another s.view(...)`, "Occluded");
}

function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function planeObject(h: PickHost, name: string): { obj: THREE.Object3D; base: boolean } {
  const key = name.trim().toUpperCase();
  if (key === "XY" || key === "XZ" || key === "YZ") return { obj: h.viewport.scene.planes[key], base: true };
  let found: THREE.Object3D | null = null;
  h.viewport.scene.scene.traverse((o) => {
    if (!found && o.userData.datumId === name.trim() && (o as THREE.Mesh).isMesh) found = o;
  });
  if (!found) throw new HarnessError(`no plane "${name}", use XY, XZ, YZ or a datum plane's feature id`, "NotFound");
  return { obj: found, base: false };
}

export function planePoint(h: PickHost, name: string, onCanvas: CanvasTest = canvasTest(h.viewport.domElement)) {
  const { obj, base } = planeObject(h, name);
  if (!shown(obj)) {
    throw new HarnessError(
      h.sketch.active
        ? `plane ${name} is hidden, a sketch is open and already on its plane, finish it to start one on another`
        : `plane ${name} is hidden, the origin planes show only while a tool asks for a plane, such as Sketch`,
      "Occluded",
    );
  }
  obj.updateWorldMatrix(true, false);
  const g = (obj as THREE.Mesh).geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const box = g.boundingBox ?? new THREE.Box3(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 0));
  const want = base ? name.trim().toUpperCase() : name.trim();
  for (const [u, v] of [
    [0.5, 0.5],
    [0.3, 0.3],
    [0.7, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
    [0.15, 0.5],
    [0.85, 0.5],
    [0.5, 0.15],
    [0.5, 0.85],
  ] as const) {
    const local = new THREE.Vector3(
      box.min.x + u * (box.max.x - box.min.x),
      box.min.y + v * (box.max.y - box.min.y),
      (box.min.z + box.max.z) / 2,
    );
    const p = h.viewport.projectToScreen(local.applyMatrix4(obj.matrixWorld));
    if (!onCanvas(p.x, p.y)) continue;
    const hit = h.viewport.pickConstructionAt(p.x, p.y);
    const got = hit?.kind === "base" ? hit.plane : hit?.kind === "datum" ? hit.id : null;
    if (got === want) return { x: p.x, y: p.y, what: `plane ${want}` };
  }
  throw new HarnessError(`plane ${want} cannot be clicked from this view`, "Occluded");
}

export function worldPoint(
  h: PickHost,
  x: number,
  y: number,
  z: number,
  onCanvas: CanvasTest = canvasTest(h.viewport.domElement),
) {
  const p = h.viewport.projectToScreen(new THREE.Vector3(x, y, z));
  return { x: p.x, y: p.y, covered: !onCanvas(p.x, p.y) };
}

export function sketchPoint(
  h: PickHost,
  x: number,
  y: number,
  onCanvas: CanvasTest = canvasTest(h.viewport.domElement),
) {
  if (!h.sketch.active) throw new HarnessError("no sketch is open", "BadArgs");
  const p = h.viewport.projectToScreen(h.sketch.activePlane.to3D(x, y));
  return { x: p.x, y: p.y, covered: !onCanvas(p.x, p.y) };
}
