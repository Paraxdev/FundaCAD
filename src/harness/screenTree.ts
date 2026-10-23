// What is on screen, as the agent harness reads it: every visible control with
// a ref that stays stable across label rewording (see docs/HARNESS.md).

export * from "../ui/controlRefs";
import { REGIONS, type Line, type Walk } from "../ui/controlRefs";

export interface ScreenArgs {
  region?: string;
  max?: number;
}

/** The readout `s.screen()` prints: region headers at depth 0, controls at 1. */
export function screenLines(walk: Walk, args: ScreenArgs = {}): { lines: Line[]; truncated: number } {
  const max = args.max ?? 150;
  const lines: Line[] = [];
  let truncated = 0;
  for (const region of REGIONS) {
    if (args.region && args.region !== region) continue;
    const rows = walk.controls.filter((c) => c.region === region);
    const hidden = walk.more[region] ?? 0;
    if (!rows.length && !hidden) continue;
    const block: Line[] = [[0, region, "region", walk.notes[region] ?? "", []]];
    for (const c of rows) block.push([1, c.ref, c.role, c.label, c.flags]);
    if (hidden) block.push([1, "", "more", `${hidden} more`, []]);
    for (const l of block) {
      if (lines.length >= max) truncated++;
      else lines.push(l);
    }
  }
  return { lines, truncated };
}
