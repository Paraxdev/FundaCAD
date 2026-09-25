// The face a hole sits on, written as a `tracked` selector so the hole follows
// the face through a parameter change instead of staying where it was drawn.
//
// `extent` is the face outline's extent in the engine's own face frame, taken
// from a build's `trackedFaces`: only the engine measures it, so it is written
// back from a build rather than worked out here.

import type { Selector, TrackedFaceRecord, Vec3 } from "../types";

type Tracked = Extract<Selector, { by: "tracked" }>;
type Extent = [number, number, number, number];

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

/** The build's extent written into a tracked face that has neither an extent nor a centre yet. */
export function withExtent(face: Selector, rec: TrackedFaceRecord | undefined): Selector {
  if (face.by !== "tracked" || face.extent || face.center || !rec?.extent) return face;
  return { ...face, extent: [...rec.extent] as Extent };
}

/** A hole's face and positions moved to where the last build put them, so an
 *  edit starts from the holes on screen and writes an extent that is current. */
export function rebaseHole(face: Selector, points: Vec3[], rec: TrackedFaceRecord | undefined): { face: Selector; points: Vec3[] } {
  if (face.by !== "tracked" || !rec || rec.points.length !== points.length) return { face, points };
  const { center: _was, extent: _then, ...rest } = face;
  const moved: Tracked = {
    ...rest,
    point: [...rec.point] as Vec3,
    ...(rec.extent ? { extent: [...rec.extent] as Extent } : {}),
  };
  return { face: moved, points: rec.points.map((p) => [...p] as Vec3) };
}
