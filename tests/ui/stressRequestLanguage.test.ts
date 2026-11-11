// Why a Stress setup cannot run reads in the picked language; the request's English message stays as it was.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t, tEnglish } from "../../src/i18n";
import {
  CUSTOM_MATERIAL,
  buildStressRequest,
  newLoad,
  newSetup,
  newSupport,
  type StressFaceSet,
  type StressSetup,
} from "../../src/ui/stress";
import { sentence } from "../../src/ui/stressWarnings";
import type { Selector, StressSpot, Vec3 } from "../../src/types";
import { englishLeft } from "../i18n/englishLeft";

afterEach(() => setLanguage("system"));

const sel = (x: number, y: number, z: number): Selector => ({
  kind: "face",
  by: "nearest",
  point: [x, y, z],
  body: "b4",
});

function faces(n: Vec3, extra: Partial<StressFaceSet> = {}, area = 42.5): StressFaceSet {
  return {
    selectors: [sel(12.5, -7.25, 31.4)],
    faceIds: [17],
    normalSum: [n[0] * area, n[1] * area, n[2] * area],
    area,
    ...extra,
  };
}

const spot = (normal?: Vec3, radius = 2.4): StressSpot => ({
  at: [-3.75, 18.2, 6.05],
  radius,
  ...(normal ? { normal } : {}),
});
const SLANT: Vec3 = [0.36, -0.48, 0.8];

function ready(): StressSetup {
  const s = newSetup("b4");
  s.supports[0]!.faces = faces([-0.6, 0, -0.8]);
  s.loads[0]!.faces = faces(SLANT);
  return s;
}

function twoLoads(change: (s: StressSetup) => void): StressSetup {
  const s = ready();
  s.loads.push({ ...newLoad(2), faces: faces([0.8, 0.6, 0]) });
  change(s);
  return s;
}

// One setup per refusal, with the English message the panel had before it was a line.
const CASES: [string, () => StressSetup, string][] = [
  ["noBody", () => ({ ...ready(), body: null }), "pick the body to analyse"],
  ["noSupport", () => ({ ...ready(), supports: [] }), "add a support"],
  [
    "noFaces, one support",
    () => ({ ...ready(), supports: [newSupport(1)] }),
    "the support has no faces yet, place it on the body or use selected faces",
  ],
  [
    "noFaces, support 2 of 2",
    () => {
      const s = ready();
      s.supports.push(newSupport(2, "pinned"));
      return s;
    },
    "support 2 has no faces yet, place it on the body or use selected faces",
  ],
  [
    "missingFaces, 1",
    () => twoLoads((s) => (s.loads[1]!.faces = faces([0.8, 0.6, 0], { missing: 1 }))),
    "a face of load 2 is not found on the current model, set the faces again",
  ],
  [
    "missingFaces, 3",
    () => twoLoads((s) => (s.loads[0]!.faces = faces(SLANT, { missing: 3 }))),
    "3 faces of load 1 are not found on the current model, set the faces again",
  ],
  [
    "spotRadius",
    () => {
      const s = ready();
      s.supports[0]!.spots = [spot(SLANT, 0)];
      return s;
    },
    "a spot of the support needs a radius above 0",
  ],
  [
    "spotNotFixed",
    () => {
      const s = ready();
      s.supports.push({ ...newSupport(2, "slider"), faces: faces([0, 1, 0]), spots: [spot(SLANT)] });
      return s;
    },
    "support 2 is slider but has a spot, and a spot holds every way, so make it fixed or remove the spot",
  ],
  ["noLoad", () => ({ ...ready(), loads: [] }), "add a load, or turn on Own weight"],
  [
    "noPressure",
    () => twoLoads((s) => Object.assign(s.loads[1]!, { kind: "pressure", pressure: 0 })),
    "load 2 needs a pressure",
  ],
  ["noForce", () => twoLoads((s) => (s.loads[0]!.force = 0)), "load 1 needs a force"],
  [
    "dirUnshown",
    () => {
      const s = ready();
      s.loads[0]!.faces = faces(SLANT, { selectors: [sel(12.5, -7.25, 31.4), sel(-4, 9.5, 2.25)], faceIds: [17] });
      return s;
    },
    'the load: one of its faces is not shown in the view, so "into the face" cannot be worked out; set the faces again, or pick an axis or a custom vector',
  ],
  [
    "dirSpot",
    () => twoLoads((s) => (s.loads[1]!.spots = [spot()])),
    'load 2: one of its spots has no direction of its own, so "into the face" cannot be worked out; place the spot again, or pick an axis or a custom vector',
  ],
  [
    "dirMixed",
    () => {
      const s = ready();
      s.loads[0]!.faces = faces([0.05, -0.02, 0.01]);
      return s;
    },
    'the load: its faces point different ways, so "into the face" has no single direction; pick an axis, a custom vector or a pressure',
  ],
  [
    "dirZero",
    () => twoLoads((s) => Object.assign(s.loads[1]!, { direction: "custom", custom: [0, 0, 0] })),
    "load 2: the custom direction is zero",
  ],
  [
    "modulus",
    () => ({ ...ready(), material: CUSTOM_MATERIAL, custom: { E: -3, nu: 0.3, yield: 40, density: 1.2 } }),
    "the custom material needs a modulus E above 0",
  ],
  [
    "poisson",
    () => ({ ...ready(), material: CUSTOM_MATERIAL, custom: { E: 2300, nu: 0.5, yield: 40, density: 1.2 } }),
    "Poisson's ratio must be from 0 to below 0.5",
  ],
  [
    "yield",
    () => ({ ...ready(), material: CUSTOM_MATERIAL, custom: { E: 2300, nu: 0.35, yield: 0, density: 1.2 } }),
    "the custom material needs a yield strength above 0",
  ],
  [
    "density",
    () => ({
      ...ready(),
      material: CUSTOM_MATERIAL,
      gravity: { on: true, direction: "-Y" },
      custom: { E: 2300, nu: 0.35, yield: 40, density: 0 },
    }),
    "own weight needs the material's density in g/cm3",
  ],
  ["material", () => ({ ...ready(), material: "Walnut 7" }), "unknown material Walnut 7"],
];

