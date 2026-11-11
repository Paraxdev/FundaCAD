import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { treePickRefusal, type TreePick, type TreePickWant } from "../../src/ui/treePick";

afterEach(async () => {
  await setLanguage("system");
});

const LANGUAGES = ["en", "de", "fr", "es", "ja", "zh-CN"] as const;

const WANTS: TreePickWant[] = [
  "face",
  "flatFace",
  "roundFace",
  "modelFlatFace",
  "edge",
  "faceOrEdge",
  "axisFaceOrEdge",
  "planeOrFace",
  "planeOrFlatFace",
  "bodyPlaneOrFlatFace",
  "body",
  "oneBody",
  "datumPoint",
  "sketchProfile",
  "axisOrStraightEdge",
];

const plane = { origin: [3, -2, 5], u: [1, 0, 0], v: [0, 1, 0] } as never;
const ROWS: TreePick[] = [
  { kind: "basePlane", plane },
  { kind: "datumPlane", id: "p7", def: {} as never },
  { kind: "datumPoint", id: "pt3", point: [4, 5, -6] },
  { kind: "datumAxis", id: "ax2" } as never,
  { kind: "body", id: "body3" } as never,
  { kind: "bodies" } as never,
  { kind: "sketch", id: "s4" } as never,
  { kind: "feature", id: "f9" } as never,
  { kind: "face", faceId: 17 } as never,
  { kind: "edge", edge: {} as never },
];

describe("a refused list row in the chosen language", () => {
  it("keeps the English wording", () => {
    expect(treePickRefusal(ROWS[0]!, "oneBody")).toBe("That row is a base plane, this step needs one body");
    expect(treePickRefusal(ROWS[7]!, "planeOrFace")).toBe("That row is a feature, this step needs a plane or a face");
    expect(treePickRefusal(ROWS[9]!, "axisOrStraightEdge")).toBe("That row is an edge, this step needs an axis or a straight edge");
  });

  it("puts the German accusative on the wanted noun", async () => {
    await setLanguage("de");
    const line = treePickRefusal(ROWS[0]!, "oneBody");
    expect(line).toContain("Basisebene");
    expect(line).toContain("einen Körper");
    expect(treePickRefusal(ROWS[7]!, "body")).toContain("ein Element");
  });

  it("names a body row and a face in Japanese", async () => {
    await setLanguage("ja");
    const line = treePickRefusal(ROWS[4]!, "face");
    expect(line).toContain("ボディ");
    expect(line).toContain("面");
  });

  it.each(LANGUAGES)("renders every want as its own line in %s", async (lang) => {
    await setLanguage(lang);
    const lines = WANTS.map((w) => treePickRefusal(ROWS[3]!, w));
    expect(new Set(lines).size).toBe(15);
    for (const line of lines) expect(line).not.toMatch(/[{}]/);
  });

  it.each(LANGUAGES)("renders every row kind as its own line in %s", async (lang) => {
    await setLanguage(lang);
    const lines = ROWS.map((r) => treePickRefusal(r, "face"));
    expect(new Set(lines).size).toBe(10);
    for (const line of lines) expect(line).not.toMatch(/[{}]/);
  });

  it("refuses a phrase in place of a kind at compile time", () => {
    // @ts-expect-error a want is a kind id, never an English phrase
    treePickRefusal(ROWS[0]!, "a face");
  });
});
