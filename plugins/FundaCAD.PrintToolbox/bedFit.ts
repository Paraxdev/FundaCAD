// Display-only, no feature and no History row: a toast before you slice it and find out the hard way.

import { definePluginSettings, readSetting, type SettingsSchema } from "fundacad";

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

/** Whether `size` (a model's bounding box, mm) fits inside `bed`, and the uniform scale that would make it fit, set
 *  by the axis with the smallest bed to model ratio. */
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

function parseOld(raw: string): BedFitSetting {
  const o = JSON.parse(raw) as Partial<BedFitSetting>;
  const presetId =
    typeof o.presetId === "string" && BED_PRESETS.some((p) => p.id === o.presetId)
      ? o.presetId
      : DEFAULT_SETTING.presetId;
  const customSize = isVec3(o.customSize) ? o.customSize : DEFAULT_SETTING.customSize;
  return { presetId, customSize };
}

const custom = (key: string, label: string, i: number) =>
  ({
    key,
    type: "number",
    label,
    unit: "length",
    group: "Bed fit check",
    min: 1,
    max: 5000,
    default: DEFAULT_SETTING.customSize[i]!,
    visibleWhen: (v: Record<string, unknown>) => v.presetId === "custom",
  }) as const;

export const BED_SETTINGS: SettingsSchema = {
  version: 1,
  props: [
    {
      key: "presetId",
      type: "enum",
      label: "Printer bed",
      group: "Bed fit check",
      description: "The bed Bed Fit Check measures against. Picking one in the check changes it here too.",
      default: DEFAULT_SETTING.presetId,
      options: BED_PRESETS.map((p) => ({ id: p.id, label: p.label })),
    },
    custom("customX", "Custom bed width", 0),
    custom("customY", "Custom bed depth", 1),
    custom("customZ", "Custom bed height", 2),
  ],
  legacy: () => {
    const raw = readSetting(KEY);
    if (!raw) return null;
    const old = parseOld(raw);
    const [customX, customY, customZ] = old.customSize;
    return { presetId: old.presetId, customX, customY, customZ };
  },
};

export const bedSettings = definePluginSettings("FundaCAD.PrintToolbox", BED_SETTINGS);

export function loadBedFitSetting(): BedFitSetting {
  const v = bedSettings.all();
  return {
    presetId: v.presetId as string,
    customSize: [v.customX as number, v.customY as number, v.customZ as number],
  };
}

export function saveBedFitSetting(setting: BedFitSetting): void {
  bedSettings.set("presetId", setting.presetId);
  if (!isVec3(setting.customSize)) return;
  const [customX, customY, customZ] = setting.customSize;
  bedSettings.set("customX", customX);
  bedSettings.set("customY", customY);
  bedSettings.set("customZ", customZ);
}

/** The bed size a setting resolves to: the preset's fixed size, or the stored custom one. */
export function bedSizeOf(setting: BedFitSetting): Vec3 {
  const preset = BED_PRESETS.find((p) => p.id === setting.presetId);
  return preset?.size ?? setting.customSize;
}

export type CustomBedParse = { ok: true; size: Vec3 } | { ok: false; message: string };

/** Three typed numbers into a custom bed size, or the message to show beside the wrong field. Positive and finite is
 *  the whole rule. */
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
