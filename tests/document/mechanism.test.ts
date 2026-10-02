import { describe, expect, it } from "vitest";
import {
  driveField,
  driveJoint,
  driveStart,
  isDrivable,
  mechanismDriveChoice,
  mechanismDrivePatch,
  mechanismJoints,
  nextJointId,
  NO_DRIVE,
} from "../../src/document/mechanism";
import { choiceFieldsFor, fieldApplies } from "../../src/document/optionFields";
import { featureNumFields, NON_NUM_STRING_FIELDS } from "../../src/document/numFields";
import { targetsFor } from "../../src/features/selectionTargets";
import { commitRenameParam, deleteBlockers, referencesTo } from "../../src/params/engine";
import type { CadDocument, DatumMark, Feature, MechanismJoint, Selector } from "../../src/types";

const face: Selector = { kind: "face", by: "nearest", point: [0, 0, 0] };
const joint = (id: string, mode: MechanismJoint["mode"]): MechanismJoint => ({
  id,
  ...(mode ? { mode } : {}),
  a: { body: "body2", axis: { ...face, body: "body2" } },
  b: { body: "body1", axis: { ...face, body: "body1" } },
});
const claw = (drive?: string) => ({
  id: "f9",
  type: "mechanism",
  ground: "body1",
  joints: [joint("slide1", "slider"), joint("pin1", "revolute"), joint("weld1", "rigid")],
  ...(drive !== undefined ? { drive } : {}),
}) as Feature & Record<string, unknown>;

describe("which drive value a mechanism reads", () => {
  it("is the offset for a slider drive and the angle for a revolute one", () => {
    expect(driveField(claw("slide1"))).toBe("offset");
    expect(driveField(claw("pin1"))).toBe("angle");
  });

  it("is neither without a drive, with a rigid drive, or with a drive that is not there", () => {
    expect(driveField(claw())).toBeNull();
    expect(driveField(claw(""))).toBeNull();
    expect(driveField(claw("weld1"))).toBeNull();
    expect(driveField(claw("pin7"))).toBeNull();
  });

  it("reads a joint with no mode as no drive rather than guessing one", () => {
    const f = { ...claw("loose"), joints: [joint("loose", undefined)] };
    expect(driveJoint(f)?.id).toBe("loose");
    expect(driveField(f)).toBeNull();
  });

  it("tolerates a document an agent wrote without joints, or with a stray entry", () => {
    expect(mechanismJoints({})).toEqual([]);
    expect(mechanismJoints({ joints: "pin1" })).toEqual([]);
    expect(mechanismJoints({ joints: [null, 3, { mode: "revolute" }, { id: "pin1" }] })).toEqual([{ id: "pin1" }]);
  });
});

describe("the value rows of a mechanism", () => {
  it("lists both drive values in the inventory", () => {
    expect(featureNumFields("mechanism").map(([f, label, kind]) => [f, label, kind])).toEqual([
      ["offset", "Drive offset", "length"],
      ["angle", "Drive angle", "angle"],
    ]);
  });

  it("shows only the one the drive joint's mode reads", () => {
    expect(fieldApplies("mechanism", "offset", claw("slide1"))).toBe(true);
    expect(fieldApplies("mechanism", "angle", claw("slide1"))).toBe(false);
    expect(fieldApplies("mechanism", "offset", claw("pin1"))).toBe(false);
    expect(fieldApplies("mechanism", "angle", claw("pin1"))).toBe(true);
  });

  it("shows neither without a drive, and every other row always", () => {
    expect(fieldApplies("mechanism", "offset", claw())).toBe(false);
    expect(fieldApplies("mechanism", "angle", claw())).toBe(false);
    expect(fieldApplies("mechanism", "drive", claw())).toBe(true);
    expect(fieldApplies("mechanism", "ground", claw())).toBe(true);
  });

  it("never reads the ground or the drive as a parameter name", () => {
    expect(NON_NUM_STRING_FIELDS.has("ground")).toBe(true);
    expect(NON_NUM_STRING_FIELDS.has("drive")).toBe(true);
  });

  it("never reads a joint's mode as a parameter name, so a parameter called slider stays free", () => {
    const doc: CadDocument = {
      parameters: { slider: 10 },
      paramDefs: { slider: { expr: "10", value: 10, unit: "mm" } },
      features: [claw("slide1")],
    };
    expect(referencesTo(doc, "slider")).toEqual([]);
    expect(deleteBlockers(doc, "slider")).toBeNull();
    commitRenameParam(doc, "slider", "slider_pos");
    const joints = (doc.features[0] as unknown as { joints: MechanismJoint[] }).joints;
    expect(joints.map((j) => j.mode)).toEqual(["slider", "revolute", "rigid"]);
  });

  it("edits the ground as one body and the drive as a choice", () => {
    expect(targetsFor(claw("pin1"))).toEqual([
      { field: "ground", label: "Ground", kind: "body", shape: "bodyId", arity: "one" },
    ]);
    expect(choiceFieldsFor("mechanism").map((c) => c.field)).toEqual(["drive"]);
  });
});

