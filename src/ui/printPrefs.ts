// Print-estimate preferences for the Properties panel: which material and
// infill the filament estimate was last computed with, remembered per user
// like renderPrefs/units (one JSON key, sanitised field by field on read).

import { readSetting } from "./storedSetting";
import { MATERIAL_PRESETS, CUSTOM_MATERIAL_ID } from "../features/filamentEstimate";

export interface PrintPrefs {
  /** A MATERIAL_PRESETS id, or "custom". */
  materialId: string;
  /** g/cm3, used only when materialId is "custom". */
  customDensity: number;
  /** 0-100. */
  infillPct: number;
  /** Combined wall/top/bottom shell thickness, mm. */
  wallThicknessMm: number;
}

const KEY = "fundacad.printPrefs";

export const DEFAULT_PRINT_PREFS: PrintPrefs = {
  materialId: MATERIAL_PRESETS[0]!.id, // PLA
  customDensity: 1.24,
  infillPct: 20,
  wallThicknessMm: 0.8,
};

const MATERIAL_IDS = new Set<string>([...MATERIAL_PRESETS.map((m) => m.id), CUSTOM_MATERIAL_ID]);

function asMaterialId(v: unknown): string | null {
  return typeof v === "string" && MATERIAL_IDS.has(v) ? v : null;
}
function asPositive(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
}

/** Narrow untrusted JSON to a complete PrintPrefs, field by field. */
export function asPrintPrefs(v: unknown): PrintPrefs {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_PRINT_PREFS };
  const o = v as Record<string, unknown>;
  return {
    materialId: asMaterialId(o["materialId"]) ?? DEFAULT_PRINT_PREFS.materialId,
    customDensity: asPositive(o["customDensity"], 30) ?? DEFAULT_PRINT_PREFS.customDensity,
    infillPct: asPositive(o["infillPct"], 100) ?? DEFAULT_PRINT_PREFS.infillPct,
    wallThicknessMm: asPositive(o["wallThicknessMm"], 20) ?? DEFAULT_PRINT_PREFS.wallThicknessMm,
  };
}

function readStored(): PrintPrefs {
  try {
    const raw = readSetting(KEY);
    return raw ? asPrintPrefs(JSON.parse(raw)) : { ...DEFAULT_PRINT_PREFS };
  } catch {
    return { ...DEFAULT_PRINT_PREFS };
  }
}

let current = readStored();
const listeners = new Set<() => void>();

export function printPrefs(): Readonly<PrintPrefs> {
  return current;
}

export function setPrintPref<K extends keyof PrintPrefs>(key: K, value: PrintPrefs[K]): void {
  const ok: unknown =
    key === "materialId" ? asMaterialId(value)
      : key === "customDensity" ? asPositive(value, 30)
        : key === "infillPct" ? asPositive(value, 100)
          : key === "wallThicknessMm" ? asPositive(value, 20)
            : null;
  if (ok === null || ok === undefined || current[key] === ok) return;
  current = { ...current, [key]: ok };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore, the in-memory value still applies for the rest of the session */
  }
  for (const fn of listeners) fn();
}

export function onPrintPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
