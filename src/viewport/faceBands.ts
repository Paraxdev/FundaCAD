// A pick on one face of a run that is really one surface (a helical ribbon the kernel stores as a face per turn) takes
// the whole run. The engine (face_bands.py) finds the runs, this turns them into a lookup.

/** The part of a body's build metadata this needs: where its faces start in the
 *  global numbering, and its runs in that body's own LOCAL numbering. */
export interface BandBody {
  faceStart: number;
  faceCount: number;
  faceBands?: number[][] | undefined;
}

/** Global face id -> every face in its run, itself included, ascending. The arrays are shared between members: never
 *  write to them. */
export type BandIndex = ReadonlyMap<number, readonly number[]>;

/** Bodies with no run, nearly all of them, cost nothing. */
export function bandIndex(bodies: readonly BandBody[]): BandIndex {
  const out = new Map<number, readonly number[]>();
  for (const b of bodies) {
    for (const run of b.faceBands ?? []) {
      // A run reaching outside its body would select another body's faces, so it is dropped rather than clamped.
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
