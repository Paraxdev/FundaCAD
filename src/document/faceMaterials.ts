// Materials on single faces, keyed `bodyId#localFaceIndex` like imported face colours. The store keeps a ref per
// assignment that follows its face across builds (faceRefs.ts) and hands this module the resolved keys.

import { finishOf, type BodyFinish, type MaterialDef } from "./materials";

// "#" rather than ":" because a hand-edited body id may contain a colon, while no id generator here produces "#".
export const FACE_KEY_SEP = "#";

export function faceKey(body: string, localFace: number): string {
  return `${body}${FACE_KEY_SEP}${localFace}`;
}

// Tolerant: it reads saved files, and a hand-edited document must not throw here.
export function parseFaceKey(k: string): { body: string; face: number } | null {
  const at = k.lastIndexOf(FACE_KEY_SEP);
  if (at <= 0) return null;
  const body = k.slice(0, at);
  const tail = k.slice(at + 1);
  // `Number("")` is 0, a valid face index, so "body1#" would read as body1's first face without this.
  if (!/^\d+$/.test(tail)) return null;
  const face = Number(tail);
  if (!Number.isSafeInteger(face)) return null;
  return { body, face };
}

export interface BodyFaceSpan {
  id: string;
  faceStart: number;
  faceCount: number;
}

// Global ids because the viewport paints by the id a pick returns. Entries for a gone body, a face index past the end
// or a deleted material are dropped silently, so the face falls back to its body's material.
export function resolveFaceMaterials(
  assigned: Iterable<readonly [string, string]>,
  bodies: readonly BodyFaceSpan[] | undefined,
  library: readonly MaterialDef[],
): Map<number, MaterialDef> {
  const out = new Map<number, MaterialDef>();
  if (!bodies?.length) return out;
  const span = new Map(bodies.map((b) => [b.id, b]));
  for (const [key, matId] of assigned) {
    const parsed = parseFaceKey(key);
    if (!parsed) continue;
    const b = span.get(parsed.body);
    if (!b || parsed.face >= b.faceCount) continue;
    const m = library.find((x) => x.id === matId);
    if (!m) continue;
    out.set(b.faceStart + parsed.face, m);
  }
  return out;
}

export function faceMaterialPaint(resolved: Map<number, MaterialDef>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [fid, m] of resolved) out[fid] = m.color;
  return out;
}

// Sparse against the default finish, not the body's: a colour-only material travels through the paint map already.
export function faceMaterialFinishes(resolved: Map<number, MaterialDef>): Record<number, BodyFinish> {
  const out: Record<number, BodyFinish> = {};
  for (const [fid, m] of resolved) out[fid] = finishOf(m);
  return out;
}

export function staleFaceKeys(
  assigned: Iterable<readonly [string, string]>,
  bodies: readonly BodyFaceSpan[] | undefined,
): string[] {
  if (!bodies) return [];
  const live = new Set(bodies.map((b) => b.id));
  const out: string[] = [];
  for (const [key] of assigned) {
    const parsed = parseFaceKey(key);
    if (!parsed || !live.has(parsed.body)) out.push(key);
  }
  return out;
}