const refusalOf = (make: () => StressSetup) => {
  const r = buildStressRequest(make());
  if (r.ok) throw new Error("the setup ran");
  return r;
};

describe("a setup that cannot run", () => {
  it.each(CASES)("%s keeps its English message and shows it as the en line", (_n, make, english) => {
    const r = refusalOf(make);
    expect(r.message).toBe(english);
    expect(tEnglish(r.key, r.args)).toBe(sentence(english));
  });

  it.each(["de", "fr", "es", "ja", "zh-CN"] as const)("%s shows every refusal with no English left", async (code) => {
    const shown = async (lang: string) => {
      await setLanguage(lang);
      return CASES.map(([, make]) => {
        const r = refusalOf(make);
        return t(r.key, r.args);
      });
    };
    const english = await shown("en");
    const said = await shown(code);
    // Shared words, and the material name, which is data.
    const allow = [
      ...{
        de: ["radius"],
        fr: ["face", "faces", "force", "direction"],
        es: ["vector", "material"],
        ja: [],
        "zh-CN": [],
      }[code],
      "walnut",
      "poisson",
    ];
    said.forEach((text, i) => {
      expect(text).not.toBe(english[i]);
      expect(text).not.toMatch(/[{}]/);
      expect(englishLeft(text, english[i]!, allow)).toEqual([]);
    });
  });

  it("names the row and counts the faces in German and Japanese", async () => {
    const shown = (name: string) => {
      const r = refusalOf(CASES.find(([n]) => n === name)![1]);
      return t(r.key, r.args);
    };
    await setLanguage("de");
    expect(
      ["noFaces, one support", "noFaces, support 2 of 2", "missingFaces, 1", "missingFaces, 3"].map(shown),
    ).toEqual([
      "Die Halterung hat noch keine Flächen. Setzen Sie sie auf den Körper oder verwenden Sie die ausgewählten Flächen.",
      "Halterung 2 hat noch keine Flächen. Setzen Sie sie auf den Körper oder verwenden Sie die ausgewählten Flächen.",
      "Eine Fläche von Last 2 fehlt im aktuellen Modell. Legen Sie die Flächen neu fest.",
      "3 Flächen von Last 1 fehlen im aktuellen Modell. Legen Sie die Flächen neu fest.",
    ]);
    expect(shown("poisson")).toContain("unter 0,5");
    expect(shown("material")).toContain("Walnut 7");
    expect(shown("spotNotFixed")).toContain("Halterung 2 ist gleitend");
    await setLanguage("ja");
    expect(shown("noFaces, support 2 of 2")).toMatch(/^支持 2には/);
    expect(shown("missingFaces, 3")).toContain("荷重 1の面のうち 3 面");
    expect(shown("poisson")).toContain("0.5 未満");
  });
});
