// The feature's values, as rendered by the panel BOTH surfaces use.
//
// FeatureProperties was lifted out of the docked Parameters panel so the history
// could show these rows under the chip you clicked. That panel is gone now and
// this is the only place a feature's values can be edited, which is what makes
// the write path below the thing to protect. The reason it is one component
// rather than two lists is that these rows are the WRITE PATH into the feature,
// not a display of it, and a second copy would drift the first time a field type
// was added. So what is worth pinning here is that both halves of that write
// path still work: a sketch dimension re-serialising one entity, and a feature
// field going through the unit-agnostic parser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mount, type DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FeatureProperties from "../../../src/components/shell/FeatureProperties.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { contribute, resetContributions } from "../../../src/plugins/contrib";
import {
  TEXTURE_CHOICE_FIELDS,
  TEXTURE_FILE_FIELDS,
  TEXTURE_NUM_FIELDS,
  TEXTURE_TARGETS,
  TEXTURE_TOGGLE_FIELDS,
  sharpnessLabel,
  textureFieldApplies,
} from "../../../plugins/FundaCAD.Texture/textureForm";
import type { Engine } from "../../../src/app/engine";
import { valueProblem } from "../../../src/document/numFields";
import { DocumentStore } from "../../../src/document/store";
import { createDocBridge } from "../../../src/app/docBridge";
import type { GeometryBackend } from "../../../src/geometry/client";
import type { CadDocument, Feature, RebuildReply } from "../../../src/types";

/** Register the Texture plugin's description of its own feature type.
 *
 *  The texture cases below used to need nothing: the pattern dropdown, the
 *  invert switch, the rule that hides a Seed on a knurl and the name of the
 *  shape slider were all tables in src/document/optionFields.ts. None of them is
 *  now, a plugin contributes them, so these tests say so by contributing the
 *  same thing the plugin does. The `no plugin, no rows` control below is the
 *  other half: without this call the rows are genuinely gone, which is what
 *  makes the ones that follow it measure something.
 *
 *  `numFields` and `targets` joined this list when the feature's SCHEMA moved
 *  too. Depth, Scale and the Faces row were the application's own tables until
 *  then, so a texture drew its numbers here whether or not anything described
 *  it, and only the dropdowns needed a plugin. Now nothing does. */
function withTexturePlugin() {
  return contribute("FundaCAD.Texture", {
    features: [
      {
        type: "texture",
        meta: { icon: "texture", label: "Texture" },
        choiceFields: TEXTURE_CHOICE_FIELDS,
        fileFields: TEXTURE_FILE_FIELDS,
        toggleFields: TEXTURE_TOGGLE_FIELDS,
        numFields: TEXTURE_NUM_FIELDS,
        targets: TEXTURE_TARGETS,
        fieldApplies: textureFieldApplies,
        fieldLabel: (field, values) => (field === "sharpness" ? sharpnessLabel(values["profile"]) : null),
      },
    ],
  });
}

/** The narrowest engine FeatureProperties touches. */
function makeEngine(doc: CadDocument) {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const editPreviewVersion = ref(0);
  let live: Feature | null = null;
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const values: { field: string; value: number }[] = [];
  const exprs: { field: string; raw: string }[] = [];
  const store = {
    get document() {
      return doc;
    },
    liveFeature: (id: string) => (live?.id === id ? live : (doc.features.find((f) => f.id === id) ?? null)),
    updateFeature: (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      Object.assign(
        doc.features.find((f) => f.id === id)!,
        patch,
      );
      docVersion.value++;
    },
    boundExpr: () => null,
    isParamBound: () => false,
    setTargetValue: (t: { field: string }, value: number) => {
      values.push({ field: t.field, value });
    },
    setTargetExpr: (t: { field: string }, raw: string) => {
      exprs.push({ field: t.field, raw });
      return null;
    },
  };
  // The selection row asks whether the editor is open on it, and offers to open
  // it. Neither is exercised here, this spec is about the write path for values,
  // but a row that throws while rendering takes every other row down with it,
  // which is exactly what an absent `tools` did.
  const targetEdit = { active: false, editingId: null, field: null, start: () => true };
  return {
    updates,
    values,
    exprs,
    /** What a tool editing the feature has on screen, as store.setEditPreview does. */
    editLive: (f: Feature | null) => {
      live = f;
      editPreviewVersion.value++;
    },
    engine: {
      store,
      bridge: { docVersion, buildVersion, editPreviewVersion },
      tools: { targetEdit },
      toolBusy: () => false,
    } as unknown as Engine,
  };
}

function render(fake: ReturnType<typeof makeEngine>, featureId: string): VueWrapper {
  return mount(FeatureProperties, {
    props: { featureId, unit: "mm" },
    global: { provide: { [ENGINE as symbol]: fake.engine } },
  });
}

