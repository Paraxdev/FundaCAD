import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { describePick, type EdgeFacts, type FaceFacts, type PlaneFacts } from "../../src/ui/describePick";

afterEach(() => setLanguage("system"));

const flat: FaceFacts = { kind: "face", number: 3, surface: "plane", normal: [0.2, -0.3, 0.93], body: "Platte" };
const level: FaceFacts = { ...flat, normal: [0, 0, 1] };
const base: PlaneFacts = { kind: "plane", name: "XY", origin: true, normal: [0.2, -0.3, 0.93] };
const datum: PlaneFacts = { kind: "plane", name: "Mittelebene", origin: false, normal: [0, 0, 1] };

describe("a lone pick named in the chosen language", () => {
  it("names a flat face, slanted and level, in de and ja", async () => {
    await setLanguage("de");
    expect([flat, level].map((f) => describePick(f).label)).toEqual(["Ebene Fläche 3", "Ebene Fläche 3"]);
    expect(describePick(flat).readout.startsWith("1 Fläche · eben")).toBe(true);
    expect(describePick(flat).spoken.startsWith("Ebene Fläche 3, ")).toBe(true);
    await setLanguage("ja");
    expect(describePick(flat).label).toBe("平面 3");
    expect(describePick(flat).readout.startsWith("1 面 · 平面")).toBe(true);
    expect(describePick(flat).spoken.startsWith("平面 3、")).toBe(true);
  });

  it("falls to the other option for an unknown face and a typed edge, each number", async () => {
    const unknown = { kind: "face", number: 4, surface: "other" } as unknown as FaceFacts;
    const hole: FaceFacts = { kind: "face", number: 11, surface: "cylinder", full: true, concave: true };
    const round: EdgeFacts = { kind: "edge", number: 7, curve: "arc", length: 12.5 };
    const line: EdgeFacts = { kind: "edge", number: 2, curve: "line", length: 40.1 };
    expect([unknown, hole, round, line].map((f) => describePick(f).label)).toEqual([
      "Face 4",
      "Hole 11",
      "Round edge 7",
      "Straight edge 2",
    ]);
    expect(describePick(unknown).readout).toBe("1 face");
    await setLanguage("de");
    expect([unknown, hole, round, line].map((f) => describePick(f).label)).toEqual([
      "Fläche 4",
      "Bohrung 11",
      "Runde Kante 7",
      "Gerade Kante 2",
    ]);
    expect(describePick(round).readout.startsWith("1 Kante · rund · ")).toBe(true);
  });

  it("names a base plane and a datum plane, the typed name kept", async () => {
    await setLanguage("de");
    expect(describePick(base).label).toBe("XY-Ebene");
    expect(describePick(base).hint).toBe("Ursprung");
    expect(describePick(datum).label).toBe("Mittelebene");
    expect(describePick(datum).hint).toBe("Bezugsebene");
    expect(describePick(datum).spoken.endsWith(". Mit der Eingabetaste starten Sie eine Skizze")).toBe(true);
    await setLanguage("ja");
    expect(describePick(base).label).toBe("XY 平面");
    expect(describePick(datum).label).toBe("Mittelebene");
  });

  it("aloud is the readout in words, joined with the language's comma", async () => {
    const cases = [
      ["en", ", ", "XY plane, origin, tilted 21 degrees from up"],
      ["de", ", ", "XY-Ebene, Ursprung, um 21 Grad gegen oben geneigt"],
      ["ja", "、", "XY 平面、原点、上から21度傾斜"],
    ] as const;
    for (const [lang, join, expected] of cases) {
      await setLanguage(lang);
      expect(describePick(base).aloud).toBe(expected);
      expect(describePick(base).readout).toContain("°");
      expect(describePick(base).aloud).not.toMatch(/[°·⌀²]/);
      expect(describePick(datum).aloud.split(join)[0]).toBe("Mittelebene");
    }
  });

  it("does not leak the first language into the second pick", async () => {
    await setLanguage("de");
    const de = describePick(flat);
    await setLanguage("en");
    const en = describePick({ ...flat, number: 9 });
    expect(en.label).toBe("Flat face 9");
    expect(en.readout.startsWith("1 face · flat")).toBe(true);
    expect(de.label).toBe("Ebene Fläche 3");
  });
});

