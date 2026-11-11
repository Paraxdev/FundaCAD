// The row names of a feature's properties follow the language, the field ids, kinds and the MCP-side tables do not.
import { computed } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_NUM_FIELDS, featureNumFields, type FieldKind } from "../../src/document/numFields";
import {
  choiceFieldsFor,
  FEATURE_CHOICE_FIELDS,
  FEATURE_TOGGLE_FIELDS,
  fieldLabel,
  toggleFieldsFor,
} from "../../src/document/optionFields";
import { setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import ja from "../../src/i18n/locales/ja.json";
import { contribute, resetContributions } from "../../src/plugins/contrib";
import VECTORS from "../vectors/params.json";

const LINES = { en, de, ja } as Record<string, Record<string, string>>;

// Today's English, row by row, taken from the tables before their labels became keys.
const NUM_ENGLISH: Record<string, [string, string, FieldKind][]> = {
  extrude: [
    ["distance", "Distance", "length"],
    ["taper", "Taper", "angle"],
    ["startOffset", "Start offset", "length"],
    ["endOffset", "End offset", "length"],
    ["distance2", "Distance 2", "length"],
    ["taper2", "Taper 2", "angle"],
    ["endOffset2", "End offset 2", "length"],
    ["thickness", "Thickness", "length"],
    ["thickness2", "Thickness 2", "length"],
  ],
  fillet: [
    ["radius", "Radius", "length"],
    ["profile", "Profile", "count"],
  ],
  chamfer: [
    ["distance", "Distance", "length"],
    ["distance2", "Distance 2", "length"],
  ],
  "press-pull": [
    ["distance", "Distance", "length"],
    ["taper", "Taper", "angle"],
    ["upToOffset", "Up to offset", "length"],
  ],
  revolve: [
    ["angle", "Angle", "angle"],
    ["pitch", "Pitch", "length"],
  ],
  datumPlane: [
    ["offset", "Offset", "length"],
    ["tiltX", "Tilt X", "angle"],
    ["tiltY", "Tilt Y", "angle"],
    ["spin", "Spin", "angle"],
    ["shiftX", "Shift X", "length"],
    ["shiftY", "Shift Y", "length"],
  ],
  box: [
    ["length", "Length", "length"],
    ["width", "Width", "length"],
    ["height", "Height", "length"],
  ],
  cylinder: [
    ["radius", "Radius", "length"],
    ["height", "Height", "length"],
  ],
  cone: [
    ["bottomRadius", "Bottom radius", "length"],
    ["topRadius", "Top radius", "length"],
    ["height", "Height", "length"],
  ],
  sphere: [["radius", "Radius", "length"]],
  torus: [
    ["majorRadius", "Ring radius", "length"],
    ["minorRadius", "Tube radius", "length"],
  ],
  shell: [["thickness", "Thickness", "length"]],
  offsetFace: [["distance", "Distance", "length"]],
  thicken: [["thickness", "Thickness", "length"]],
  draft: [["angle", "Angle", "angle"]],
  thread: [
    ["pitch", "Pitch", "length"],
    ["starts", "Starts", "count"],
    ["offset", "Offset", "length"],
    ["length", "Length", "length"],
    ["clearance", "Print clearance", "length"],
  ],
  textOnFace: [
    ["height", "Height", "length"],
    ["depth", "Depth", "length"],
    ["angle", "Angle", "angle"],
  ],
  hole: [
    ["diameter", "Diameter", "length"],
    ["depth", "Depth", "length"],
    ["cbDiameter", "Counterbore diameter", "length"],
    ["cbDepth", "Counterbore depth", "length"],
    ["csDiameter", "Countersink diameter", "length"],
    ["csAngle", "Countersink angle", "angle"],
    ["leadIn", "Lead-in", "length"],
  ],
  patternRect: [
    ["countX", "Count X", "count"],
    ["countY", "Count Y", "count"],
    ["spacingX", "Spacing X", "length"],
    ["spacingY", "Spacing Y", "length"],
  ],
  patternLinear: [
    ["count", "Count", "count"],
    ["spacing", "Spacing", "length"],
  ],
  patternCircular: [
    ["count", "Count", "count"],
    ["angle", "Angle", "angle"],
  ],
  simplifyMesh: [["tolerance", "Angle tol", "angle"]],
  cleanUp: [["tolerance", "Tolerance", "length"]],
  scale: [
    ["factor", "Factor", "count"],
    ["sx", "X factor", "count"],
    ["sy", "Y factor", "count"],
    ["sz", "Z factor", "count"],
  ],
  move: [
    ["dx", "Move X", "length"],
    ["dy", "Move Y", "length"],
    ["dz", "Move Z", "length"],
    ["rx", "Rotate X", "angle"],
    ["ry", "Rotate Y", "angle"],
    ["rz", "Rotate Z", "angle"],
  ],
  joint: [
    ["offset", "Offset", "length"],
    ["angle", "Angle", "angle"],
  ],
  mechanism: [
    ["offset", "Drive offset", "length"],
    ["angle", "Drive angle", "angle"],
  ],
  duplicate: [
    ["dx", "Move X", "length"],
    ["dy", "Move Y", "length"],
    ["dz", "Move Z", "length"],
    ["rx", "Rotate X", "angle"],
    ["ry", "Rotate Y", "angle"],
    ["rz", "Rotate Z", "angle"],
  ],
};
const CHOICE_ENGLISH: Record<string, [string, string][]> = {
  boolean: [["operation", "Operation"]],
  extrude: [
    ["operation", "Operation"],
    ["startType", "Start"],
    ["startPlane", "Start plane"],
    ["startPoint", "Start point"],
    ["endType", "End"],
    ["upToPlane", "Up to plane"],
    ["upToPoint", "Up to point"],
    ["endType2", "End 2"],
    ["upToPlane2", "Up to plane 2"],
    ["upToPoint2", "Up to point 2"],
    ["side", "Wall side"],
  ],
  revolve: [
    ["operation", "Operation"],
    ["axis", "Axis"],
  ],
  thread: [
    ["hand", "Hand"],
    ["operation", "Operation"],
  ],
  textOnFace: [
    ["operation", "Operation"],
    ["align", "Align"],
  ],
  loft: [["operation", "Operation"]],
  sweep: [["operation", "Operation"]],
  thicken: [["operation", "Operation"]],
  mirror: [["plane", "Plane"]],
  draft: [["axis", "Pull axis"]],
  patternLinear: [["axis", "Direction"]],
  patternCircular: [["axis", "Axis"]],
  mechanism: [["drive", "Drive"]],
  "press-pull": [
    ["mode", "Operation"],
    ["direction", "Direction"],
  ],
  fillet: [
    ["sizeType", "Size Type"],
    ["continuity", "Continuity"],
  ],
  chamfer: [["chamferType", "Type"]],
  hole: [
    ["holeType", "Hole type"],
    ["standard", "Standard"],
    ["size", "Size"],
    ["fit", "Fit"],
    ["extent", "Extent"],
  ],
};
const TOGGLE_ENGLISH: Record<string, [string, string][]> = {
  boolean: [["keepOriginals", "Keep originals"]],
  extrude: [
    ["symmetric", "Symmetric"],
    ["twoSided", "Two sided"],
    ["thin", "Thin"],
  ],
  thicken: [["symmetric", "Symmetric"]],
  fillet: [["tangentEdges", "Include Tangent Edges"]],
  chamfer: [["tangentEdges", "Include Tangent Edges"]],
  "press-pull": [["followTangent", "Tangent faces follow"]],
  offsetFace: [["followTangent", "Tangent faces follow"]],
  hole: [
    ["drillPoint", "Drill point"],
    ["flip", "Flip direction"],
    ["tapped", "Tapped"],
  ],
};

// The keys the tables must hold for the three sample types, written here so a wrong key in the table shows.
const KEYS = {
  extrude: [
    ["distance", "field.distance", "length"],
    ["taper", "field.taper", "angle"],
    ["startOffset", "field.startOffset", "length"],
    ["endOffset", "field.endOffset", "length"],
    ["distance2", "field.distance2", "length"],
    ["taper2", "field.taper2", "angle"],
    ["endOffset2", "field.endOffset2", "length"],
    ["thickness", "field.thickness", "length"],
    ["thickness2", "field.thickness2", "length"],
  ],
  hole: [
    ["diameter", "field.diameter", "length"],
    ["depth", "field.depth", "length"],
    ["cbDiameter", "field.counterboreDiameter", "length"],
    ["cbDepth", "field.counterboreDepth", "length"],
    ["csDiameter", "field.countersinkDiameter", "length"],
    ["csAngle", "field.countersinkAngle", "angle"],
    ["leadIn", "field.leadIn", "length"],
  ],
  datumPlane: [
    ["offset", "field.offset", "length"],
    ["tiltX", "field.tiltX", "angle"],
    ["tiltY", "field.tiltY", "angle"],
    ["spin", "field.spin", "angle"],
    ["shiftX", "field.shiftX", "length"],
    ["shiftY", "field.shiftY", "length"],
  ],
} as Record<string, [string, string, FieldKind][]>;
const DATUM_REF: [string, string, FieldKind][] = [
  ["t", "field.position", "count"],
  ["angle", "field.angle", "angle"],
];
const ACTIVE: [string, string, FieldKind] = ["activeWhen", "field.activeWhen", "count"];

const inLanguage = (code: string, rows: [string, string, FieldKind][]) =>
  rows.map(([field, key, kind]) => [field, LINES[code]![key], kind]);

// Slanted and off the origin, with the optional rows present.
const EXTRUDE_VALUES = { distance: 12.375, taper: -3.5, startOffset: 23.5, endOffset: 1.25, distance2: 7.5 };
const PLANE_VALUES = { offset: 23.5, tiltX: 17, tiltY: -4.25, spin: 33, shiftX: 5.5, shiftY: -2.75 };

afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

describe("the number rows of a feature", () => {
  it("read as today's English, row by row, in English", async () => {
    await setLanguage("en");
    for (const [type, rows] of Object.entries(NUM_ENGLISH)) expect(featureNumFields(type), type).toEqual(rows);
  });

  it.each(["de", "ja"])("name the rows of an extrude, a hole and a datum plane in %s", async (code) => {
    await setLanguage(code);
    expect(featureNumFields("extrude")).toEqual(inLanguage(code, KEYS.extrude!));
    expect(featureNumFields("extrude", EXTRUDE_VALUES)).toEqual(inLanguage(code, KEYS.extrude!));
    expect(featureNumFields("hole", { diameter: 3.4 })).toEqual(inLanguage(code, KEYS.hole!));
    expect(featureNumFields("datumPlane")).toEqual(inLanguage(code, KEYS.datumPlane!));
    expect(featureNumFields("datumPlane", PLANE_VALUES)).toEqual(inLanguage(code, KEYS.datumPlane!));
    // A datum plane through an edge adds the position and the turn about it, after the six.
    expect(featureNumFields("datumPlane", { ...PLANE_VALUES, t: 0.375, angle: 21 })).toEqual(
      inLanguage(code, [...KEYS.datumPlane!, ...DATUM_REF]),
    );
    expect(featureNumFields("datumPlane", { ...PLANE_VALUES, angle: 21 })).toEqual(
      inLanguage(code, [...KEYS.datumPlane!, DATUM_REF[1]!]),
    );
    expect(featureNumFields("extrude", { ...EXTRUDE_VALUES, activeWhen: 2 })).toEqual(
      inLanguage(code, [...KEYS.extrude!, ACTIVE]),
    );
  });

  it("keep every field id and kind in every language, and no row shows its key", async () => {
    const wanted = Object.fromEntries(
      Object.entries(NUM_ENGLISH).map(([type, rows]) => [type, rows.map(([f, , k]) => [f, k])]),
    );
    for (const code of ["en", "de", "es", "fr", "ja", "zh-CN", "system"]) {
      await setLanguage(code);
      for (const type of Object.keys(NUM_ENGLISH)) {
        const rows = featureNumFields(type);
        expect(
          rows.map(([f, , k]) => [f, k]),
          `${type} ${code}`,
        ).toEqual(wanted[type]);
        for (const [, label] of rows) expect(label).not.toMatch(/^field\./);
      }
    }
  });

  it("read in German differ from English except where the word is the same", async () => {
    await setLanguage("de");
    const same = Object.entries(NUM_ENGLISH).flatMap(([type, rows]) =>
      featureNumFields(type).flatMap(([, label], i) => (label === rows[i]![1] ? [label] : [])),
    );
    // Radius is the German word too.
    expect(new Set(same)).toEqual(new Set(["Radius"]));
  });

  it("hand a plugin's rows and an undescribed type's raw field paths through untouched", async () => {
    contribute("Acme.Rivets", {
      features: [{ type: "rivet", numFields: [["head", "Head size", "length"]] }],
    });
    const ghost = { id: "g1", type: "ghost", reach: 4.5, nodes: [{ id: "n3", sx: 2 }] };
    for (const code of ["en", "de"]) {
      await setLanguage(code);
      expect(featureNumFields("rivet")).toEqual([["head", "Head size", "length"]]);
      expect(featureNumFields("ghost", ghost)).toEqual([
        ["reach", "reach", "count"],
        ["nodes.n3.sx", "nodes n3 sx", "count"],
      ]);
    }
  });

  it("leave the table fundacad-core copies as it was, in German too", async () => {
    await setLanguage("de");
    const rows = (r: readonly (readonly [string, string, string])[]) => r.map(([field, , kind]) => [field, kind]);
    const V = VECTORS as unknown as { featureNumFields: Record<string, [string, string][]> };
    expect(Object.fromEntries(Object.entries(FEATURE_NUM_FIELDS).map(([type, r]) => [type, rows(r!)]))).toEqual(
      V.featureNumFields,
    );
    expect(Object.fromEntries(Object.keys(V.featureNumFields).map((t) => [t, rows(featureNumFields(t))]))).toEqual(
      V.featureNumFields,
    );
  });
});

describe("the choice and switch rows of a feature", () => {
  it("read as today's English in English", async () => {
    await setLanguage("en");
    const labels = (rows: readonly { field: string; label: string }[]) => rows.map((r) => [r.field, r.label]);
    for (const [type, rows] of Object.entries(CHOICE_ENGLISH))
      expect(labels(choiceFieldsFor(type)), type).toEqual(rows);
    for (const [type, rows] of Object.entries(TOGGLE_ENGLISH))
      expect(labels(toggleFieldsFor(type)), type).toEqual(rows);
  });

  it("read in German, with the field and the fallback unchanged", async () => {
    await setLanguage("de");
    expect(choiceFieldsFor("extrude").map((c) => [c.field, c.label, c.fallback])).toEqual([
      ["operation", de["field.operation"], "new"],
      ["startType", de["field.start"], "sketch"],
      ["startPlane", de["field.startPlane"], "XY"],
      ["startPoint", de["field.startPoint"], ""],
      ["endType", de["field.end"], "distance"],
      ["upToPlane", de["field.upToPlane"], "XY"],
      ["upToPoint", de["field.upToPoint"], ""],
      ["endType2", de["field.end2"], "distance"],
      ["upToPlane2", de["field.upToPlane2"], "XY"],
      ["upToPoint2", de["field.upToPoint2"], ""],
      ["side", de["field.wallSide"], "center"],
    ]);
    expect(toggleFieldsFor("extrude").map((c) => [c.field, c.label, c.fallback])).toEqual([
      ["symmetric", "Symmetrisch", false],
      ["twoSided", "Zweiseitig", false],
      ["thin", "Dünn", false],
    ]);
    expect(choiceFieldsFor("hole").map((c) => c.label)).toEqual([
      "Bohrungstyp",
      "Norm",
      "Größe",
      "Passung",
      "Ausdehnung",
    ]);
    expect(toggleFieldsFor("hole").map((c) => [c.field, c.label])).toEqual([
      ["drillPoint", "Bohrspitze"],
      ["flip", "Richtung umkehren"],
      ["tapped", "Mit Gewinde"],
    ]);
    // One word for one row everywhere: a pattern's Direction and a press-pull's are the same line.
    expect(choiceFieldsFor("patternLinear")[0]!.label).toBe(choiceFieldsFor("press-pull")[1]!.label);
    expect(choiceFieldsFor("draft")[0]!.label).toBe("Entformungsachse");
  });

  it("name the chord length row in the language, only while the fillet is sized by chord", async () => {
    await setLanguage("ja");
    expect(fieldLabel("fillet", "radius", { sizeType: "chord", radius: 2.5 })).toEqual({ text: "弦の長さ" });
    expect(fieldLabel("fillet", "radius", { sizeType: "radius", radius: 2.5 })).toBeNull();
    expect(fieldLabel("fillet", "profile", { sizeType: "chord" })).toBeNull();
    await setLanguage("en");
    expect(fieldLabel("fillet", "radius", { sizeType: "chord" })).toEqual({ text: "Chord Length" });
  });

  it("re-read on a switch through a computed, the way the panel builds its rows", async () => {
    await setLanguage("en");
    const rows = computed(() => choiceFieldsFor("extrude").map((c) => c.label));
    const toggles = computed(() => toggleFieldsFor("extrude").map((c) => c.label));
    expect(rows.value[0]).toBe("Operation");
    expect(rows.value[10]).toBe("Wall side");
    expect(toggles.value).toEqual(["Symmetric", "Two sided", "Thin"]);
    await setLanguage("de");
    expect(rows.value[10]).toBe("Wandseite");
    expect(toggles.value).toEqual(["Symmetrisch", "Zweiseitig", "Dünn"]);
    await setLanguage("ja");
    expect(rows.value[10]).toBe(ja["field.wallSide"]);
    await setLanguage("en");
    expect(rows.value[10]).toBe("Wall side");
  });

  it("keep one table entry as one object, so a switch never leaves a stale copy", async () => {
    await setLanguage("de");
    const entry = FEATURE_CHOICE_FIELDS.extrude![0]!;
    await setLanguage("ja");
    expect(entry.label).toBe(ja["field.operation"]);
    expect(FEATURE_TOGGLE_FIELDS.extrude![2]!.label).toBe(ja["field.thin"]);
  });

  it("hand a plugin's rows through untouched", async () => {
    contribute("Acme.Rivets", {
      features: [
        {
          type: "rivet",
          choiceFields: [
            { field: "head", label: "Head style", options: [{ value: "dome", label: "Dome" }], fallback: "dome" },
          ],
          toggleFields: [{ field: "blind", label: "Blind rivet", fallback: false }],
        },
      ],
    });
    for (const code of ["en", "de"]) {
      await setLanguage(code);
      expect(choiceFieldsFor("rivet").map((c) => c.label)).toEqual(["Head style"]);
      expect(toggleFieldsFor("rivet").map((c) => c.label)).toEqual(["Blind rivet"]);
    }
  });
});