/** Every row as [label, unit, value]. The unit is a chip beside the value and
 *  NOT part of the label: a label is a name, and "Radius mm | 5in" reads as a
 *  contradiction.
 *
 *  A row is not always a text box, a fixed choice is a Select, a switch is a
 *  Switch, a FILE is a button carrying the name of what was chosen, and a
 *  SELECTION row has no control at all, only the summary of what the feature
 *  acts on and a button that opens the editor. This reads whichever the row has.
 *  A row with none of them is a row that renders nothing, which is worth failing
 *  on rather than skipping. */
const rows = (w: VueWrapper) =>
  w.findAll(".param-row").map((r) => {
    const sel = r.find("[role=combobox]:not(.ui-unit-chip)");
    const box = r.find("[role=switch]");
    const count = r.find(".target-count");
    const file = r.find("button.file-pick");
    const value = sel.exists()
      ? sel.attributes("data-value")
      : box.exists()
        ? box.attributes("aria-checked")
        : count.exists()
          ? count.text()
          : file.exists()
            ? file.text()
            : (r.find("input").element as HTMLInputElement).value;
    return [r.find("label").text(), r.find(".ui-unit-chip").exists() ? r.find(".ui-unit-chip").text() : "", value];
  });

/** Just the labels, in the order the panel puts them. */
const labels = (w: VueWrapper) => w.findAll(".param-row label").map((l) => l.text());

/** The Select inside `row`, the value's or its unit chip's. */
const selectIn = (w: VueWrapper, row: DOMWrapper<Element>) =>
  w.findAllComponents({ name: "Select" }).find((c) => row.element.contains(c.find("[role=combobox]").element))!;

/** Pick `value` in the Select of the row labelled `label`. Select's own keys are its spec's business. */
async function choose(w: VueWrapper, label: string, value: string) {
  const row = w.findAll(".param-row").find((r) => r.find("label").text() === label)!;
  const sel = selectIn(w, row);
  sel.vm.$emit("update:modelValue", value);
  await sel.vm.$nextTick();
}

/** Flip the switch of the row labelled `label`. */
async function flip(w: VueWrapper, label: string) {
  const row = w.findAll(".param-row").find((r) => r.find("label").text() === label)!;
  await row.find("[role=switch]").trigger("click");
}

/** Commit `text` into the row whose label starts with `label`. */
async function commit(w: VueWrapper, label: string, text: string) {
  const row = w.findAll(".param-row").find((r) => r.find("label").text().startsWith(label))!;
  const input = row.find("input");
  input.element.value = text;
  await input.trigger("input");
  await input.trigger("keydown", { key: "Enter" }); // Enter is the commit, not input
}

const CIRCLE = (r: number): Feature =>
  ({
    id: "s1",
    type: "sketch",
    plane: "XY",
    entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: r }],
  }) as Feature;

