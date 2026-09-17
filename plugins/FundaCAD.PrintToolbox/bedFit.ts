// Bed fit check: does the model's bounding box fit a printer bed, and if not,
// what uniform scale would make it fit. Display-only, no feature, no History
// row: just a toast telling you before you slice it and find out the hard way.

import { readSetting } from "fundacad";

export type Vec3 = readonly [number, number, number];

export interface BedPreset {
  id: string;
  label: string;
  /** Bed size in mm, null for the "custom" entry, which reads storedCustomBed instead. */
  size: Vec3 | null;
}

export const BED_PRESETS: readonly BedPreset[] = [
  { id: "180", label: "180 x 180 x 180", size: [180, 180, 180] },
  { id: "220x250", label: "220 x 220 x 250", size: [220, 220, 250] },
  { id: "256", label: "256 x 256 x 256", size: [256, 256, 256] },
  { id: "300", label: "300 x 300 x 300", size: [300, 300, 300] },
  { id: "350", label: "350 x 350 x 350", size: [350, 350, 350] },
  { id: "custom", label: "Custom", size: null },
];

export interface BedFitResult {
  /** Does the model's bounding box fit the bed on all 3 axes, as given (no rotation tried)? */
  fits: boolean;
  /** The uniform scale that would make it fit; 1 when it already fits. */
  scale: number;
}

/** Pure: whether `size` (a model's bounding box, mm) fits inside `bed`, and the
 *  uniform scale factor that would make it fit if not. The limiting axis is
 *  whichever ratio of bed to model is smallest; scaling by less than that still
 *  leaves it standing proud of the other two, but no smaller scale is needed. */
export function bedFit(size: Vec3, bed: Vec3): BedFitResult {
  const ratios = size.map((s, i) => (s <= 0 ? Infinity : bed[i]! / s));
  const scale = Math.min(1, ...ratios);
  const fits = size.every((s, i) => s <= bed[i]! + 1e-9);
  return { fits, scale };
}

const KEY = "fundacad.printToolbox.bedFit";

export interface BedFitSetting {
  presetId: string;
  customSize: Vec3;
}

const DEFAULT_SETTING: BedFitSetting = { presetId: "256", customSize: [220, 220, 220] };

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
}

export function loadBedFitSetting(): BedFitSetting {
  try {
    const raw = readSetting(KEY);
    if (!raw) return DEFAULT_SETTING;
    const o = JSON.parse(raw) as Partial<BedFitSetting>;
    const presetId = typeof o.presetId === "string" && BED_PRESETS.some((p) => p.id === o.presetId)
      ? o.presetId : DEFAULT_SETTING.presetId;
    const customSize = isVec3(o.customSize) ? o.customSize : DEFAULT_SETTING.customSize;
    return { presetId, customSize };
  } catch {
    return DEFAULT_SETTING;
  }
}

export function saveBedFitSetting(setting: BedFitSetting): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(setting));
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
}

/** The bed size a setting resolves to: the preset's fixed size, or the stored custom one. */
export function bedSizeOf(setting: BedFitSetting): Vec3 {
  const preset = BED_PRESETS.find((p) => p.id === setting.presetId);
  return preset?.size ?? setting.customSize;
}

export type CustomBedParse =
  | { ok: true; size: Vec3 }
  | { ok: false; message: string };

/** Pure: three typed numbers into a custom bed size, or the message to show
 *  beside the field that is wrong. Positive and finite is the whole rule, a
 *  bed of 0 or NaN mm is not a bed. */
export function parseCustomBedSize(width: number, depth: number, height: number): CustomBedParse {
  if ([width, depth, height].some((v) => !Number.isFinite(v) || v <= 0)) {
    return { ok: false, message: "Width, depth and height must all be positive numbers." };
  }
  return { ok: true, size: [width, depth, height] };
}

/** The toast line for a bed fit result. Rounded to a tenth of a mm and of a
 *  percent, which is closer than a bed's own accuracy ever is. */
export function bedFitMessage(size: Vec3, bed: Vec3): string {
  const { fits, scale } = bedFit(size, bed);
  const dims = size.map((s) => s.toFixed(1)).join(" x ");
  const bedDims = bed.map((s) => s.toFixed(0)).join(" x ");
  if (fits) return `Fits the ${bedDims} mm bed (model is ${dims} mm)`;
  return `Too big for the ${bedDims} mm bed (model is ${dims} mm); scale to ${(scale * 100).toFixed(1)}% to fit`;
}
