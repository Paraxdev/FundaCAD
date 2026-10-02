// The parts of a mechanism the app reasons about without the engine: which joint
// the drive moves, which of the two drive values that makes meaningful, what the
// Drive row offers, and what the new joints are called.
//
// A mechanism carries both `offset` (mm) and `angle` (deg) at the top level so
// parameters, the value rows and interference sweeps treat them like any other
// numeric field. Only one of them means anything at a time: a slider drive reads
// the offset and a revolute drive the angle. Everything here follows from that.

import type { ChoiceOption } from "./optionFields";
import type { DatumMark, Feature, JointMode, MechanismJoint } from "../types";

export type Mechanism = Extract<Feature, { type: "mechanism" }>;

/** The joints a mechanism lists, tolerating a document that has none or a stray entry. */
export function mechanismJoints(values: Record<string, unknown>): MechanismJoint[] {
  const raw = values.joints;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (j): j is MechanismJoint => typeof j === "object" && j !== null && typeof (j as { id?: unknown }).id === "string",
  );
}

/** The joint the drive names, if it names one that is there. */
export function driveJoint(values: Record<string, unknown>): MechanismJoint | null {
  const drive = values.drive;
  if (typeof drive !== "string" || !drive) return null;
  return mechanismJoints(values).find((j) => j.id === drive) ?? null;
}

/** Which drive value the mechanism reads: `offset` for a slider drive, `angle` for
 *  a revolute one, and neither without a drive or with one a rigid joint (which the
 *  engine refuses) or a joint that is not there. */
export function driveField(values: Record<string, unknown>): "offset" | "angle" | null {
  const mode = driveJoint(values)?.mode;
  if (mode === "slider") return "offset";
  if (mode === "revolute") return "angle";
  return null;
}

/** Whether a mechanism's field means anything: the two drive values only when the
 *  drive reads them, every other field always. */
export function mechanismFieldApplies(field: string, values: Record<string, unknown>): boolean {
  if (field !== "offset" && field !== "angle") return true;
  return driveField(values) === field;
}

/** Where a drive handle starts: the drive value when the feature has one, else
 *  the coordinate the engine solved the linkage to. Without a value the engine
 *  leaves the parts as modelled, which is generally not 0, so starting a drag
 *  from 0 would jump the linkage. Null when neither is known, and the value rows
 *  take over. */
export function driveStart(raw: unknown, mark: DatumMark | undefined): number | null {
  if (typeof raw === "number") return raw;
  if (raw != null) return null;
  if (mark?.kind === "axis" && typeof mark.value === "number" && Number.isFinite(mark.value)) return mark.value;
  return null;
}

/** Whether a joint of this mode can be the drive. A rigid joint has no coordinate. */
export function isDrivable(mode: JointMode | undefined): mode is "revolute" | "slider" {
  return mode === "revolute" || mode === "slider";
}

/** The value the Drive row uses for "no drive". A joint id is never empty. */
export const NO_DRIVE = "";

/** A mechanism's Drive row: no drive, then every revolute and slider joint by id,
 *  plus whatever the drive names when it is none of those (a rigid joint, or one
 *  that was removed), so the row never shows a drive the feature does not have. */
export function mechanismDriveChoice(values: Record<string, unknown>): { options: ChoiceOption[]; current: string } {
  const options: ChoiceOption[] = [{ value: NO_DRIVE, label: "None" }];
  for (const j of mechanismJoints(values)) {
    if (isDrivable(j.mode)) options.push({ value: j.id, label: `${j.id} (${j.mode})` });
  }
  const drive = typeof values.drive === "string" ? values.drive : NO_DRIVE;
  if (!options.some((o) => o.value === drive)) options.push({ value: drive, label: drive });
  return { options, current: drive };
}

/** What choosing `value` in the Drive row writes. "None" drops the field. */
export function mechanismDrivePatch(value: string): Record<string, unknown> {
  return { drive: value === NO_DRIVE ? undefined : value };
}

const ID_PREFIX: Record<JointMode, string> = { revolute: "pin", slider: "slide", rigid: "weld" };

/** A fresh id for a new joint of this mode: pin1, pin2 for revolutes, slide1 for
 *  sliders, weld1 for rigid ones. The engine's messages name joints by id, so a
 *  word that says what the joint is reads better there than j3. */
export function nextJointId(joints: readonly { id: string }[], mode: JointMode): string {
  const taken = new Set(joints.map((j) => j.id));
  let n = 1;
  while (taken.has(`${ID_PREFIX[mode]}${n}`)) n++;
  return `${ID_PREFIX[mode]}${n}`;
}
