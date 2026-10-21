// What the Export dialog asks for, its presets, and the choices it remembers.

import type { ExportFormat, PlaneDef } from "../types";
import type { TreeGroup } from "../ui/browserTree";

export type ExportUnit = "mm" | "cm" | "m" | "in" | "ft";
export type Refinement = "low" | "medium" | "high" | "custom";
/** "selected" and "selected-separate" export ExportStart.selected; any other
 *  string is one body id, which is always `bodyN` so never clashes. */
export type BodyScope = "all" | "separate" | "selected" | "selected-separate" | string;

export interface ExportStart {
  scope: BodyScope;
  /** The selected bodies still built, in build order. */
  selected: string[];
  /** What the default file name starts with: the body, the folder or the document. */
  base: string;
}

/** Where Export starts from what is selected: nothing is the whole document, one
 *  body is that body, more are "selected", named after the folder they make up
 *  when they are exactly one folder's bodies. */
export function exportScopeFromSelection(
  selected: readonly string[],
  bodies: readonly { id: string; name: string }[],
  groups: readonly TreeGroup[],
  docName: string,
): ExportStart {
  const want = new Set(selected);
  const picked = bodies.filter((b) => want.has(b.id));
  if (picked.length === 0) return { scope: "all", selected: [], base: docName };
  if (picked.length === 1) return { scope: picked[0]!.id, selected: [picked[0]!.id], base: picked[0]!.name };
  const ids = picked.map((b) => b.id);
  return { scope: "selected", selected: ids, base: folderOf(ids, groups) ?? docName };
}

function folderOf(ids: readonly string[], groups: readonly TreeGroup[]): string | null {
  let found: string | null = null;
  const walk = (g: TreeGroup): string[] => {
    const under = [...g.bodies.map((b) => b.id), ...g.children.flatMap(walk)];
    if (under.length === ids.length && ids.every((id) => under.includes(id))) found ??= g.label;
    return under;
  };
  groups.forEach(walk);
  return found;
}

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
  /** How far a DXF or SVG polyline may stray from a curve that is not a line, arc or circle, mm. */
  tolerance: number;
}

/** What a DXF or SVG export draws: one sketch, or one flat face in the plane a
 *  sketch on that face would take, so the two drawings line up. */
export type FlatSource =
  | { sketch: string; label: string }
  | { face: unknown; plane: PlaneDef; label: string };

/** `exts` are what the save dialog offers, the first is the default name's. A
 *  typed name is kept as typed, the engine writes the path it is given. */
export const FORMATS: { value: ExportFormat; label: string; ext: string; exts: string[] }[] = [
  { value: "stl", label: "STL (*.stl)", ext: "stl", exts: ["stl"] },
  { value: "3mf", label: "3MF (*.3mf)", ext: "3mf", exts: ["3mf"] },
  { value: "step", label: "STEP (*.step, *.stp)", ext: "step", exts: ["step", "stp"] },
  { value: "glb", label: "GLB glTF (*.glb)", ext: "glb", exts: ["glb"] },
  { value: "dxf", label: "DXF R12 (*.dxf)", ext: "dxf", exts: ["dxf"] },
  { value: "svg", label: "SVG (*.svg)", ext: "svg", exts: ["svg"] },
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
  tolerance: 0.01,
};

/** Faceting and units only mean something to a format written as triangles. */
export const isMeshFormat = (f: ExportFormat) => f === "stl" || f === "3mf" || f === "glb";
/** A drawing of one sketch or flat face rather than of bodies. */
export const isFlatFormat = (f: ExportFormat) => f === "dxf" || f === "svg";
export const clampTolerance = (t: number) => (Number.isFinite(t) ? Math.min(1, Math.max(0.0001, t)) : 0.01);
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
      tolerance: clampTolerance(typeof v.tolerance === "number" ? v.tolerance : DEFAULT_SETTINGS.tolerance),
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

const LAST_DIR_KEY = "fundacad.exportDir";

/** A default export file name that no earlier export took: the base, then the
 *  local date and time to the second, `bracket_20261016114207.stl`. */
export function exportFileName(base: string, ext: string, now: Date = new Date()): string {
  // Windows refuses these in a file name, and a trailing dot or space.
  const safe = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "part";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${safe}_${stamp}.${ext}`;
}

export function lastExportDir(): string | null {
  try {
    return localStorage.getItem(LAST_DIR_KEY);
  } catch {
    return null;
  }
}

export function rememberExportDir(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut <= 0) return;
  try {
    localStorage.setItem(LAST_DIR_KEY, path.slice(0, cut));
  } catch {
    // a blocked store only costs opening the dialog in the default folder
  }
}
