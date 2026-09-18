// What the Export dialog asks for, its presets, and the choices it remembers.

import type { ExportFormat } from "../types";

export type ExportUnit = "mm" | "cm" | "m" | "in" | "ft";
export type Refinement = "low" | "medium" | "high" | "custom";
export type BodyScope = "all" | "separate" | string;

export interface Faceting {
  /** Largest gap between the body and a facet, mm. */
  surfaceDeviation: number;
  /** Largest angle between the normals of two neighbouring facets, degrees. */
  normalDeviation: number;
  /** Longest allowed facet edge, mm, 0 for no limit. */
  maxEdgeLength: number;
}

export interface ExportSettings {
  format: ExportFormat;
  unit: ExportUnit;
  binary: boolean;
  refinement: Refinement;
  faceting: Faceting;
  showAdvanced: boolean;
}

export const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "stl", label: "STL (*.stl)", ext: "stl" },
  { value: "3mf", label: "3MF (*.3mf)", ext: "3mf" },
  { value: "step", label: "STEP (*.step)", ext: "step" },
  { value: "glb", label: "GLB glTF (*.glb)", ext: "glb" },
];

export const UNITS: { value: ExportUnit; label: string }[] = [
  { value: "mm", label: "Millimeter" },
  { value: "cm", label: "Centimeter" },
  { value: "m", label: "Meter" },
  { value: "in", label: "Inch" },
  { value: "ft", label: "Foot" },
];

export const REFINEMENTS: Record<Exclude<Refinement, "custom">, Faceting> = {
  low: { surfaceDeviation: 0.1, normalDeviation: 30, maxEdgeLength: 0 },
  medium: { surfaceDeviation: 0.02, normalDeviation: 15, maxEdgeLength: 0 },
  high: { surfaceDeviation: 0.005, normalDeviation: 5, maxEdgeLength: 0 },
};

export const DEFAULT_SETTINGS: ExportSettings = {
  format: "stl",
  unit: "mm",
  binary: true,
  refinement: "medium",
  faceting: { ...REFINEMENTS.medium },
  showAdvanced: false,
};

/** Faceting and units only mean something to a format written as triangles. */
export const isMeshFormat = (f: ExportFormat) => f !== "step";
/** GLB is metres by convention and viewers expect it, so it takes no unit. */
export const takesUnit = (f: ExportFormat) => f === "stl" || f === "3mf";

/** The preset these values match, or custom. */
export function refinementOf(f: Faceting): Refinement {
  for (const [name, p] of Object.entries(REFINEMENTS)) {
    if (p.surfaceDeviation === f.surfaceDeviation && p.normalDeviation === f.normalDeviation
      && p.maxEdgeLength === f.maxEdgeLength) return name as Refinement;
  }
  return "custom";
}

/** Clamped to what the engine accepts, so the dialog never sends a value it would replace. */
export function clampFaceting(f: Faceting): Faceting {
  const n = (v: number, lo: number, hi: number, d: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    surfaceDeviation: n(f.surfaceDeviation, 0.0001, 10, REFINEMENTS.medium.surfaceDeviation),
    normalDeviation: n(f.normalDeviation, 0.5, 90, REFINEMENTS.medium.normalDeviation),
    maxEdgeLength: n(f.maxEdgeLength, 0, 1e6, 0),
  };
}

/** The engine's `mesh` export options. */
export function meshWire(s: ExportSettings) {
  return { unit: s.unit, binary: s.binary, ...clampFaceting(s.faceting) };
}

const KEY = "fundacad.exportSettings";

/** Saved settings read back, with anything unreadable replaced by its default. */
export function parseExportSettings(raw: string | null): ExportSettings {
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  try {
    const v = JSON.parse(raw) as Partial<ExportSettings>;
    const faceting = clampFaceting({ ...DEFAULT_SETTINGS.faceting, ...(v.faceting ?? {}) });
    return {
      format: FORMATS.some((f) => f.value === v.format) ? v.format! : DEFAULT_SETTINGS.format,
      unit: UNITS.some((u) => u.value === v.unit) ? v.unit! : DEFAULT_SETTINGS.unit,
      binary: v.binary !== false,
      refinement: refinementOf(faceting),
      faceting,
      showAdvanced: v.showAdvanced === true,
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function loadExportSettings(): ExportSettings {
  try {
    return parseExportSettings(localStorage.getItem(KEY));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveExportSettings(s: ExportSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // a blocked store only costs remembering the choice
  }
}
