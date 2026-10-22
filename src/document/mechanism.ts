// A mechanism keeps both `offset` (mm) and `angle` (deg) as top-level numeric fields, but only one means anything:
// a slider drive reads the offset, a revolute drive the angle.

import type { ChoiceOption } from "./optionFields";
import type { DatumMark, Feature, JointMode, MechanismJoint } from "../types";

export type Mechanism = Extract<Feature, { type: "mechanism" }>;

// Tolerates a document with no joints or a stray entry.
export function mechanismJoints(values: Record<string, unknown>): MechanismJoint[] {
  const raw = values.joints;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (j): j is MechanismJoint => typeof j === "object" && j !== null && typeof (j as { id?: unknown }).id === "string",
  );
}

export function driveJoint(values: Record<string, unknown>): MechanismJoint | null {
  const drive = values.drive;
  if (typeof drive !== "string" || !drive) return null;
  return mechanismJoints(values).find((j) => j.id === drive) ?? null;
}

// Neither without a drive, or when the drive is a rigid joint (which the engine refuses) or missing.
export function driveField(values: Record<string, unknown>): "offset" | "angle" | null {
  const mode = driveJoint(values)?.mode;
  if (mode === "slider") return "offset";
  if (mode === "revolute") return "angle";
  return null;
}

export function mechanismFieldApplies(field: string, values: Record<string, unknown>): boolean {
  if (field !== "offset" && field !== "angle") return true;
  return driveField(values) === field;
}

// The engine leaves the parts as modelled when no value is set, which is generally not 0, so a drag starting from 0
// would jump the linkage. Null hands over to the value rows.
export function driveStart(raw: unknown, mark: DatumMark | undefined): number | null {
  if (typeof raw === "number") return raw;
  if (raw != null) return null;
  if (mark?.kind === "axis" && typeof mark.value === "number" && Number.isFinite(mark.value)) return mark.value;
  return null;
}

export function isDrivable(mode: JointMode | undefined): mode is "revolute" | "slider" {
  return mode === "revolute" || mode === "slider";
}

// A joint id is never empty.
export const NO_DRIVE = "";

// Also lists whatever the drive names when it is not drivable (rigid or removed), so the row never lies.
export function mechanismDriveChoice(values: Record<string, unknown>): { options: ChoiceOption[]; current: string } {
  const options: ChoiceOption[] = [{ value: NO_DRIVE, label: "None" }];
  for (const j of mechanismJoints(values)) {
    if (isDrivable(j.mode)) options.push({ value: j.id, label: `${j.id} (${j.mode})` });
  }
  const drive = typeof values.drive === "string" ? values.drive : NO_DRIVE;
  if (!options.some((o) => o.value === drive)) options.push({ value: drive, label: drive });
  return { options, current: drive };
}

export function mechanismDrivePatch(value: string): Record<string, unknown> {
  return { drive: value === NO_DRIVE ? undefined : value };
}

const ID_PREFIX: Record<JointMode, string> = { revolute: "pin", slider: "slide", rigid: "weld" };

// pin1, slide1, weld1: the engine's messages name joints by id, so a word reads better there than j3.
export function nextJointId(joints: readonly { id: string }[], mode: JointMode): string {
  const taken = new Set(joints.map((j) => j.id));
  let n = 1;
  while (taken.has(`${ID_PREFIX[mode]}${n}`)) n++;
  return `${ID_PREFIX[mode]}${n}`;
}
