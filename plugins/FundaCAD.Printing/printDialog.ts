// Filament-mapping dialog for "Send to Printer": for each colored slot the job
// uses (logical gcode tool Tn = palette slot index), pick which physical U1
// toolhead is loaded with that filament. Pre-matched by material type, then
// nearest color, the same client-side reconciliation Snapmaker Orca does.
//
// choice.ts's chooseMulti can't express per-row dropdowns, so this is a bespoke
// modal built on the shared .choice-* styles. The markup is
// ./FilamentMappingDialog.vue; the reconciliation below is pure and stays
// here, where printFlow.ts's other pure helpers are.

import { openFilamentMapping } from "./state";
import type { StartOpts, ToolheadFilament } from "./printerClient";

export interface LogicalSlot {
  index: number; // palette slot index = logical gcode tool Tn
  name: string;
  color: string; // "#RRGGBB"
  material?: string;
}

export interface MappingResult {
  mapTable: [number, number][]; // [logical slot, physical toolhead]
  opts: StartOpts;
}

function rgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
}

function colorDist(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/** Best physical toolhead for a logical slot: prefer a present toolhead whose
 *  material matches, break ties (and material-less palettes) by nearest color. */
export function autoMatch(slot: LogicalSlot, toolheads: ToolheadFilament[]): number {
  const present = toolheads.filter((t) => t.present);
  const pool = present.length ? present : toolheads;
  let best = pool[0]?.index ?? slot.index;
  let bestScore = Infinity;
  for (const t of pool) {
    const materialMiss = slot.material && t.material && slot.material.toLowerCase() !== t.material.toLowerCase() ? 1e9 : 0;
    const score = materialMiss + colorDist(slot.color, t.color);
    if (score < bestScore) {
      bestScore = score;
      best = t.index;
    }
  }
  return best;
}

/** "3: Polymaker PLA" / "2: Toolhead 2 (empty)". */
export function toolheadLabel(t: ToolheadFilament): string {
  const name = `${t.vendor} ${t.material}`.trim() || `Toolhead ${t.index + 1}`;
  return `${t.index + 1}: ${name}${t.present ? "" : " (empty)"}`;
}

export function filamentMappingDialog(
  slots: LogicalSlot[],
  toolheads: ToolheadFilament[],
): Promise<MappingResult | null> {
  return openFilamentMapping(slots, toolheads);
}
