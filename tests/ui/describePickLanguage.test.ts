import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
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

  it("aloud is the readout with the language's join", async () => {
    for (const [lang, join] of [
      ["en", ", "],
      ["de", ", "],
      ["ja", "、"],
    ] as const) {
      await setLanguage(lang);
      for (const plane of [base, datum]) {
        const w = describePick(plane);
        expect(w.aloud).toBe(w.readout.replaceAll(" · ", join));
      }
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
