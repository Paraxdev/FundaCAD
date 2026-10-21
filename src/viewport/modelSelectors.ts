// Model selectors read against the built model: faces by index, direction or
// nearest point, edges by the faces they join or a point near them. Shared by the
// agent harness picks and guide mode outlines.

import * as THREE from "three";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "./viewport";

export class SelectorError extends Error {
  constructor(
    message: string,
    readonly kind: "NotFound" | "Ambiguous" | "BadArgs",
    readonly candidates: string[] = [],
  ) {
    super(message);
  }
}

export interface SelectorHost {
  store: Pick<DocumentStore, "buildState">;
  viewport: Pick<Viewport, "faceTriangles">;
}

export interface FaceInfo {
  body: string;
  index: number;
  faceId: number;
  area: number;
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
  planar: boolean;
  tris: THREE.Triangle[];
}

const PLANAR_COS = Math.cos((1 * Math.PI) / 180);
const MATCH_COS = Math.cos((2 * Math.PI) / 180);

export function faceInfo(tris: THREE.Triangle[], body: string, index: number, faceId: number): FaceInfo {
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Vector3();
  let area = 0;
  for (const t of tris) {
    const a = t.getArea();
    t.getNormal(n);
    normal.addScaledVector(n, a);
    centroid.addScaledVector(t.getMidpoint(c), a);
    area += a;
  }
  if (area > 0) centroid.divideScalar(area);
  normal.normalize();
  const planar = tris.every((t) => t.getArea() < 1e-12 || t.getNormal(n).dot(normal) >= PLANAR_COS);
  return { body, index, faceId, area, normal, centroid, planar, tris };
}

export type Body = NonNullable<NonNullable<DocumentStore["buildState"]["result"]>["bodies"]>[number];

function bodyList(h: SelectorHost): Body[] {
  return h.store.buildState.result?.bodies ?? [];
}

export function facesOf(h: SelectorHost, body: Body): FaceInfo[] {
  const out: FaceInfo[] = [];
  for (let i = 0; i < body.faceCount; i++) {
    const fid = body.faceStart + i;
    const tris = h.viewport.faceTriangles(fid);
    if (tris.length) out.push(faceInfo(tris, body.id, i, fid));
  }
  return out;
}

const NAMED: Record<string, [number, number, number]> = {
  top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
  "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1],
};

function vec(text: string, what: string): THREE.Vector3 {
  const parts = text.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) {
    throw new SelectorError(`${what} needs three numbers like 10,0,5, got "${text}"`, "BadArgs");
  }
  return new THREE.Vector3(parts[0], parts[1], parts[2]);
}

function triDistance(tris: THREE.Triangle[], p: THREE.Vector3): number {
  const q = new THREE.Vector3();
  let best = Infinity;
  for (const t of tris) best = Math.min(best, t.closestPointToPoint(p, q).distanceTo(p));
  return best;
}

function boundsOf(tris: THREE.Triangle[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const t of tris) box.expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
  return box;
}

/** Splits `body1:top` into the body and the words. */
function splitBody(h: SelectorHost, sel: string): { bodies: Body[]; words: string; named: boolean } {
  const all = bodyList(h);
  const m = /^([^:=\s]+):(.*)$/.exec(sel.trim());
  if (m) {
    const key = m[1]!.toLowerCase();
    const b = all.find((x) => x.id.toLowerCase() === key) ?? all.find((x) => x.name.toLowerCase() === key);
    if (!b) throw new SelectorError(`no body "${m[1]}"`, "NotFound", all.map((x) => x.id));
    return { bodies: [b], words: m[2]!.trim().toLowerCase(), named: true };
  }
  return { bodies: all, words: sel.trim().toLowerCase(), named: false };
}

function onlyBody(bodies: Body[], words: string): Body {
  if (bodies.length === 1) return bodies[0]!;
  if (!bodies.length) throw new SelectorError("there is no body on screen", "NotFound");
  throw new SelectorError(`${bodies.length} bodies, name one: ${bodies.map((b) => `${b.id}:${words}`).join(", ")}`, "Ambiguous", bodies.map((b) => `${b.id}:${words}`));
}

function byDirection(faces: FaceInfo[], dir: THREE.Vector3): FaceInfo | null {
  const d = dir.clone().normalize();
  const hits = faces.filter((f) => f.planar && f.normal.dot(d) >= MATCH_COS);
  if (!hits.length) return null;
  const top = Math.max(...hits.map((f) => f.area));
  return hits
    .filter((f) => f.area >= top * 0.999)
    .reduce((a, b) => (b.centroid.dot(d) > a.centroid.dot(d) ? b : a));
}

