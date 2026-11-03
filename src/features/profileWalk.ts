// The order and words of Extrude's profile walk by keys. Pure, so the order is tested without a viewport.

import { regionArea, type Region } from "../sketch/region";
import { displayRound, getUnit, toDisplay } from "../ui/units";

export interface WalkRegion {
  region: Region;
  /** Glyphs of one text share it and are walked as one profile. */
  groupId?: string;
}

export interface WalkUnit<T extends WalkRegion> {
  members: T[];
  area: number;
  holes: number;
}

const SAME_AREA = 1e-9;

/** Largest area first, a tie by the position of its first member, then by input order. */
export function walkUnits<T extends WalkRegion>(regions: readonly T[]): WalkUnit<T>[] {
  const byGroup = new Map<string, WalkUnit<T>>();
  const units: WalkUnit<T>[] = [];
  for (const wr of regions) {
    const own = { area: regionArea(wr.region), holes: wr.region.holes.length };
    const joined = wr.groupId === undefined ? undefined : byGroup.get(wr.groupId);
    if (joined) {
      joined.members.push(wr);
      joined.area += own.area;
      joined.holes += own.holes;
      continue;
    }
    const unit = { members: [wr], ...own };
    units.push(unit);
    if (wr.groupId !== undefined) byGroup.set(wr.groupId, unit);
  }
  const at = (u: WalkUnit<T>) => u.members[0]!.region.interior;
  const order = new Map(units.map((u, i) => [u, i]));
  return units.sort((a, b) => {
    if (Math.abs(b.area - a.area) > SAME_AREA) return b.area - a.area;
    const pa = at(a);
    const pb = at(b);
    return pa.x - pb.x || pa.y - pb.y || order.get(a)! - order.get(b)!;
  });
}

/** The next index in a ring of `count`; -1 (nothing lit) steps onto the first going forward, the last going back. */
export function walkStep(count: number, at: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (at < 0 || at >= count) return dir === 1 ? 0 : count - 1;
  return (at + dir + count) % count;
}

function areaWords(mm2: number): string {
  const f = toDisplay(1);
  return `${displayRound(mm2 * f * f)} ${getUnit()}²`;
}

export function walkWords<T extends WalkRegion>(
  unit: WalkUnit<T>,
  index: number,
  count: number,
  picked: boolean,
): string {
  const holes = unit.holes === 0 ? "no holes" : unit.holes === 1 ? "1 hole" : `${unit.holes} holes`;
  const parts = [`Profile ${index + 1} of ${count}`, `area ${areaWords(unit.area)}`, holes];
  if (unit.members.length > 1) parts.push(`${unit.members.length} shapes taken together`);
  if (picked) parts.push("picked");
  return `${parts.join(", ")}.`;
}