describe("the Drive row", () => {
  it("offers no drive, then the revolute and slider joints, never a rigid one", () => {
    const { options, current } = mechanismDriveChoice(claw("pin1"));
    expect(options).toEqual([
      { value: NO_DRIVE, label: "None" },
      { value: "slide1", label: "slide1 (slider)" },
      { value: "pin1", label: "pin1 (revolute)" },
    ]);
    expect(current).toBe("pin1");
  });

  it("shows None for a mechanism without a drive", () => {
    expect(mechanismDriveChoice(claw()).current).toBe(NO_DRIVE);
  });

  it("keeps showing a drive it cannot offer, so the row never lies about the feature", () => {
    for (const drive of ["weld1", "pin7"]) {
      const { options, current } = mechanismDriveChoice(claw(drive));
      expect(current).toBe(drive);
      expect(options.at(-1)).toEqual({ value: drive, label: drive });
    }
  });

  it("writes the joint id, and drops the field for None", () => {
    expect(mechanismDrivePatch("slide1")).toEqual({ drive: "slide1" });
    const none = mechanismDrivePatch(NO_DRIVE);
    expect("drive" in none && none.drive === undefined).toBe(true);
  });
});

describe("new joints", () => {
  it("are named by what they are, numbered per kind", () => {
    expect(nextJointId([], "revolute")).toBe("pin1");
    expect(nextJointId([], "slider")).toBe("slide1");
    expect(nextJointId([], "rigid")).toBe("weld1");
    expect(nextJointId([{ id: "pin1" }, { id: "slide1" }], "revolute")).toBe("pin2");
  });

  it("fill a gap rather than collide with an id that is taken", () => {
    expect(nextJointId([{ id: "pin2" }], "revolute")).toBe("pin1");
    expect(nextJointId([{ id: "pin1" }, { id: "pin2" }, { id: "pin4" }], "revolute")).toBe("pin3");
  });

  it("can be the drive only when they have a coordinate", () => {
    expect(isDrivable("revolute")).toBe(true);
    expect(isDrivable("slider")).toBe(true);
    expect(isDrivable("rigid")).toBe(false);
    expect(isDrivable(undefined)).toBe(false);
  });
});

describe("the drive handle's start", () => {
  const axis = (value?: number): DatumMark => ({
    kind: "axis", origin: [0, 0, 0], dir: [0, 0, 1], ...(value !== undefined ? { value } : {}),
  });

  it("starts from the drive value when the feature has one", () => {
    expect(driveStart(12, axis(20))).toBe(12);
    expect(driveStart(0, axis(20))).toBe(0);
  });

  it("starts where the engine solved the linkage when the value is unset, not from 0", () => {
    expect(driveStart(undefined, axis(20))).toBe(20);
    expect(driveStart(undefined, axis(-180))).toBe(-180);
  });

  it("does not open when neither the feature nor the mark says where the drive stands", () => {
    expect(driveStart(undefined, axis())).toBeNull();
    expect(driveStart(undefined, undefined)).toBeNull();
    expect(driveStart(undefined, { kind: "point", position: [0, 0, 0] })).toBeNull();
    expect(driveStart(undefined, axis(Number.NaN))).toBeNull();
  });

  it("does not open on a value that is an expression", () => {
    expect(driveStart("crank * 2", axis(20))).toBeNull();
  });
});