const EXTRUDE: Feature = { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" } as Feature;

describe("FeatureProperties", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  // A contribution left behind changes what the next test renders, and the
  // control above depends on there being none.
  afterEach(() => {
    resetContributions();
  });

  it("lists a sketch's entity dimensions", () => {
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    // The circle's diameter, in the unit the caller passed.
    expect(rows(render(fake, "s1"))).toEqual([["Diameter", "mm", "12"]]);
  });

  it("lists a feature's numeric fields", () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    expect(rows(render(fake, "e1"))).toContainEqual(["Distance", "mm", "10"]);
  });

  it("gives a unitless field no unit chip rather than a blank one", () => {
    // A fillet's conic profile is a ratio, and "Profile mm" was never true.
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "f1", type: "fillet", radius: 2, profile: 0.5 } as unknown as Feature],
    });
    expect(rows(render(fake, "f1"))).toEqual([
      // What the fillet is applied to leads: it is the other half of the
      // feature, and the half that used to be invisible once committed.
      ["Edges", "", "nothing selected"],
      ["Size Type", "", "radius"],
      ["Continuity", "", "G1"],
      ["Include Tangent Edges", "", "true"],
      ["Radius", "mm", "2"],
      ["Profile", "", "0.5"],
    ]);
  });

  it("writes a sketch dimension back through the ONE entity it belongs to", async () => {
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    const w = render(fake, "s1");
    await commit(w, "Diameter", "20");
    // Diameter 20 is radius 10, the row is a diameter, the document stores a
    // radius, and entityDims owns that conversion.
    expect(fake.updates).toHaveLength(1);
    const ents = fake.updates[0]!.patch["entities"] as { radius: number }[];
    expect(ents[0]!.radius).toBeCloseTo(10, 9);
  });

  it("pins a sketch dimension retyped at its current value in another spelling, as a native change did", async () => {
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    const w = render(fake, "s1");
    await commit(w, "Diameter", "12");
    expect(fake.updates).toEqual([]);
    await commit(w, "Diameter", "12.0");
    const drives = (fake.updates[0]?.patch["constraints"] ?? []) as { type: string; value?: number }[];
    expect([fake.updates.length, drives.map((c) => [c.type, c.value])]).toEqual([1, [["diameter", 12]]]);
  });

  it("takes a unit the field is not showing", async () => {
    // The whole point of routing every value surface through ui/measure: this
    // row says mm, and "1 inch" has to mean 25.4mm rather than 1. parseFloat
    // returned 1 here and reported nothing, so the part was simply wrong.
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    await commit(render(fake, "s1"), "Diameter", "1 inch");
    const ents = fake.updates[0]!.patch["entities"] as { radius: number }[];
    expect(ents[0]!.radius).toBeCloseTo(12.7, 9); // 1in diameter = 12.7mm radius
  });

  it("takes a fraction, which parseFloat read as its numerator", async () => {
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    await commit(render(fake, "s1"), "Diameter", '1/2"');
    const ents = fake.updates[0]!.patch["entities"] as { radius: number }[];
    expect(ents[0]!.radius).toBeCloseTo(6.35, 9); // half-inch diameter
  });

  it("refuses text that is not a value instead of writing NaN", async () => {
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    const w = render(fake, "s1");
    await commit(w, "Diameter", "banana");
    expect(fake.updates).toHaveLength(0);
    // The input goes red and KEEPS the rejected text, so the value can be
    // fixed rather than retyped, and the tooltip says what was wrong.
    const input = w.find("input");
    expect(input.attributes("aria-invalid")).toBe("true");
    expect(input.element.value).toBe("banana");
    expect(input.attributes("title")).toBeTruthy();
  });

  // --- the feature-field write path (the sketch rows above are the other half)
  //
  // These two rows sit one under the other in the same panel and used to
  // disagree about what a unit is: "1 inch" worked on a sketch dimension and
  // "5in" was rejected on the field below it, because a feature field sent
  // anything that was not a plain number to the parameter EXPRESSION engine,
  // which has no unit vocabulary.

  it("takes a unit-bearing literal in a feature field", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    await commit(render(fake, "e1"), "Distance", "5in");
    expect(fake.values).toEqual([{ field: "distance", value: 127 }]);
    expect(fake.exprs).toEqual([]); // NOT the expression engine's business
  });

  it("shows the value back in the unit that was typed", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    const w = render(fake, "e1");
    await commit(w, "Distance", "5in");
    // The row adopts a unit the user wrote, the way the heads-up dimension box
    // does. Converting it straight back to mm would answer a request with the
    // thing that was being corrected.
    expect(w.find(".param-row .ui-unit-chip").text()).toBe("in");
  });

  it("leaves a bare expression to the parameter engine, in canonical units", async () => {
    // The deliberate fork (plan decision R4): a literal INSIDE an expression is
    // canonical, so a file evaluates identically on every machine, whatever the
    // machine happens to be displaying. Only a written unit means display units.
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    await commit(render(fake, "e1"), "Distance", "width/2");
    expect(fake.exprs).toEqual([{ field: "distance", raw: "width/2" }]);
    expect(fake.values).toEqual([]);
  });

  it("refuses a length typed into an angle field", async () => {
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "r1", type: "revolve", sketch: "s1", angle: 90 } as unknown as Feature],
    });
    const w = render(fake, "r1");
    await commit(w, "Angle", "5in");
    // Reported rather than passed to the expression engine: no reading of "5in"
    // makes it an angle, and 5 degrees is a guess at what was meant.
    expect(fake.values).toEqual([]);
    expect(fake.exprs).toEqual([]);
    expect(w.find("input").attributes("aria-invalid")).toBe("true");
  });

  // A value the field cannot take is refused in the row, in the words the
  // heads-up box uses for the same field, before anything reaches the build.
  const FILLET = (): Feature => ({ id: "f1", type: "fillet", radius: 2 }) as unknown as Feature;
  const problemUnder = (w: VueWrapper, label: string) =>
    w
      .findAll(".param-row")
      .find((r) => r.find("label").text() === label)!
      .find(".param-problem");

  it("refuses a negative radius in the row and writes nothing", async () => {
    const fake = makeEngine({ parameters: {}, features: [FILLET()] });
    const w = render(fake, "f1");
    await commit(w, "Radius", "-2");
    expect(fake.values).toEqual([]);
    expect(fake.exprs).toEqual([]);
    expect(problemUnder(w, "Radius").text()).toBe(valueProblem("Radius", { positive: true }, -2));
    expect(problemUnder(w, "Radius").text()).toBe("Radius must be more than 0");
  });

  it("refuses a negative radius that names a unit too", async () => {
    const fake = makeEngine({ parameters: {}, features: [FILLET()] });
    const w = render(fake, "f1");
    await commit(w, "Radius", "-1in");
    expect(fake.values).toEqual([]);
    expect(problemUnder(w, "Radius").text()).toBe("Radius must be more than 0");
  });

  it("still takes a radius above zero", async () => {
    const fake = makeEngine({ parameters: {}, features: [FILLET()] });
    const w = render(fake, "f1");
    await commit(w, "Radius", "2,5");
    expect(fake.values).toEqual([{ field: "radius", value: 2.5 }]);
    expect(problemUnder(w, "Radius").exists()).toBe(false);
  });

  it("wants a whole count of at least one", async () => {
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "p1", type: "patternLinear", count: 3, spacing: 10 } as unknown as Feature],
    });
    const w = render(fake, "p1");
    await commit(w, "Count", "2.5");
    expect(problemUnder(w, "Count").text()).toBe("Count must be a whole number");
    await commit(w, "Count", "0");
    expect(problemUnder(w, "Count").text()).toBe("Count must be at least 1");
    expect(fake.values).toEqual([]);
    await commit(w, "Count", "4");
    expect(fake.values).toEqual([{ field: "count", value: 4 }]);
  });

  it("renders nothing but the selection for a feature with no numeric fields", () => {
    // Delete Face has no values at all. It is still a verb applied to geometry,
    // so the one row it does have is the face it removes.
    const fake = makeEngine({ parameters: {}, features: [{ id: "d1", type: "deleteFace" } as Feature] });
    expect(rows(render(fake, "d1"))).toEqual([["Face", "", "nothing selected"]]);
  });

  it("shows the selection a feature actually carries, counted", () => {
    const fake = makeEngine({
      parameters: {},
      features: [
        {
          id: "f1",
          type: "fillet",
          radius: 2,
          edges: [
            { kind: "edge", by: "nearest", point: [0, 0, 0] },
            { kind: "edge", by: "nearest", point: [1, 0, 0] },
          ],
        } as unknown as Feature,
      ],
    });
    expect(rows(render(fake, "f1"))).toContainEqual(["Edges", "", "2 edges"]);
  });

  it("opens the selection editor from Edit, and refuses a second one while it is open on this row", async () => {
    const fake = makeEngine({ parameters: {}, features: [FILLET_ROW()] });
    const started: string[] = [];
    const targetEdit = (fake.engine.tools as unknown as { targetEdit: Record<string, unknown> }).targetEdit;
    targetEdit.start = (id: string) => (started.push(id), true);
    const w = render(fake, "f1");
    const edit = () =>
      w
        .findAll(".param-row")
        .find((r) => r.find("label").text() === "Edges")!
        .find(".target-edit");
    expect([edit().attributes("aria-disabled"), edit().attributes("title")]).toEqual([
      undefined,
      "Change which edges this acts on",
    ]);
    await edit().trigger("click");
    expect(started).toEqual(["f1"]);
    w.unmount();

    Object.assign(targetEdit, { active: true, editingId: "f1", field: { field: "edges" } });
    const v = render(fake, "f1");
    const busy = v
      .findAll(".param-row")
      .find((r) => r.find("label").text() === "Edges")!
      .find(".target-edit");
    expect([busy.attributes("aria-disabled"), busy.attributes("title")]).toEqual(["true", "Editing this selection"]);
    await busy.trigger("click");
    expect(started).toEqual(["f1"]);
  });

  it("says what an empty selection MEANS where empty means something", () => {
    // "0 faces" and "sealed hollow" are opposite answers about the same part,
    // and a count alone cannot tell them apart.
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "sh", type: "shell", thickness: 2 } as unknown as Feature],
    });
    expect(rows(render(fake, "sh"))).toContainEqual(["Faces to open", "", "sealed hollow"]);
  });

  // --- the rows that are not numbers ---------------------------------------
  //
  // Every fact about a feature that is a CHOICE used to be settable once, at
  // the moment the feature was made, and never again: the panel could only
  // render numbers, so a texture created as a knurl stayed a knurl and an
  // extrude's boolean was whatever the tool had decided.

  it("shows what the tool editing the feature has on screen, not what was committed", async () => {
    // The field report: the fillet tool's chip read G2 while this row read G1.
    const fillet = { id: "f1", type: "fillet", radius: 43.7, profile: 0.987 } as unknown as Feature;
    const fake = makeEngine({ parameters: {}, features: [fillet] });
    const w = render(fake, "f1");
    expect(rows(w)).toContainEqual(["Continuity", "", "G1"]);
    fake.editLive({ ...fillet, continuity: "G2", radius: 38 } as unknown as Feature);
    await w.vm.$nextTick();
    expect(rows(w)).toContainEqual(["Continuity", "", "G2"]);
    expect(rows(w)).toContainEqual(["Radius", "mm", "38"]);
    fake.editLive(null);
    await w.vm.$nextTick();
    expect(rows(w)).toContainEqual(["Continuity", "", "G1"]);
  });

  it("offers a feature's fixed choices, not just its numbers", () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    expect(rows(render(fake, "e1"))).toContainEqual(["Operation", "", "new"]);
  });

  it("writes a chosen option straight onto the feature", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    await choose(render(fake, "e1"), "Operation", "cut");
    expect(fake.updates).toEqual([{ id: "e1", patch: { operation: "cut" } }]);
  });

  it("shows the builder's default for a choice the feature does not carry", () => {
    // Most of these fields are optional, and a feature saved before one existed
    // has none. An empty dropdown would then be claiming the operation is unset
    // when the rebuild is about to pick one.
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "l1", type: "loft", sketches: ["s1", "s2"] } as unknown as Feature],
    });
    expect(rows(render(fake, "l1"))).toContainEqual(["Operation", "", "new"]);
  });

  // CONTROL for the cases that follow. Everything they assert comes from a
  // plugin now, so if it were somehow still in the application they would all
  // pass whether or not the contribution was made, and would be measuring
  // nothing.
  it("still shows a missing plugin's feature its own numbers, unlabelled", () => {
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "image", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    const l = labels(render(fake, "t1"));
    // THE PROMISE THIS KEEPS. The plugin owns the schema now, so the app does
    // not know this feature has a field called Depth, let alone what to call
    // it. What it must not do is drop the values: they are still here, still
    // editable, still parameter-drivable, listed by their own field names.
    // Anything less and uninstalling a plugin would quietly eat the numbers
    // somebody typed, and the next save would make that permanent.
    expect(l).toContain("depth");
    expect(l).toContain("scale");
    // Labelled, ordered and filtered is the plugin's job, and it is not here.
    expect(l).not.toContain("Depth");
    expect(l).not.toContain("Pattern");
    expect(l).not.toContain("Invert heights");
    // Nothing is invented either: `kind` is a string, not a number, so it gets
    // no spin box. A row over it would write a number into a field the geometry
    // reads as a pattern name.
    expect(l).not.toContain("kind");
  });

  it("puts the choices above the numbers they govern", () => {
    // A texture's pattern decides whether Angle and Seed are there at all, so a
    // reader who met the numbers first would be reading upward.
    withTexturePlugin();
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "knurl", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    const l = labels(render(fake, "t1"));
    // The selection leads the whole panel, then the choices, then the numbers.
    expect(l.indexOf("Faces")).toBe(0);
    expect(l.indexOf("Pattern")).toBeLessThan(l.indexOf("Depth"));
    expect(l.indexOf("Faces")).toBeLessThan(l.indexOf("Pattern"));
  });

  it("gives a switch to a field that is on or off", async () => {
    withTexturePlugin();
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "image", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    const w = render(fake, "t1");
    expect(rows(w)).toContainEqual(["Invert heights", "", "false"]);
    await flip(w, "Invert heights");
    expect(fake.updates).toEqual([{ id: "t1", patch: { invert: true } }]);
  });

  it("hides a row the chosen pattern will never read", () => {
    // The defect this rule exists for: the panel offered Seed and Angle on every
    // texture. A knurl reads no seed, the engine ignores it, so turning that
    // row did nothing and nothing said why.
    withTexturePlugin();
    const knurl = makeEngine({
      parameters: {},
      features: [
        { id: "t1", type: "texture", kind: "knurl", depth: 0.4, scale: 2, seed: 1, angle: 0 } as unknown as Feature,
      ],
    });
    const l = labels(render(knurl, "t1"));
    expect(l).toContain("Angle");
    expect(l).not.toContain("Seed");

    const noise = makeEngine({
      parameters: {},
      features: [
        { id: "t1", type: "texture", kind: "noise", depth: 0.4, scale: 2, seed: 1, angle: 0 } as unknown as Feature,
      ],
    });
    const n = labels(render(noise, "t1"));
    expect(n).toContain("Seed");
    expect(n).not.toContain("Angle");
  });

  it("offers the heightmap file, and only to the pattern that reads one", async () => {
    // The report: choose Heightmap in Properties and the pattern changes to the
    // one that reads an image, with nowhere to say WHICH image. The rule that
    // says imagePath applies to `image` and nothing else had existed for a long
    // time; there was no KIND of row that could show a path, so nothing read it.
    withTexturePlugin();
    const heightmap = makeEngine({
      parameters: {},
      features: [
        {
          id: "t1",
          type: "texture",
          kind: "image",
          depth: 0.4,
          scale: 2,
          imagePath: "C:/pictures/relief.png",
        } as unknown as Feature,
      ],
    });
    const w = render(heightmap, "t1");
    expect(labels(w)).toContain("Heightmap");
    // The NAME of the file, not the path: the value column is 120px, and the
    // whole path is on the row's title where nothing is lost.
    const row = w.findAll(".param-row").find((r) => r.find("label").text() === "Heightmap")!;
    expect(row.find("button.file-pick").text()).toBe("relief.png");
    expect(row.attributes("title")).toBe("C:/pictures/relief.png");

    // Clearing is the way back from a heightmap that has been moved or deleted,
    // which otherwise fails every rebuild with no row to fix it in.
    await row.find("button.file-clear").trigger("click");
    expect(heightmap.updates).toEqual([{ id: "t1", patch: { imagePath: "" } }]);
  });

  it("THE CONTROL: a pattern that reads no file gets no file row", () => {
    withTexturePlugin();
    const knurl = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "knurl", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    expect(labels(render(knurl, "t1"))).not.toContain("Heightmap");
  });

  it("shows a heightmap row with nothing chosen as a prompt to choose", () => {
    // A texture whose file was never set, or was just cleared. An empty row that
    // rendered as a blank button would read as broken rather than as unset.
    withTexturePlugin();
    const empty = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "image", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    const row = render(empty, "t1")
      .findAll(".param-row")
      .find((r) => r.find("label").text() === "Heightmap")!;
    expect(row.find("button.file-pick").text()).toBe("Choose\u2026");
    // and no Clear, because there is nothing to clear
    expect(row.find("button.file-clear").exists()).toBe(false);
  });

  it("gives an extrude the Symmetric switch, and writes it", async () => {
    // The report: an extrude off a datum plane inside a body has material on
    // both sides and no way to say so, and a committed one could not be talked
    // out of the direction it was dragged in.
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "e1", type: "extrude", sketch: "s1", distance: 5, operation: "cut" } as unknown as Feature],
    });
    const w = render(fake, "e1");
    expect(rows(w)).toContainEqual(["Symmetric", "", "false"]);
    await flip(w, "Symmetric");
    expect(fake.updates).toEqual([{ id: "e1", patch: { symmetric: true } }]);
  });

  it("renames the shape slider to what it currently does", () => {
    // The same number is a flat LAND width on a faceted surface and a crispness
    // on a smooth one. Calling both "Sharpness" describes neither.
    withTexturePlugin();
    const facet = makeEngine({
      parameters: {},
      features: [
        {
          id: "t1",
          type: "texture",
          kind: "knurl",
          profile: "facet",
          depth: 0.4,
          scale: 2,
          sharpness: 0.5,
        } as unknown as Feature,
      ],
    });
    expect(labels(render(facet, "t1"))).toContain("Land");
    const round = makeEngine({
      parameters: {},
      features: [
        {
          id: "t1",
          type: "texture",
          kind: "knurl",
          profile: "round",
          depth: 0.4,
          scale: 2,
          sharpness: 0.5,
        } as unknown as Feature,
      ],
    });
    expect(labels(render(round, "t1"))).toContain("Sharp");
  });
});

