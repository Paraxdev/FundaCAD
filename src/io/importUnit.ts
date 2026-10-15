// The unit a glTF, VRML or X3D file is in. Those formats leave it to the
// reader, the specs say metres and nearly everything that writes them means
// whatever its own unit was, so each import asks and the last answer is the
// next default. A per-user preference, not part of any document.

import type { ImportFormat } from "../types";
import { choose } from "../ui/choice";

export type ImportUnit = "mm" | "cm" | "m" | "inch";

const UNITS: { value: ImportUnit; label: string }[] = [
  { value: "mm", label: "Millimetres" },
  { value: "cm", label: "Centimetres" },
  { value: "m", label: "Metres" },
  { value: "inch", label: "Inches" },
];

const KEY = "fundacad.importUnit";
const SPEC_UNIT: ImportUnit = "m";
const ASKED: ReadonlySet<ImportFormat> = new Set(["glb", "gltf", "vrml", "x3d"]);

export function asksForUnit(fmt: ImportFormat): boolean {
  return ASKED.has(fmt);
}

export function asImportUnit(v: unknown): ImportUnit | null {
  return UNITS.some((u) => u.value === v) ? (v as ImportUnit) : null;
}

export function lastImportUnit(): ImportUnit {
  try {
    return asImportUnit(localStorage.getItem(KEY)) ?? SPEC_UNIT;
  } catch {
    return SPEC_UNIT;
  }
}

export function rememberImportUnit(unit: ImportUnit): void {
  try {
    localStorage.setItem(KEY, unit);
  } catch {
    // The choice still applies to this import.
  }
}

/** The choices with the last one first. */
export function unitChoices(last: ImportUnit) {
  const first = UNITS.find((u) => u.value === last);
  const rest = UNITS.filter((u) => u.value !== last);
  return [...(first ? [{ ...first, hint: "last used" }] : []), ...rest];
}

/** Ask which unit the file is in, null when the dialog is dismissed. */
export async function askImportUnit(fmt: ImportFormat): Promise<ImportUnit | null> {
  const pick = await choose(`What unit is this ${fmt.toUpperCase()} file in?`, unitChoices(lastImportUnit()));
  const unit = asImportUnit(pick);
  if (unit) rememberImportUnit(unit);
  return unit;
}