export function resolveFace(h: SelectorHost, sel: string): FaceInfo {
  const { bodies, words } = splitBody(h, sel);
  if (words.startsWith("near=")) {
    const p = vec(words.slice(5), "near=");
    let best: FaceInfo | null = null;
    let bestD = Infinity;
    for (const b of bodies) for (const f of facesOf(h, b)) {
      const d = triDistance(f.tris, p);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best) throw new SelectorError("there is no face on screen", "NotFound");
    return best;
  }
  const body = onlyBody(bodies, words);
  const faces = facesOf(h, body);
  if (words.startsWith("index=")) {
    const i = Number(words.slice(6));
    const f = faces.find((x) => x.index === i);
    if (!f && Number.isInteger(i) && i >= 0 && i < body.faceCount) {
      throw new SelectorError(`face ${i} of ${body.id} has nothing drawn, so there is no point on it to pick`, "NotFound");
    }
    if (!f) throw new SelectorError(`${body.id} has faces 0 to ${body.faceCount - 1}, not ${words.slice(6)}`, "NotFound");
    return f;
  }
  const dirText = words.startsWith("normal=") ? null : NAMED[words];
  if (dirText || words.startsWith("normal=")) {
    const d = dirText ? new THREE.Vector3(...dirText) : vec(words.slice(7), "normal=");
    const f = byDirection(faces, d);
    if (!f) throw new SelectorError(`${body.id} has no flat face facing ${words}`, "NotFound", faceSummary(faces));
    return f;
  }
  const m = /^(largest|smallest)(?:\s+(planar|curved))?$/.exec(words);
  if (m) {
    const pool = faces.filter((f) => !m[2] || (m[2] === "planar") === f.planar);
    if (!pool.length) throw new SelectorError(`${body.id} has no ${m[2]} face`, "NotFound");
    return pool.reduce((a, b) => ((m[1] === "largest" ? b.area > a.area : b.area < a.area) ? b : a));
  }
  throw new SelectorError(
    `cannot read face selector "${sel}", use top, bottom, front, back, left, right, +x, normal=x,y,z, largest, smallest, near=x,y,z or index=n`,
    "BadArgs",
  );
}

export function axisWord(n: THREE.Vector3): string {
  const a = [n.x, n.y, n.z].map(Math.abs);
  const i = a.indexOf(Math.max(...a));
  const s = [n.x, n.y, n.z][i]! >= 0 ? "+" : "-";
  return `${s}${"xyz"[i]}`;
}

export function faceSummary(faces: FaceInfo[]): string[] {
  return faces
    .slice()
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .map((f) => `${f.body}:index=${f.index} ${f.planar ? axisWord(f.normal) : "curved"} area ${Math.round(f.area)}`);
}

export type Edge = NonNullable<DocumentStore["buildState"]["result"]>["edges"][number];

function polyLength(pts: THREE.Vector3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += pts[i]!.distanceTo(pts[i - 1]!);
  return l;
}

export function along(pts: THREE.Vector3[], f: number): THREE.Vector3 {
  const total = polyLength(pts);
  let left = total * f;
  for (let i = 1; i < pts.length; i++) {
    const seg = pts[i]!.distanceTo(pts[i - 1]!);
    if (left <= seg && seg > 0) return pts[i - 1]!.clone().lerp(pts[i]!, left / seg);
    left -= seg;
  }
  return pts[pts.length - 1]!.clone();
}

export function edgePts(e: Edge): THREE.Vector3[] {
  return e.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
}

function segDistance(pts: THREE.Vector3[], p: THREE.Vector3): number {
  if (pts.length === 1) return pts[0]!.distanceTo(p);
  const line = new THREE.Line3();
  const q = new THREE.Vector3();
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    line.set(pts[i - 1]!, pts[i]!);
    best = Math.min(best, line.closestPointToPoint(p, true, q).distanceTo(p));
  }
  return best;
}

export function edgeName(e: Edge): string {
  const m = along(edgePts(e), 0.5);
  const r = (v: number) => Math.round(v * 100) / 100;
  return `${e.body ? `${e.body}:` : ""}near=${r(m.x)},${r(m.y)},${r(m.z)}`;
}

export function resolveEdge(h: SelectorHost, sel: string): Edge {
  const { bodies, words, named } = splitBody(h, sel);
  const ids = new Set(bodies.map((b) => b.id));
  const all = (h.store.buildState.result?.edges ?? []).filter((e) => e.points.length && (!named || (e.body != null && ids.has(e.body))));
  if (!all.length) throw new SelectorError("there is no edge on screen", "NotFound");
  if (words.startsWith("near=")) {
    const p = vec(words.slice(5), "near=");
    return all.reduce((a, b) => (segDistance(edgePts(b), p) < segDistance(edgePts(a), p) ? b : a));
  }
  if (words === "longest" || words === "shortest") {
    const body = onlyBody(bodies, words);
    const own = all.filter((e) => e.body === body.id);
    if (!own.length) throw new SelectorError(`${body.id} has no edges`, "NotFound");
    return own.reduce((a, b) => ((words === "longest" ? polyLength(edgePts(b)) > polyLength(edgePts(a)) : polyLength(edgePts(b)) < polyLength(edgePts(a))) ? b : a));
  }
  const m = /^between\s+(\S+)\s+(\S+)$/.exec(words);
  if (m) {
    const body = onlyBody(bodies, words);
    const fa = resolveFace(h, `${body.id}:${m[1]}`);
    const fb = resolveFace(h, `${body.id}:${m[2]}`);
    const box = h.store.buildState.result?.bbox;
    const diag = box ? Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) : 100;
    const tol = Math.max(1e-3, diag * 2e-3);
    const both = boundsOf(fa.tris).expandByScalar(tol).intersect(boundsOf(fb.tris).expandByScalar(tol));
    const on = (e: Edge) => {
      const pts = edgePts(e);
      let misses = Math.floor(pts.length * 0.1);
      for (const p of pts) {
        if (both.containsPoint(p) && triDistance(fa.tris, p) <= tol && triDistance(fb.tris, p) <= tol) continue;
        if (--misses < 0) return false;
      }
      return true;
    };
    const found = all.filter((e) => e.body === body.id && on(e));
    if (!found.length) throw new SelectorError(`no edge between ${m[1]} and ${m[2]} on ${body.id}`, "NotFound");
    if (found.length > 1) throw new SelectorError(`${found.length} edges between ${m[1]} and ${m[2]}, pick one by near=`, "Ambiguous", found.map(edgeName));
    return found[0]!;
  }
  throw new SelectorError(`cannot read edge selector "${sel}", use near=x,y,z, between <face> <face>, longest or shortest`, "BadArgs");
}