describe("the facts of a pick, on screen and aloud", () => {
  const plate: FaceFacts = {
    kind: "face",
    number: 3,
    surface: "plane",
    normal: [0.2, -0.3, 0.93],
    size: [20.5, 31],
    area: 635.5,
    centroid: [14.5, -3.25, 7.25],
    owner: "Extrude 2",
    body: "Platte",
    pieces: 3,
  };
  const level: FaceFacts = { ...plate, normal: [0, 0, 1], pieces: 1 };
  const tube: FaceFacts = { kind: "face", number: 5, surface: "torus", radius: 3.5, body: "Ring" };
  const bore: FaceFacts = {
    kind: "face",
    number: 8,
    surface: "cylinder",
    full: true,
    concave: true,
    radius: 5.25,
    axis: [0.3, 0.1, 0.95],
  };
  const between: EdgeFacts = { kind: "edge", number: 6, curve: "line", length: 12.5, faces: [2, 5, 9] };
  const onOne: EdgeFacts = { ...between, faces: [4] };
  const glyph = /[°·⌀²]|R\d/;

  it("reads every fact in de, the screen with glyphs and the voice with words", async () => {
    await setLanguage("de");
    const w = describePick(plate);
    expect(w.readout).toContain("°");
    expect(w.spoken).toContain("Grad");
    expect(w.spoken).toContain("in 3 Teilen");
    expect(w.spoken).not.toContain("Höhe");
    expect(describePick(level).spoken).toContain("in Höhe 7,25");
    expect(w.spoken).toContain("aus Extrude 2");
    expect(w.spoken).toContain("Platte");
    expect(w.aloud).not.toMatch(glyph);
    expect(w.spoken).not.toMatch(glyph);
    expect(describePick(level).readout).not.toContain("in 1 Teil");
    expect(describePick(level).spoken).not.toContain("Teil");
    const hole = describePick(bore);
    expect(hole.readout).toContain("⌀");
    expect(hole.spoken).not.toMatch(glyph);
    expect(hole.spoken).toContain("Durchmesser");
    expect(hole.spoken).toContain("Achse");
    expect(describePick(tube).spoken).toContain("Rohrdurchmesser");
    expect(describePick(tube).readout).toContain("Rohr ⌀");
  });

  it("lists an edge's faces with the language's last joiner", async () => {
    await setLanguage("de");
    expect(describePick(between).spoken).toContain("zwischen Fläche 2, Fläche 5 und Fläche 9");
    expect(describePick(between).hint).toContain("Flächen 2, 5 und 9");
    expect(describePick(onOne).spoken).toContain("auf Fläche 4");
    await setLanguage("ja");
    expect(describePick(between).spoken).toContain("面 2、面 5と面 9の間");
    expect(describePick(onOne).spoken).toContain("面 4 上");
    await setLanguage("en");
    expect(describePick(between).spoken).toContain("between face 2, face 5 and face 9");
    expect(describePick(between).hint).toBe("12.5 mm, faces 2, 5 and 9");
  });

  it("keeps the English words of a tilted face, whole", () => {
    const w = describePick({
      kind: "face",
      number: 3,
      surface: "plane",
      normal: plate.normal!,
      size: plate.size!,
      area: 635.5,
    });
    expect(w.readout).toBe("1 face · flat · 20.5 by 31 mm · tilted 21° from up");
    expect(w.spoken).toBe("Flat face 3, 20.5 by 31 millimetres, 635.5 square millimetres, tilted 21 degrees from up");
  });

  it("renders every language with no raw braces and no glyph in speech", async () => {
    for (const lang of ["en", "de", "fr", "es", "ja", "zh-CN"] as const) {
      await setLanguage(lang);
      for (const f of [plate, level, tube, bore, between, onOne]) {
        const w = describePick(f);
        for (const text of [w.readout, w.hint, w.spoken, w.aloud]) expect(text).not.toMatch(/[{}]/);
        expect(w.spoken).not.toMatch(glyph);
        expect(w.aloud).not.toMatch(glyph);
      }
    }
  });

  it("makes both channels from one key, the readout differs only by its glyph", async () => {
    await setLanguage("de");
    expect(t("pick.fact.diameter", { as: "readout", tube: "no", size: "10,5 mm" })).toBe("⌀10,5 mm");
    expect(t("pick.fact.diameter", { as: "spoken", tube: "no", size: "10,5 Millimeter" })).toBe(
      "Durchmesser 10,5 Millimeter",
    );
    expect(describePick(bore).readout).toContain(
      t("pick.fact.diameter", { as: "readout", tube: "no", size: "10,5 mm" }),
    );
    expect(describePick(bore).spoken).toContain("Durchmesser 10,5 Millimeter");
  });

  it("the speech of one pick does not leak into the next language", async () => {
    await setLanguage("de");
    const de = describePick(plate).spoken;
    await setLanguage("ja");
    const ja = describePick(plate).spoken;
    expect(ja).not.toBe(de);
    expect(ja).not.toContain("Grad");
  });
});