describe("FeatureProperties expressions through NumberField", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => resetContributions());

  /** The engine of makeEngine, with the store's expression answers under the test's control. */
  type FakeStore = {
    boundExpr: (t: { field: string }) => { name: string; expr: string; value: number } | null;
    isParamBound: (t: { field: string }) => boolean;
    setTargetExpr: (t: { field: string }, raw: string) => string | null;
  };
  const storeOf = (fake: ReturnType<typeof makeEngine>) => fake.engine.store as unknown as FakeStore;
  const field = (w: VueWrapper, label: string) =>
    w.findAll(".param-row").find((r) => r.find("label").text().startsWith(label))!;

  it.each([["width"], ["width/2"], ["20+5"], ["d=20"], ["w * 2 + 1"]])(
    "hands %j to the parameter engine as typed",
    async (raw) => {
      const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
      await commit(render(fake, "e1"), "Distance", raw);
      expect(fake.exprs).toEqual([{ field: "distance", raw }]);
      expect(fake.values).toEqual([]);
    },
  );

  it("keeps an expression the parameter engine refuses, and says why under the row", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    storeOf(fake).setTargetExpr = () => 'unknown parameter "widht"';
    const w = render(fake, "e1");
    await commit(w, "Distance", "widht/2");
    const input = field(w, "Distance").find("input");
    expect([(input.element as HTMLInputElement).value, input.attributes("aria-invalid")]).toEqual(["widht/2", "true"]);
    expect(field(w, "Distance").find(".param-problem").text()).toBe('unknown parameter "widht"');
  });

  it("follows the expression once the queued commit lands, though the field is still focused", async () => {
    // A parameter commit resolves on a promise chain frames after Enter.
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    const w = mount(FeatureProperties, {
      props: { featureId: "e1", unit: "mm" },
      global: { provide: { [ENGINE as symbol]: fake.engine } },
      attachTo: document.body,
    });
    const input = field(w, "Distance").find("input");
    (input.element as HTMLInputElement).focus();
    await commit(w, "Distance", "width/2");
    storeOf(fake).boundExpr = () => ({ name: "d1", expr: "width/2", value: 20 });
    storeOf(fake).isParamBound = () => true;
    fake.engine.bridge.docVersion.value++;
    await w.vm.$nextTick();
    expect([(input.element as HTMLInputElement).value, document.activeElement]).toEqual(["width/2", input.element]);
    expect(field(w, "Distance").classes()).toContain("fx-row");
    w.unmount();
  });

  it("shows a bound field's expression with a caption chip, and a typed number replaces it", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    storeOf(fake).boundExpr = () => ({ name: "d1", expr: "w/4", value: 10 });
    storeOf(fake).isParamBound = () => true;
    const w = render(fake, "e1");
    const row = field(w, "Distance");
    expect(row.classes()).toContain("fx-row");
    expect((row.find("input").element as HTMLInputElement).value).toBe("w/4");
    const chip = row.find(".ui-unit-chip");
    expect([chip.text(), chip.attributes("role"), chip.attributes("title")]).toEqual([
      "mm",
      undefined,
      "Expressions are written in this unit",
    ]);
    // The same number the expression yields still replaces the expression: the user typed a literal.
    await commit(w, "Distance", "10");
    expect(fake.values).toEqual([{ field: "distance", value: 10 }]);
  });

  it("reads a fraction in the row's unit, as one value and not arithmetic", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    const w = mount(FeatureProperties, {
      props: { featureId: "e1", unit: "in" },
      global: { provide: { [ENGINE as symbol]: fake.engine } },
    });
    await commit(w, "Distance", "1/2");
    await commit(w, "Distance", "1 1/2");
    expect(fake.values.map((v) => Math.round(v.value * 1e9) / 1e9)).toEqual([12.7, 38.1]);
    expect(fake.exprs).toEqual([]);
  });

  it("changes a row's unit from the chip and shows the value in it", async () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    const w = render(fake, "e1");
    const row = field(w, "Distance");
    const chip = selectIn(w, row);
    chip.vm.$emit("update:modelValue", "in");
    await w.vm.$nextTick();
    expect(field(w, "Distance").find(".ui-unit-chip").text()).toBe("in");
    expect((field(w, "Distance").find("input").element as HTMLInputElement).value).toBe("0.394");
  });

  it("offers the units the field's kind can take, by chip", () => {
    const fake = makeEngine({ parameters: {}, features: [EXTRUDE] });
    const chip = field(render(fake, "e1"), "Distance").find(".ui-unit-chip");
    expect([chip.attributes("role"), chip.attributes("title")]).toEqual(["combobox", "Change unit"]);
  });

  it("puts a refused row's text back on Escape, and its error goes with it", async () => {
    const fake = makeEngine({ parameters: {}, features: [FILLET_ROW()] });
    const w = render(fake, "f1");
    await commit(w, "Radius", "-2");
    const input = field(w, "Radius").find("input");
    await input.trigger("keydown", { key: "Escape" });
    expect([(input.element as HTMLInputElement).value, field(w, "Radius").find(".param-problem").exists()]).toEqual([
      "2",
      false,
    ]);
  });
});

