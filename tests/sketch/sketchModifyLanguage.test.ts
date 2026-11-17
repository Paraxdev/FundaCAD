// The modify, pattern and project flows, the constraint names and the names built from them read in the chosen
// language, are read when they are shown so they follow a switch, and still read exactly as before in English.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { constraintFace } from "../../src/sketch/glyphs";
import {
  constraintDimName,
  distinctNames,
  entityDimName,
  entityLabeller,
  relationName,
} from "../../src/sketch/sketchNames";
import { dofSummary } from "../../src/sketch/relations";
import { PROJECT_CHIPS } from "../../src/sketch/projectPanel";
import { KEY_PROMPTS } from "../../src/sketch/keyDrawFlow";
import { projectedFixedMsg } from "../../src/sketch/modify";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

afterEach(() => setLanguage("system"));

const ents: ResolvedEntity[] = [
  { type: "line", id: "l1", x1: 0, y1: 0, x2: 4, y2: 0 },
  { type: "line", id: "l2", x1: 0, y1: 2, x2: 4, y2: 2 },
  { type: "circle", id: "c1", radius: 2, x: 8, y: 9 },
];
const perpendicular = { type: "perpendicular", l1: "l1", l2: "l2" } as SketchConstraint;
const equalRadius = { type: "equalRadius", a: "c1", b: "c1" } as SketchConstraint;

const named = () => {
  const label = entityLabeller(ents);
  const subjects = ents.map((e) => label(e.id)!);
  return {
    subjects,
    face: constraintFace(perpendicular).name,
    between: constraintDimName(t("sketch.dim.distance"), subjects),
    of: entityDimName(t("sketch.dim.diameter"), subjects[2]!),
  };
};
const chips = () => PROJECT_CHIPS.map((c) => c.label);

describe("the modify and pattern flows", () => {
  it("read in German and Japanese", async () => {
    await setLanguage("de");
    expect(t("sketch.modify.selectFirst", { tool: "move" })).toBe(
      "Wählen Sie zuerst etwas aus, dann verwenden Sie Verschieben oder Kopieren",
    );
    expect(t("sketch.offset.pick")).toBe(
      "Versetzen: Klicken Sie auf eine Kurve oder Flächenkante, die versetzt werden soll",
    );
    expect(projectedFixedMsg()).toBe("Projizierte Geometrie ist fixiert, mit „Verknüpfung lösen“ wird sie bearbeitbar");
    expect(t("sketch.pattern.rings")).toBe("Ringe");
    await setLanguage("ja");
    expect(t("sketch.modify.selectFirst", { tool: "rotate" })).toBe("先に何かを選択してから、回転移動を使ってください");
    expect(t("sketch.offset.flip")).toBe("反転");
    expect(t("sketch.pattern.editTip")).toBe("パターンを編集");
  });

  it("say in English what the old text said", () => {
    expect((["move", "rotate", "scale"] as const).map((tool) => t("sketch.modify.selectFirst", { tool }))).toEqual([
      "Select something first, then use Move or Copy",
      "Select something first, then use Rotate",
      "Select something first, then use Scale",
    ]);
    expect(projectedFixedMsg()).toBe("Projected geometry is fixed, Break Link to edit it");
    expect([1, 3].map((n) => t("sketch.project.skipped", { n }))).toEqual([
      "1 already-projected edge skipped",
      "3 already-projected edges skipped",
    ]);
    expect(
      [2, 3].map((d) => t("sketch.spline.degree", { degree: d, poles: d + 1, short: d > 2 ? "yes" : "no" })),
    ).toEqual(["Degree 2", "Degree 3, needs 4 control points"]);
  });
});

describe("the constraint names and the names built from them", () => {
  it("read in German and Japanese", async () => {
    await setLanguage("de");
    expect(named()).toEqual({
      subjects: ["Linie 1", "Linie 2", "Kreis 1"],
      face: "Senkrecht",
      between: "Abstand zwischen Linie 1, Linie 2 und Kreis 1",
      of: "Durchmesser von Kreis 1",
    });
    expect(dofSummary(2, false)).toBe("2 Freiheitsgrade");
    await setLanguage("ja");
    expect(named()).toEqual({
      subjects: ["線 1", "線 2", "円 1"],
      face: "直交",
      between: "線 1、線 2と円 1の間の距離",
      of: "円 1の直径",
    });
    expect(constraintFace(equalRadius).name).toBe("等しい半径");
    expect(distinctNames(["線 1", "線 1"])).toEqual(["線 1、1 行目", "線 1、2 行目"]);
  });

  it("say in English what the old text said", () => {
    expect(named()).toEqual({
      subjects: ["Line 1", "Line 2", "Circle 1"],
      face: "Perpendicular",
      between: "Distance between Line 1, Line 2 and Circle 1",
      of: "Diameter of Circle 1",
    });
    expect(constraintDimName("Distance", ["Line 1", "Line 2"])).toBe("Distance between Line 1 and Line 2");
    expect([dofSummary(1, false), dofSummary(3, false), dofSummary(0, false), dofSummary(0, true)]).toEqual([
      "1 degree of freedom",
      "3 degrees of freedom",
      "Fully defined",
      "Conflicting constraints",
    ]);
    expect(distinctNames(["Line 1", "Line 1"])).toEqual(["Line 1, row 1", "Line 1, row 2"]);
    expect(
      relationName({ name: "Distance", value: "(12 mm)", detail: "Line 1 and Line 2", state: null, driven: true }),
    ).toBe("Distance 12 mm, Line 1 and Line 2, reference");
  });
});

describe("the project chips and the typed draw prompts", () => {
  it("follow a switch", async () => {
    expect(chips()).toEqual(["Edges & faces", "Sketch curves", "Body silhouette"]);
    expect(KEY_PROMPTS.movedBare).toBe("Arrows move · Enter places · Esc");
    await setLanguage("de");
    expect(chips()).toEqual(["Kanten und Flächen", "Skizzenkurven", "Körpersilhouette"]);
    expect(KEY_PROMPTS.moved).toBe("Pfeiltasten bewegen · Enter setzt · Tab nächster Fangpunkt · Esc");
    await setLanguage("ja");
    expect(chips()).toEqual(["エッジと面", "スケッチの曲線", "ボディのシルエット"]);
  });
});
