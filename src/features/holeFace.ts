// The face a hole sits on, written as a `tracked` selector so the hole follows
// the face through a parameter change instead of staying where it was drawn.
//
// `center` is the face outline's centre as the engine measured it, taken from
// a build's `faceCenters`: a hole's positions move by however far that centre
// has moved since, which only the engine can say exactly.

import type { Selector, Vec3 } from "../types";

type Tracked = Extract<Selector, { by: "tracked" }>;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function trackedFace(point: Vec3, normal: Vec3, body: string | null): Selector {
  const n = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return {
    kind: "face", by: "tracked", point: [...point] as Vec3,
    normal: normal.map((c) => round6(c / n)) as Vec3,
    ...(body ? { body } : {}),
  } as Selector;
}

/** A point-only face selector becomes a tracked one on the face it names now. */
export function upgradeFace(face: Selector, normal: Vec3): Selector {
  if (face.kind !== "face" || face.by !== "nearest") return face;
  return trackedFace(face.point, normal, face.body ?? null);
}

/** The build's outline centre written into a tracked face that has none yet. */
export function withCenter(face: Selector, now: Vec3 | undefined): Selector {
  if (face.by !== "tracked" || face.center || !now) return face;
  return { ...face, center: [...now] as Vec3 };
}

/** A hole's face and positions moved to where the last build put them, so an
 *  edit starts from the holes on screen and writes a centre that is current. */
export function rebaseHole(face: Selector, points: Vec3[], now: Vec3 | undefined): { face: Selector; points: Vec3[] } {
  if (face.by !== "tracked" || !face.center || !now) return { face, points };
  const c = face.center;
  const d: Vec3 = [now[0] - c[0], now[1] - c[1], now[2] - c[2]];
  const move = (p: Vec3): Vec3 => [round6(p[0] + d[0]), round6(p[1] + d[1]), round6(p[2] + d[2])];
  const moved: Tracked = { ...face, point: move(face.point), center: [...now] as Vec3 };
  return { face: moved, points: points.map(move) };
}
