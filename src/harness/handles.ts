// Named drag handles on screen (features/manipulator.ts nameHandle): where to
// press, and which way a drag moves the value.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import { HarnessError } from "./locate";
import { canvasTest, type CanvasTest } from "./picks";

export interface HandleHost {
  viewport: Pick<Viewport, "scene" | "projectToScreen" | "rayFrom" | "pixelWorldSize" | "domElement">;
}

export interface HandleInfo {
  name: string;
  x: number;
  y: number;
  dir: [number, number];
  pxPerMm: number;
  what: string;
}

function shown(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}

export function namedHandles(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (typeof o.userData.handle === "string" && shown(o, root)) out.push(o);
  });
  return out;
}

/** The handle's extent in its own frame, invisible grab volumes included. */
function localBox(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const inv = obj.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  obj.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g?.isBufferGeometry) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (g.boundingBox) box.union(g.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
  });
  return box;
}

const FRACTIONS = [0.5, 0.7, 0.3, 0.85, 0.15, 0.95, 0.05, 0.98, 0.02];

function samples(box: THREE.Box3): THREE.Vector3[] {
  if (box.isEmpty()) return [new THREE.Vector3()];
  const c = box.getCenter(new THREE.Vector3());
  const out = [c.clone()];
  for (const f of FRACTIONS) out.push(new THREE.Vector3(c.x, box.min.y + f * (box.max.y - box.min.y), c.z));
  for (const f of FRACTIONS) out.push(new THREE.Vector3(box.min.x + f * (box.max.x - box.min.x), c.y, c.z));
  return out;
}

function aim(h: HandleHost, obj: THREE.Object3D, onCanvas: CanvasTest): { x: number; y: number } | null {
  for (const local of samples(localBox(obj))) {
    const p = h.viewport.projectToScreen(local.applyMatrix4(obj.matrixWorld));
    if (!onCanvas(p.x, p.y)) continue;
    if (h.viewport.rayFrom(p.x, p.y).intersectObject(obj, true).length) return { x: p.x, y: p.y };
  }
  return null;
}

function axis(h: HandleHost, obj: THREE.Object3D): { dir: [number, number]; pxPerMm: number } {
  const at = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(obj.matrixWorld);
  const mm = (h.viewport.pixelWorldSize(at) || 1) * 50;
  const a = h.viewport.projectToScreen(at);
  const b = h.viewport.projectToScreen(at.clone().addScaledVector(up, mm));
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { dir: [0, 0], pxPerMm: 0 };
  return { dir: [dx / len, dy / len], pxPerMm: len / mm };
}

function splitIndex(name: string): { base: string; nth: number | null } {
  const m = /^(.*)#(\d+)$/.exec(name.trim());
  return m ? { base: m[1]!.trim(), nth: Number(m[2]) } : { base: name.trim(), nth: null };
}

export function handleList(h: HandleHost, onCanvas: CanvasTest = canvasTest(h.viewport.domElement)): string[] {
  const all = namedHandles(h.viewport.scene.scene);
  all.forEach((o) => o.updateWorldMatrix(true, true));
  const seen = new Map<string, number>();
  return all.map((o) => {
    const name = o.userData.handle as string;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const hit = aim(h, o, onCanvas);
    const label = all.filter((x) => x.userData.handle === name).length > 1 ? `${name}#${n}` : name;
    return hit ? `${label} at ${Math.round(hit.x)},${Math.round(hit.y)}` : `${label} covered`;
  });
}

export function handlePoint(
  h: HandleHost,
  name: string,
  onCanvas: CanvasTest = canvasTest(h.viewport.domElement),
): HandleInfo {
  const { base, nth } = splitIndex(name);
  const all = namedHandles(h.viewport.scene.scene);
  const named = all.filter((o) => (o.userData.handle as string).toLowerCase() === base.toLowerCase());
  if (!named.length) {
    const names = [...new Set(all.map((o) => o.userData.handle as string))];
    throw new HarnessError(
      names.length
        ? `no handle "${base}" on screen, there are: ${names.join(", ")}`
        : `no handle "${base}" on screen, no tool has a handle up`,
      "NotFound",
      names,
    );
  }
  if (named.length > 1 && nth == null) {
    throw new HarnessError(
      `${named.length} handles are named "${base}", add #1 to #${named.length}`,
      "Ambiguous",
      named.map((_, i) => `${base}#${i + 1}`),
    );
  }
  const obj = named[(nth ?? 1) - 1];
  if (!obj)
    throw new HarnessError(
      `there are ${named.length} handles named "${base}", not ${nth}`,
      "NotFound",
      named.map((_, i) => `${base}#${i + 1}`),
    );
  obj.updateWorldMatrix(true, true);
  const hit = aim(h, obj, onCanvas);
  if (!hit) throw new HarnessError(`handle "${name}" is off screen or covered, try another view`, "Occluded");
  return { name: obj.userData.handle as string, ...hit, ...axis(h, obj), what: `handle ${name}` };
}

/** A press here would land on a handle (the Move gizmo a body selection
 *  carries, a tool's arrow) rather than on the model under it. */
export function overHandle(h: HandleHost, x: number, y: number, pad = 8): boolean {
  const all = namedHandles(h.viewport.scene.scene);
  if (!all.length) return false;
  for (const [dx, dy] of [
    [0, 0],
    [pad, 0],
    [-pad, 0],
    [0, pad],
    [0, -pad],
  ] as const) {
    const rc = h.viewport.rayFrom(x + dx, y + dy);
    if (all.some((o) => rc.intersectObject(o, true).length)) return true;
  }
  return false;
}