const FILLET_ROW = (): Feature => ({ id: "f1", type: "fillet", radius: 2 }) as unknown as Feature;

describe("FeatureProperties typed preview", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => void vi.useRealTimers());

  it("keeps the features after the one being typed into built around the live value", async () => {
    // The field report: typing into a box's Height in an exploded assembly
    // rolled every later move and boolean away until Enter.
    const backend = {
      async rebuild(): Promise<RebuildReply> {
        return {
          ok: true,
          result: { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: null, bodies: [] },
        } as unknown as RebuildReply;
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      connected: true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, {
      parameters: {},
      features: [
        { id: "bx", type: "box", length: 20, width: 20, height: 20 },
        { id: "mv", type: "move", dx: 40, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, bodies: ["body1"] },
        { id: "cut", type: "boolean", operation: "cut", target: "body2", tools: ["body1"] },
      ] as Feature[],
    });
    const engine = {
      store,
      bridge: { docVersion: ref(0), buildVersion: ref(0), editPreviewVersion: ref(0) },
      tools: { targetEdit: { active: false, editingId: null, field: null, start: () => true } },
      toolBusy: () => false,
    } as unknown as Engine;
    const w = mount(FeatureProperties, {
      props: { featureId: "bx", unit: "mm" },
      global: { provide: { [ENGINE as symbol]: engine } },
    });
    const row = w.findAll(".param-row").find((r) => r.find("label").text().startsWith("Height"))!;
    const input = row.find("input");
    input.element.value = "120";
    await input.trigger("input");
    await vi.advanceTimersByTimeAsync(300);
    expect(store.editPreviewId).toBe("bx");
    const built = store.builtDocument().features;
    expect(built.map((f) => f.id)).toEqual(["bx", "mv", "cut"]);
    expect((built[0] as { height: number }).height).toBe(120);
    w.unmount();
  });

  it("ends the preview on Escape and on unmount, and previews no expression", async () => {
    const backend = {
      async rebuild(): Promise<RebuildReply> {
        return {
          ok: true,
          result: { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: null, bodies: [] },
        } as unknown as RebuildReply;
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      connected: true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, {
      parameters: {},
      features: [{ id: "bx", type: "box", length: 20, width: 20, height: 20 }] as Feature[],
    });
    const engine = {
      store,
      bridge: { docVersion: ref(0), buildVersion: ref(0), editPreviewVersion: ref(0) },
      tools: { targetEdit: { active: false, editingId: null, field: null, start: () => true } },
      toolBusy: () => false,
    } as unknown as Engine;
    const w = mount(FeatureProperties, {
      props: { featureId: "bx", unit: "mm" },
      global: { provide: { [ENGINE as symbol]: engine } },
    });
    const input = () =>
      w
        .findAll(".param-row")
        .find((r) => r.find("label").text().startsWith("Height"))!
        .find("input");
    const type = async (text: string) => {
      input().element.value = text;
      await input().trigger("input");
      await vi.advanceTimersByTimeAsync(300);
    };
    await type("width");
    expect(store.editPreviewId).toBeNull();
    await type("30");
    expect(store.editPreviewId).toBe("bx");
    await input().trigger("keydown", { key: "Escape" });
    expect([store.editPreviewId, input().element.value]).toEqual([null, "20"]);
    await type("40");
    expect(store.editPreviewId).toBe("bx");
    w.unmount();
    expect(store.editPreviewId).toBeNull();
  });
});

