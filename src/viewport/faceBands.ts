/** A pick lands on a whole run of faces that are really one surface.
 *
 *  A helical groove cut into a shank leaves the shank between turns as a helical
 *  ribbon. That is one region of one cylinder, but a face may not wrap more than
 *  once around a periodic surface, so the kernel stores it as one face per turn
 *  and no repair can merge them: there is no single face for them to become. The
 *  spool document has a run of seven. Clicking one and pulling gives you a
 *  stripe, which is not what anybody meant by that click.
 *
 *  The sidecar (face_bands.py) decides what a run is, since only it can read the
 *  surfaces; this side only has to turn its per-body answer into "given the face
 *  you clicked, which faces did you mean". Kept apart from the viewport so the
 *  lookup can be tested against plain numbers, with no scene and no kernel.
 */

/** The part of a body's build metadata this needs: where its faces start in the
 *  global numbering, and its runs in that body's own LOCAL numbering. */
export interface BandBody {
  faceStart: number;
  faceCount: number;
  faceBands?: number[][] | undefined;
}

/** Global face id -> every face in its run, that face included, ascending.
 *
 *  One entry per member rather than one per run, so a pick is a single lookup.
 *  The arrays are shared between a run's members: nothing may write to them. */
export type BandIndex = ReadonlyMap<number, readonly number[]>;

/** Fold every body's runs into one index over global face ids. Bodies with no
 *  run cost nothing, which is nearly all of them. */
export function bandIndex(bodies: readonly BandBody[]): BandIndex {
  const out = new Map<number, readonly number[]>();
  for (const b of bodies) {
    for (const run of b.faceBands ?? []) {
      // A run reaching outside its own body would make a pick select another
      // body's faces, so it is dropped rather than clamped: a run that cannot be
      // trusted about its own extent cannot be trusted about its members.
      if (run.some((i) => i < 0 || i >= b.faceCount)) continue;
      const global = run.map((i) => i + b.faceStart).sort((x, y) => x - y);
      if (global.length < 2) continue;
      for (const id of global) out.set(id, global);
    }
  }
  return out;
}

/** The faces a click on `faceId` means: its whole run, or just it. */
export function expandToBand(faceId: number, index: BandIndex): readonly number[] {
  return index.get(faceId) ?? [faceId];
}
