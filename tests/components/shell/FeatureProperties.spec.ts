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

import { beforeEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FeatureProperties from "../../../src/components/shell/FeatureProperties.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { CadDocument, Feature } from "../../../src/types";

/** The narrowest engine FeatureProperties touches. */
function makeEngine(doc: CadDocument) {
  const docVersion = ref(0);
  const buildVersion = ref(0);
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const values: { field: string; value: number }[] = [];
  const exprs: { field: string; raw: string }[] = [];
  const store = {
    get document() { return doc; },
    updateFeature: (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      Object.assign(doc.features.find((f) => f.id === id)!, patch);
      docVersion.value++;
    },
    boundExpr: () => null,
    isParamBound: () => false,
    setTargetValue: (t: { field: string }, value: number) => { values.push({ field: t.field, value }); },
    setTargetExpr: (t: { field: string }, raw: string) => { exprs.push({ field: t.field, raw }); return null; },
  };
  return {
    updates,
    values,
    exprs,
    engine: { store, bridge: { docVersion, buildVersion } } as unknown as Engine,
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
 *  A row is not always a text box any more — a fixed choice is a <select> and a
 *  switch is a checkbox — so this reads whichever control the row has rather
 *  than assuming. A row with no control at all is a row that renders nothing,
 *  which is worth failing on rather than skipping. */
const rows = (w: VueWrapper) =>
  w.findAll(".param-row").map((r) => {
    const sel = r.find("select");
    const box = r.find("input[type=checkbox]");
    const value = sel.exists()
      ? (sel.element as HTMLSelectElement).value
      : box.exists()
        ? String((box.element as HTMLInputElement).checked)
        : (r.find("input").element as HTMLInputElement).value;
    return [
      r.find("label").text(),
      r.find(".dim-unit").exists() ? r.find(".dim-unit").text() : "",
      value,
    ];
  });

/** Just the labels, in the order the panel puts them. */
const labels = (w: VueWrapper) =>
  w.findAll(".param-row label").map((l) => l.text());

/** Pick `value` in the <select> of the row labelled `label`. */
async function choose(w: VueWrapper, label: string, value: string) {
  const row = w.findAll(".param-row").find((r) => r.find("label").text() === label)!;
  const sel = row.find("select");
  (sel.element as HTMLSelectElement).value = value;
  await sel.trigger("change");
}

/** Commit `text` into the row whose label starts with `label`. */
async function commit(w: VueWrapper, label: string, text: string) {
  const row = w.findAll(".param-row").find((r) => r.find("label").text().startsWith(label))!;
  const input = row.find("input");
  input.element.value = text;
  await input.trigger("input");
  await input.trigger("change"); // change is the commit, not input
}

const CIRCLE = (r: number): Feature =>
  ({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: r }] }) as Feature;

const EXTRUDE: Feature =
  ({ id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" }) as Feature;

describe("FeatureProperties", () => {
  beforeEach(() => { setActivePinia(createPinia()); });

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
    expect(rows(render(fake, "f1"))).toEqual([["Radius", "mm", "2"], ["Profile", "", "0.5"]]);
  });

  it("writes a sketch dimension back through the ONE entity it belongs to", async () => {
    const fake = makeEngine({ parameters: {}, features: [CIRCLE(6)] });
    const w = render(fake, "s1");
    await commit(w, "Diameter", "20");
    // Diameter 20 is radius 10 — the row is a diameter, the document stores a
    // radius, and entityDims owns that conversion.
    expect(fake.updates).toHaveLength(1);
    const ents = fake.updates[0]!.patch["entities"] as { radius: number }[];
    expect(ents[0]!.radius).toBeCloseTo(10, 9);
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
    expect(input.classes()).toContain("input-error");
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
    expect(w.find(".param-row .dim-unit").text()).toBe("in");
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
    expect(w.find("input").classes()).toContain("input-error");
  });

  it("renders nothing for a feature with no numeric fields", () => {
    const fake = makeEngine({ parameters: {}, features: [{ id: "d1", type: "deleteFace" } as Feature] });
    expect(rows(render(fake, "d1"))).toEqual([]);
  });

  // --- the rows that are not numbers ---------------------------------------
  //
  // Every fact about a feature that is a CHOICE used to be settable once, at
  // the moment the feature was made, and never again: the panel could only
  // render numbers, so a texture created as a knurl stayed a knurl and an
  // extrude's boolean was whatever the tool had decided.

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

  it("puts the choices above the numbers they govern", () => {
    // A texture's pattern decides whether Angle and Seed are there at all, so a
    // reader who met the numbers first would be reading upward.
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "knurl", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    const l = labels(render(fake, "t1"));
    expect(l.indexOf("Pattern")).toBe(0);
    expect(l.indexOf("Pattern")).toBeLessThan(l.indexOf("Depth"));
  });

  it("gives a switch to a field that is on or off", async () => {
    const fake = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "image", depth: 0.4, scale: 2 } as unknown as Feature],
    });
    const w = render(fake, "t1");
    expect(rows(w)).toContainEqual(["Invert heights", "", "false"]);
    const box = w.findAll(".param-row").find((r) => r.find("label").text() === "Invert heights")!
      .find("input[type=checkbox]");
    (box.element as HTMLInputElement).checked = true;
    await box.trigger("change");
    expect(fake.updates).toEqual([{ id: "t1", patch: { invert: true } }]);
  });

  it("hides a row the chosen pattern will never read", () => {
    // The defect this rule exists for: the panel offered Seed and Angle on every
    // texture. A knurl reads no seed — the sidecar ignores it — so turning that
    // row did nothing and nothing said why.
    const knurl = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "knurl", depth: 0.4, scale: 2, seed: 1, angle: 0 } as unknown as Feature],
    });
    const l = labels(render(knurl, "t1"));
    expect(l).toContain("Angle");
    expect(l).not.toContain("Seed");

    const noise = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "noise", depth: 0.4, scale: 2, seed: 1, angle: 0 } as unknown as Feature],
    });
    const n = labels(render(noise, "t1"));
    expect(n).toContain("Seed");
    expect(n).not.toContain("Angle");
  });

  it("renames the shape slider to what it currently does", () => {
    // The same number is a flat LAND width on a faceted surface and a crispness
    // on a smooth one. Calling both "Sharpness" describes neither.
    const facet = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "knurl", profile: "facet", depth: 0.4, scale: 2, sharpness: 0.5 } as unknown as Feature],
    });
    expect(labels(render(facet, "t1"))).toContain("Land");
    const round = makeEngine({
      parameters: {},
      features: [{ id: "t1", type: "texture", kind: "knurl", profile: "round", depth: 0.4, scale: 2, sharpness: 0.5 } as unknown as Feature],
    });
    expect(labels(render(round, "t1"))).toContain("Sharp");
  });
});
