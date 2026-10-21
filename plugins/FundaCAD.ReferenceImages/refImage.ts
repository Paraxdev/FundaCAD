// One reference image as the document stores it. The app keeps each entry
// whole, so writing one back starts from what was read: a field a newer
// version of this plugin added survives an older one.

import type { PlaneSpec } from "fundacad";
import type { Placement, V2 } from "./calibrate";

export interface RefImage extends Placement {
  id: string;
  name: string;
  /** The blob store hash of the file's bytes. */
  image: string;
  mime: string;
  plane: PlaneSpec;
  /** A datum plane the image follows when the datum moves. */
  planeId?: string;
  opacity: number;
  locked: boolean;
  hidden: boolean;
}

export const MIN_OPACITY = 0.05;

const HASH = /^[0-9a-f]{32}$/;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const pair = (v: unknown, d: V2): V2 =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? [v[0], v[1]] : d;

function isPlane(v: unknown): v is PlaneSpec {
  if (v === "XY" || v === "XZ" || v === "YZ") return true;
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["origin", "normal", "xdir"].every((k) => Array.isArray(o[k]) && (o[k] as unknown[]).length === 3);
}

/** Null for an entry with no image to draw. */
export function readRefImage(raw: Readonly<Record<string, unknown>>): RefImage | null {
  if (typeof raw.id !== "string" || typeof raw.image !== "string" || !HASH.test(raw.image)) return null;
  const px = pair(raw.px, [1, 1]);
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.id,
    image: raw.image,
    mime: typeof raw.mime === "string" ? raw.mime : "image/png",
    px: px[0] > 0 && px[1] > 0 ? px : [1, 1],
    plane: isPlane(raw.plane) ? raw.plane : "XY",
    ...(typeof raw.planeId === "string" && raw.planeId ? { planeId: raw.planeId } : {}),
    at: pair(raw.at, [0, 0]),
    width: num(raw.width, 100) > 0 ? num(raw.width, 100) : 100,
    angle: num(raw.angle, 0),
    flipX: raw.flipX === true,
    flipY: raw.flipY === true,
    opacity: Math.min(1, Math.max(MIN_OPACITY, num(raw.opacity, 0.5))),
    locked: raw.locked === true,
    hidden: raw.hidden === true,
  };
}

/** The document list with `id` replaced by `change` applied, unknown fields kept. */
export function patched(
  list: readonly Readonly<Record<string, unknown>>[],
  id: string,
  change: Partial<RefImage>,
): Record<string, unknown>[] {
  return list.map((raw) => (raw.id === id ? { ...structuredClone(raw), ...change } : structuredClone(raw)));
}

export function freshId(list: readonly Readonly<Record<string, unknown>>[]): string {
  const taken = new Set(list.map((e) => e.id));
  let i = list.length + 1;
  while (taken.has(`ri${i}`)) i++;
  return `ri${i}`;
}
