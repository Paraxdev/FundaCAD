// Describe model as text: the dialog's sections and the Copy as text string are built from the same description.
import { afterEach, describe, expect, it } from "vitest";
import { describeModel, descriptionText, selectionSpeech, type ModelFacts } from "../../src/ui/modelDescription";
import { setLanguage } from "../../src/i18n";
import { setUnit } from "../../src/ui/units";

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

const facts = (over: Partial<ModelFacts> = {}): ModelFacts => ({
  file: "Box with a lid",
  bodies: [
    {
      name: "Box",
      box: { min: [-20, -15, 0], max: [20, 15, 20] },
      volume: 9000,
      visible: true,
      material: null,
      fault: null,
    },
    {
      name: "Lid",
      box: { min: [-20, -15, 25], max: [20, 15, 28.5] },
      volume: 4200.25,
      visible: false,
      material: "Brass",
      fault: null,
    },
  ],
  features: [
    { name: "Sketch 1", state: "" },
    { name: "Extrude 1", state: "" },
    { name: "Fillet 1", state: "error: the radius is larger than the edge" },
    { name: "Shell 1", state: "rolled back" },
  ],
  view: { view: "iso", ortho: false, section: false },
  selection: { bodies: ["Box"], faces: 0, edges: 0 },
  ...over,
});

describe("describeModel", () => {
  it("has an Overview, Bodies, Features and View section in that order", () => {
    expect(describeModel(facts()).sections.map((s) => s.heading)).toEqual(["Overview", "Bodies", "Features", "View"]);
  });

  it("lists every body with its size, its center and its volume in the document unit", () => {
    const bodies = describeModel(facts()).sections[1]!;
    expect(bodies.ordered).toBe(false);
    expect(bodies.items).toEqual([
      "Box: 40 × 30 × 20 mm, center at 0, 0, 10 mm, volume 9000 mm³",
      "Lid: 40 × 30 × 3.5 mm, center at 0, 0, 26.75 mm, volume 4200.25 mm³, Brass, hidden",
    ]);
  });

  it("follows the unit setting", () => {
    setUnit("cm");
    expect(describeModel(facts()).sections[1]!.items[0]).toBe("Box: 4 × 3 × 2 cm, center at 0, 0, 1 cm, volume 9 cm³");
  });

  it("leaves the volume out of a body that is not a sound solid, and says its fault", () => {
    const body = { ...facts().bodies[0]!, volume: null, fault: "open shell" };
    expect(describeModel(facts({ bodies: [body] })).sections[1]!.items).toEqual([
      "Box: 40 × 30 × 20 mm, center at 0, 0, 10 mm, fault: open shell",
    ]);
  });

  it("says a body with no shape yet has no size", () => {
    const body = { ...facts().bodies[0]!, box: null, volume: null };
    expect(describeModel(facts({ bodies: [body] })).sections[1]!.items).toEqual(["Box: not built yet"]);
  });

  it("numbers the features in timeline order with their state", () => {
    const features = describeModel(facts()).sections[2]!;
    expect(features.ordered).toBe(true);
    expect(features.items).toEqual([
      "Sketch 1",
      "Extrude 1",
      "Fillet 1, failed: the radius is larger than the edge",
      "Shell 1, rolled back",
    ]);
  });

  it("says the counts, the file and how sizes read in the overview", () => {
    expect(describeModel(facts()).sections[0]!.items).toEqual([
      "File: Box with a lid",
      "2 bodies (1 hidden), 4 features (1 failed)",
      "Sizes are X by Y by Z in mm, Z points up",
    ]);
  });

  it("says the view, the section and the selection", () => {
    expect(describeModel(facts()).sections[3]!.items).toEqual([
      "Isometric view, perspective",
      "Section off",
      "Selected: Box",
    ]);
  });

  it("has a line for an empty model and an empty timeline", () => {
    const d = describeModel(facts({ bodies: [], features: [] }));
    expect(d.sections[1]!.items).toEqual(["No bodies"]);
    expect(d.sections[2]!.items).toEqual(["No features"]);
  });
});

describe("descriptionText", () => {
  it("gives the same lines as the dialog, headings over their lists", () => {
    const d = describeModel(facts());
    const text = descriptionText(d);
    expect(text.split("\n").slice(0, 7)).toEqual([
      "Model description",
      "",
      "Overview",
      "- File: Box with a lid",
      "- 2 bodies (1 hidden), 4 features (1 failed)",
      "- Sizes are X by Y by Z in mm, Z points up",
      "",
    ]);
    expect(text).toContain(
      "Features\n1. Sketch 1\n2. Extrude 1\n3. Fillet 1, failed: the radius is larger than the edge\n",
    );
    for (const s of d.sections) for (const item of s.items) expect(text).toContain(item);
    expect(text.endsWith("- Selected: Box\n")).toBe(true);
  });
});

describe("selectionSpeech", () => {
  it("says nothing is selected", () => {
    expect(selectionSpeech([])).toBe("Nothing selected");
  });

  it("says each part with its size and center, the unit in words", () => {
    expect(
      selectionSpeech([
        { what: "Box", box: { min: [-20, -15, 0], max: [20, 15, 20] } },
        { what: "2 faces on Lid", box: { min: [-20, -15, 28.5], max: [20, 15, 28.5] } },
      ]),
    ).toBe(
      "Box, 40 by 30 by 20 millimetres, center at 0, 0, 10 millimetres. " +
        "2 faces on Lid, 40 by 30 by 0 millimetres, center at 0, 0, 28.5 millimetres",
    );
  });

  it("says minus for a negative coordinate and leaves out a size it has not got", () => {
    expect(selectionSpeech([{ what: "1 edge", box: { min: [-12, -4, 0], max: [-8, -4, 0] } }])).toBe(
      "1 edge, 4 by 0 by 0 millimetres, center at minus 10, minus 4, 0 millimetres",
    );
    expect(selectionSpeech([{ what: "Box", box: null }])).toBe("Box");
  });
});

describe("the description in a comma language", () => {
  it("speaks a decimal comma and joins the center with semicolons", async () => {
    await setLanguage("de");
    expect(
      selectionSpeech([
        { what: "Lid", box: { min: [-12.5, -4, 25], max: [7.5, 3.25, 28.5] } },
        { what: "1 edge", box: { min: [-12, -4, 0], max: [-8, -4, 0] } },
      ]),
    ).toBe(
      "Lid, 20 by 7,25 by 3,5 millimetres, center at minus 2,5; minus 0,375; 26,75 millimetres. " +
        "1 edge, 4 by 0 by 0 millimetres, center at minus 10; minus 4; 0 millimetres",
    );
  });

  it("writes the body lines with a comma mark, semicolons only inside the center", async () => {
    await setLanguage("de");
    const lines = describeModel(facts()).sections.flatMap((s) => s.items);
    expect(lines.filter((l) => l.startsWith("Lid:"))).toEqual([
      "Lid: 40 × 30 × 3,5 mm, center at 0; 0; 26,75 mm, volume 4200,25 mm³, Brass, hidden",
    ]);
  });

  it("keeps the point and the comma in English", () => {
    const lines = describeModel(facts()).sections.flatMap((s) => s.items);
    expect(lines.filter((l) => l.startsWith("Lid:"))).toEqual([
      "Lid: 40 × 30 × 3.5 mm, center at 0, 0, 26.75 mm, volume 4200.25 mm³, Brass, hidden",
    ]);
  });
});
