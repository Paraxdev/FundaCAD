// The pure half with no host imports, so the mapping from a person's choices to the viewport's ridges is tested
// without a window.

export const DIRECTIONS = [
  { id: "+Z", label: "+Z", axis: [0, 0, 1] },
  { id: "-Z", label: "-Z", axis: [0, 0, -1] },
  { id: "+X", label: "+X", axis: [1, 0, 0] },
  { id: "-X", label: "-X", axis: [-1, 0, 0] },
  { id: "+Y", label: "+Y", axis: [0, 1, 0] },
  { id: "-Y", label: "-Y", axis: [0, -1, 0] },
] as const;

export interface LookValues {
  layerLines: boolean;
  layerHeight: number;
  direction: string;
  depth: number;
  variation: number;
  grooveShading: number;
}

export const DEFAULTS: LookValues = {
  layerLines: false,
  layerHeight: 0.2,
  direction: "+Z",
  depth: 0.35,
  variation: 0.03,
  grooveShading: 0.4,
};

export interface LookRelief {
  axis: [number, number, number];
  pitch: number;
  depth: number;
  tintJitter: number;
  cavity: number;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};

export const LIMITS = {
  layerHeight: [0.02, 1],
  depth: [0, 0.5],
  variation: [0, 1],
  grooveShading: [0, 1],
} as const;

/** The ridges these values ask for, or null while layer lines are off. */
export function reliefFrom(values: Partial<LookValues>): LookRelief | null {
  if (values.layerLines !== true) return null;
  const dir = DIRECTIONS.find((d) => d.id === values.direction) ?? DIRECTIONS[0];
  return {
    axis: [dir.axis[0], dir.axis[1], dir.axis[2]],
    pitch: clamp(values.layerHeight, ...LIMITS.layerHeight, DEFAULTS.layerHeight),
    depth: clamp(values.depth, ...LIMITS.depth, DEFAULTS.depth),
    tintJitter: clamp(values.variation, ...LIMITS.variation, DEFAULTS.variation),
    cavity: clamp(values.grooveShading, ...LIMITS.grooveShading, DEFAULTS.grooveShading),
  };
}