describe("FeatureProperties typed preview through the app's bridge", () => {
  // The bridge moves with the preview, so from the first preview tick the row's model is the previewed value, as it
  // is in the app. A static bridge never shows that.
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
  });
  afterEach(() => void vi.useRealTimers());

  function open() {
    const built: number[] = [];
    const backend = {
      async rebuild(doc: CadDocument): Promise<RebuildReply> {
        built.push((doc.features.find((f) => f.id === "bx") as unknown as { height: number }).height);
        return {
          ok: true,
          result: { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: null, bodies: [] },
        } as unknown as RebuildReply;
      },
      async init() {},
      onStatus() {
        return () => {};
      },
      connected: true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, {
      parameters: {},
      features: [{ id: "bx", type: "box", length: 20, width: 20, height: 20 }] as Feature[],
    });
    const bridge = createDocBridge(store);
    const engine = {
      store,
      bridge,
      tools: { targetEdit: { active: false, editingId: null, field: null, start: () => true } },
      toolBusy: () => false,
    } as unknown as Engine;
    const w = mount(FeatureProperties, {
      props: { featureId: "bx", unit: "mm" },
      global: { provide: { [ENGINE as symbol]: engine } },
      attachTo: document.body,
    });
    const input = () =>
      w
        .findAll(".param-row")
        .find((r) => r.find("label").text().startsWith("Height"))!
        .find("input");
    (input().element as HTMLInputElement).focus();
    const settle = () => vi.advanceTimersByTimeAsync(1000);
    return {
      type: async (text: string) => {
        input().element.value = text;
        await input().trigger("input");
        await vi.advanceTimersByTimeAsync(300);
      },
      key: async (key: string) => {
        await input().trigger("keydown", { key });
        await settle();
      },
      blur: async () => {
        await input().trigger("blur");
        await settle();
      },
      state: () => ({
        doc: (store.document.features[0] as unknown as { height: number }).height,
        field: (input().element as HTMLInputElement).value,
        preview: store.editPreviewId,
        built: built.at(-1),
        undo: store.canUndo,
      }),
      close: () => {
        w.unmount();
        bridge.dispose();
      },
    };
  }

  it("commits a value typed after its preview opened, on Enter and on blur", async () => {
    const p = open();
    await p.type("30");
    expect(p.state()).toEqual({ doc: 20, field: "30", preview: "bx", built: 30, undo: false });
    await p.key("Enter");
    expect(p.state()).toEqual({ doc: 30, field: "30", preview: null, built: 30, undo: true });
    await p.type("40");
    await p.type("50");
    await p.blur();
    expect(p.state()).toEqual({ doc: 50, field: "50", preview: null, built: 50, undo: true });
    p.close();
  });

  it("previews a step from ArrowUp and commits it on Enter", async () => {
    const p = open();
    await p.key("ArrowUp");
    expect(p.state()).toEqual({ doc: 20, field: "21", preview: "bx", built: 21, undo: false });
    await p.key("Enter");
    expect(p.state()).toEqual({ doc: 21, field: "21", preview: null, built: 21, undo: true });
    p.close();
  });

  it("rebuilds the document value when a previewed field is cleared and Enter restores it", async () => {
    const p = open();
    await p.type("30");
    await p.type("");
    await p.key("Enter");
    expect(p.state()).toEqual({ doc: 20, field: "20", preview: null, built: 20, undo: false });
    p.close();
  });
});

describe("FeatureProperties on a feature this version does not know", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("shows why it is left out and no fields to change", () => {
    const doc: CadDocument = {
      parameters: {},
      features: [{ id: "w1", type: "futureWidget", size: 4 } as unknown as Feature],
    };
    const fake = makeEngine(doc);
    (fake.engine.store as unknown as { buildState: unknown }).buildState = {
      result: {
        skippedFeatures: [{ feature_id: "w1", type: "futureWidget", message: "unknown feature type: futureWidget" }],
      },
    };
    const w = render(fake, "w1");
    expect(w.find(".param-note").text()).toBe(
      "Not included: this version of FundaCAD does not know this feature type. It is kept and saved with the file. A newer FundaCAD or a plugin can build it.",
    );
    expect(w.findAll(".param-row")).toHaveLength(0);
  });
});
