// The unit of a glTF, VRML or X3D file. The specs say metres but writers rarely mean it, so each import asks
// and the last answer, a per-user preference, is the next default.

import { t } from "../i18n";
import type { ImportFormat } from "../types";
import { choose } from "../ui/choice";

export type ImportUnit = "mm" | "cm" | "m" | "inch";

const UNITS: { readonly value: ImportUnit; readonly label: string }[] = [
  {
    value: "mm",
    get label() {
      return t("import.unit.mm");
    },
  },
  {
    value: "cm",
    get label() {
      return t("import.unit.cm");
    },
  },
  {
    value: "m",
    get label() {
      return t("import.unit.m");
    },
  },
  {
    value: "inch",
    get label() {
      return t("import.unit.inch");
    },
  },
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
  return [...(first ? [{ ...first, hint: t("import.unit.lastUsed") }] : []), ...rest];
}

/** Ask which unit the file is in, null when the dialog is dismissed or `signal` aborts. */
export async function askImportUnit(fmt: ImportFormat, signal?: AbortSignal): Promise<ImportUnit | null> {
  const pick = await choose(t("import.unit.ask", { format: fmt.toUpperCase() }), unitChoices(lastImportUnit()), signal);
  const unit = asImportUnit(pick);
  if (unit) rememberImportUnit(unit);
  return unit;
}
