// Which ways each sketch shape can still move, worked out by solves that hold one shape at a time.

import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { compileAndSolve, type ProbeAxis } from "./sketchSolve";

export interface Freedom {
  x: boolean;
  y: boolean;
  size: boolean;
}

// A slanted 40 shape sketch took 92 probe solves, 91 ms on a desktop in Power saver, and each solve grows with the sketch.
export const MAX_PROBED = 60;
// Probes yield a macrotask after this much work, so a big sketch never holds a frame for long.
const SLICE_MS = 12;

const SOLVED = new Set<ResolvedEntity["type"]>(["line", "rectangle", "circle", "arc", "spline", "bspline", "point"]);

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function freedomWords(f: Freedom | undefined): string {
  if (!f) return "";
  const ways = [f.x && "X", f.y && "Y", f.size && "size"].filter((w): w is string => !!w);
  const last = ways.pop();
  if (!last) return "fixed";
  return `free in ${ways.length ? `${ways.join(", ")} and ${last}` : last}`;
}

/** null while constraints conflict, when the solver is down, or once `isStale` says a newer sketch is waiting.
 *  Polygons, slots and text never reach the solver and get no entry, nor do shapes past `MAX_PROBED`. */
export async function shapeFreedom(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  isStale: () => boolean = () => false,
): Promise<Map<string, Freedom> | null> {
  try {
    const base = await compileAndSolve(entities, constraints);
    if (!base.ok || base.conflicts.length) return null;
    const out = new Map<string, Freedom>();
    let probed = 0;
    let slice = performance.now();
    for (const e of entities) {
      if (e.type !== "projected" && !SOLVED.has(e.type)) continue;
      const f: Freedom = { x: false, y: false, size: false };
      if (e.type === "projected" || base.dof === 0) {
        out.set(e.id, f);
        continue;
      }
      if (probed++ >= MAX_PROBED) continue;
      const axes: ProbeAxis[] = e.type === "circle" || e.type === "arc" ? ["x", "y", "size"] : ["x", "y"];
      for (const axis of axes) {
        if (performance.now() - slice > SLICE_MS) {
          await nextTask();
          slice = performance.now();
        }
        if (isStale()) return null;
        const held = await compileAndSolve(entities, constraints, undefined, { probe: { entity: e.id, axis } });
        f[axis] = held.dof < base.dof;
      }
      out.set(e.id, f);
    }
    return isStale() ? null : out;
  } catch {
    return null;
  }
}
