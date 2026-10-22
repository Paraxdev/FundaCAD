// Filament estimate for the Properties panel: solid volume at 100% infill, otherwise an approximate shell (area
// times wall thickness) plus the infill fraction of the rest. An estimate, not a toolpath.

export interface MaterialPreset {
  id: string;
  label: string;
  /** g/cm3 */
  density: number;
}

export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
  { id: "pla", label: "PLA", density: 1.24 },
  { id: "petg", label: "PETG", density: 1.27 },
  { id: "abs", label: "ABS", density: 1.04 },
  { id: "asa", label: "ASA", density: 1.07 },
  { id: "tpu", label: "TPU", density: 1.21 },
  { id: "nylon", label: "Nylon", density: 1.14 },
];

export const CUSTOM_MATERIAL_ID = "custom";

/** Standard spool diameters offered in the panel. */
export const FILAMENT_DIAMETERS = [1.75, 2.85] as const;
export type FilamentDiameter = (typeof FILAMENT_DIAMETERS)[number];

export function densityFor(materialId: string, customDensity: number): number {
  if (materialId === CUSTOM_MATERIAL_ID) return customDensity;
  return MATERIAL_PRESETS.find((m) => m.id === materialId)?.density ?? MATERIAL_PRESETS[0]!.density;
}

export interface FilamentEstimateInput {
  /** Body volume, mm3. */
  volumeMm3: number;
  /** Body surface area, mm2. */
  areaMm2: number;
  /** g/cm3. */
  densityGPerCm3: number;
  /** 0-100. */
  infillPct: number;
  /** Combined wall/top/bottom shell thickness, mm. */
  wallThicknessMm: number;
  /** Filament spool diameter, mm (1.75 or 2.85). */
  filamentDiameterMm: number;
}

export interface FilamentEstimate {
  /** The volume actually charged for (shell + infill fraction of the rest), mm3. */
  effectiveVolumeMm3: number;
  massG: number;
  lengthMm: number;
  lengthM: number;
}

/** mm3. The shell is capped at the whole volume so a thin part never gets a shell larger than itself; 100% infill
 *  is the exact solid. */
export function estimateEffectiveVolume(
  volumeMm3: number,
  areaMm2: number,
  infillPct: number,
  wallThicknessMm: number,
): number {
  const volume = Math.max(0, volumeMm3);
  if (infillPct >= 100) return volume;
  const shell = Math.min(Math.max(0, areaMm2) * Math.max(0, wallThicknessMm), volume);
  const interior = volume - shell;
  const fraction = Math.max(0, Math.min(100, infillPct)) / 100;
  return shell + interior * fraction;
}

/** mm3 of filament -> length in mm, for a given round filament diameter. */
export function filamentLengthMm(volumeMm3: number, filamentDiameterMm: number): number {
  const r = filamentDiameterMm / 2;
  const crossSection = Math.PI * r * r; // mm2
  return crossSection > 0 ? volumeMm3 / crossSection : 0;
}

export function estimateFilament(input: FilamentEstimateInput): FilamentEstimate {
  const effectiveVolumeMm3 = estimateEffectiveVolume(
    input.volumeMm3,
    input.areaMm2,
    input.infillPct,
    input.wallThicknessMm,
  );
  const massG = (effectiveVolumeMm3 / 1000) * input.densityGPerCm3; // mm3 -> cm3 -> g
  const lengthMm = filamentLengthMm(effectiveVolumeMm3, input.filamentDiameterMm);
  return { effectiveVolumeMm3, massG, lengthMm, lengthM: lengthMm / 1000 };
}
