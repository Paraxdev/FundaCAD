// The Stress status lines, spoken announcements and row refusals, and the pins in the view, read in the picked language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setLanguage, tEnglish } from "../../src/i18n";
import { usePanelsStore } from "../../src/stores/panels";
import { resetTreePicks, routeTreeClick } from "../../src/ui/treePick";
import { weakSpotLabel } from "../../src/ui/stressVerdict";
import type { StressReply } from "../../src/geometry/client";
import { englishLeft } from "../i18n/englishLeft";
import { rig, reply } from "./stressPanelRig";

const spoken = vi.hoisted(() => [] as string[]);
vi.mock("../../src/ui/announce", () => ({ announce: (t: string) => spoken.push(t) }));

beforeEach(() => {
  setActivePinia(createPinia());
  resetTreePicks();
  spoken.length = 0;
});
afterEach(async () => {
  await setLanguage("system");
});

type Rig = ReturnType<typeof rig>;
type Scenario = (r?: Rig) => Promise<string> | string;

const FACE_B1 = { body: "b1", z: 5, n: 1 };
const peak = (over: Partial<StressReply>): StressReply => ({
  ...reply,
  maxVonMises: { value: 12.5, at: [0, 0, 0], face: 0 },
  ...over,
});

function setUp(r: Rig) {
  r.ui.showStress();
  r.select([1]);
  r.ui.setStressFacesFromSelection({ support: 1 });
  r.select([2]);
  r.ui.setStressFacesFromSelection({ load: 1 });
}

const lastStatus = (r: Rig) => r.statuses.at(-1)!;
const click = (faceId: number) => {
  const hints: string[] = [];
  const route = routeTreeClick({ kind: "face", faceId }, { busyHint: () => null, hint: (h) => hints.push(h) });
  return { route, hint: hints[0] ?? "" };
};

const SCENARIOS: Record<string, Scenario> = {
  needBody: () => {
    const r = rig({ hasBody: false });
    r.ui.showStress();
    return lastStatus(r);
  },
  noEngine: () => {
    const r = rig({ engine: false });
    r.ui.showStress();
    return lastStatus(r);
  },
  facesMissingOne: () => {
    const r = rig();
    setUp(r);
    r.rebuild({ 2: { body: "b1", z: 10, n: 1 } });
    return lastStatus(r);
  },
  facesMissingTwo: () => {
    const r = rig();
    setUp(r);
    r.rebuild({ 5: FACE_B1 });
    return lastStatus(r);
  },
  bodyGoneKept: () => {
    const r = rig();
    setUp(r);
    r.rebuild({ 9: { body: "b2", z: 0, n: 1 } });
    return lastStatus(r);
  },
  selectFaces: () => {
    const r = rig();
    r.ui.showStress();
    r.select([]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    return lastStatus(r);
  },
  oneBody: () => {
    const r = rig();
    r.ui.showStress();
    r.select([1, 9]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    return lastStatus(r);
  },
  selectedOtherBody: () => {
    const r = rig();
    setUp(r);
    r.select([9]);
    r.ui.setStressFacesFromSelection({ load: 1 });
    return lastStatus(r);
  },
  bodyGone: () => {
    const r = rig();
    setUp(r);
    r.rebuild({ 9: { body: "b2", z: 0, n: 1 } });
    r.select([9]);
    r.ui.setStressFacesFromSelection({ load: 1 });
    return lastStatus(r);
  },
  runFirst: () => {
    const r = rig();
    setUp(r);
    r.ui.setStressProbe(true);
    return lastStatus(r);
  },
  probeStale: async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: peak({}) });
    await run;
    r.ui.setStressColours(false);
    r.editDoc();
    r.ui.setStressProbe(true);
    return lastStatus(r);
  },
  changedWhileRan: async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.editDoc();
    r.settle({ ok: true, result: peak({}) });
    await run;
    return lastStatus(r);
  },
  doneWithFactor: async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: peak({ safetyFactor: 4.25 }) });
    await run;
    return r.statuses.find((s) => /12[.,]5/.test(s))!;
  },
  doneNoFactor: async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: peak({ safetyFactor: null }) });
    await run;
    return r.statuses.find((s) => /12[.,]5/.test(s))!;
  },
  cancelled: async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: false, cancelled: true, message: "x" });
    await run;
    return lastStatus(r);
  },
  failed: async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: false, message: "Solver gave up at step 7" });
    await run;
    return lastStatus(r);
  },
  nothingToUndo: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.undoStress();
    return lastStatus(r);
  },
  nothingToRedo: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.redoStress();
    return lastStatus(r);
  },
  pickFace: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.placeStressSpot({ load: 1 });
    return spoken.at(-1)!;
  },
  pickFaceSupport: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.placeStressSpot({ support: 1 });
    return spoken.at(-1)!;
  },
  faceTakenOne: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.placeStressSpot({ support: 1 });
    click(1);
    return spoken.at(-1)!;
  },
  faceTakenTwo: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.placeStressSpot({ load: 1 });
    click(1);
    r.ui.placeStressSpot({ load: 1 });
    click(2);
    return spoken.at(-1)!;
  },
  refuseNoBody: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.placeStressSpot({ support: 1 });
    return click(77).hint;
  },
  refuseOtherBody: () => {
    const r = rig();
    setUp(r);
    r.ui.placeStressSpot({ load: 1 });
    return click(9).hint;
  },
  refuseBodyGone: () => {
    const r = rig();
    setUp(r);
    r.ui.placeStressSpot({ load: 1 });
    r.rebuild({ 9: { body: "b2", z: 0, n: 1 } });
    return click(9).hint;
  },
  refuseBuilding: () => {
    const r = rig();
    r.ui.showStress();
    r.viewport.faceSelectorOf = () => ({ kind: "face", by: "id", id: 1 }) as never;
    r.ui.placeStressSpot({ support: 1 });
    return click(1).hint;
  },
  refuseNotWaiting: () => {
    const r = rig();
    r.ui.showStress();
    r.ui.placeStressSpot({ support: 1 });
    usePanelsStore().setStressPlacing(null);
    return click(1).hint;
  },
};

async function under(lang: string, name: string): Promise<string> {
  await setLanguage(lang as never);
  setActivePinia(createPinia());
  resetTreePicks();
  spoken.length = 0;
  return SCENARIOS[name]!();
}

const PREFIX: Record<string, string> = { de: "Spannung:", ja: "応力:" };
const PREFIXED = [
  "needBody",
  "noEngine",
  "facesMissingOne",
  "facesMissingTwo",
  "bodyGoneKept",
  "selectFaces",
  "oneBody",
  "selectedOtherBody",
  "bodyGone",
  "runFirst",
  "probeStale",
  "changedWhileRan",
  "doneWithFactor",
  "doneNoFactor",
];
const ALL = Object.keys(SCENARIOS);
// The engine's own message passes through, and Engine is a German loanword.
const KEPT = ["engine", "solver", "gave", "step"];

describe("Stress status lines, announcements and row refusals", () => {
  it("English stays as it was", async () => {
    const got: Record<string, string> = {};
    for (const n of ALL) got[n] = await under("en", n);
    expect(got).toMatchObject({
      needBody: "Stress: create or import a body first",
      noEngine: "Stress: this geometry engine cannot run an analysis",
      facesMissingOne: "Stress: 1 face is not found on the current model, set the faces again",
      facesMissingTwo: "Stress: 2 faces are not found on the current model, set the faces again",
      selectFaces: "Stress: select one or more faces first",
      oneBody: "Stress: the selected faces must all be on one body",
      selectedOtherBody: "Stress: the selected faces are on another body than the one analysed",
      bodyGone: "Stress: the body analysed is not on the current model, pick another body first",
      runFirst: "Stress: run the analysis first, then probe its result",
      probeStale: "Stress: the model changed since the run, run the analysis again to probe it",
      changedWhileRan: "Stress: the model changed while it ran, run it again to see the colours",
      doneWithFactor: "Stress: peak 12.5 MPa, safety factor 4.25",
      doneNoFactor: "Stress: peak 12.5 MPa",
      cancelled: "Stress analysis cancelled",
      failed: "Stress analysis failed: Solver gave up at step 7.",
      nothingToUndo: "Nothing left to undo in Stress",
      nothingToRedo: "Nothing to redo in Stress",
      pickFace: "Pick a face for the load, Esc to stop",
      pickFaceSupport: "Pick a face for the support, Esc to stop",
      faceTakenOne: "The support has 1 face, Click faces again for another",
      faceTakenTwo: "The load has 2 faces, Click faces again for another",
      refuseNoBody: "That face is on no body",
      refuseOtherBody: "That face is on another body, pick a face of the body analysed",
      refuseBodyGone: "The body analysed is not on the current model, pick another body first",
      refuseBuilding: "The model is still building",
      refuseNotWaiting: "Stress is not waiting for a face",
    });
  });

  for (const lang of ["de", "ja"]) {
    it(`reads in ${lang} with no English left, the panel word first`, async () => {
      for (const name of ALL) {
        const text = await under(lang, name);
        const english = await under("en", name);
        expect(text, name).not.toBe(english);
        expect(englishLeft(text, english, ["MPa", ...KEPT]), name).toEqual([]);
        if (PREFIXED.includes(name)) expect(text.startsWith(PREFIX[lang]!), name).toBe(true);
      }
    });
  }

  it("spells the numbers with the language's mark and picks the plural form", async () => {
    expect(await under("de", "doneWithFactor")).toBe("Spannung: Spitze 12,5 MPa, Sicherheitsfaktor 4,25");
    expect(await under("de", "doneNoFactor")).toBe("Spannung: Spitze 12,5 MPa");
    expect(await under("ja", "doneWithFactor")).toBe("応力: 最大 12.5 MPa、安全率 4.25");
    expect(await under("de", "facesMissingOne")).toContain("1 Fläche wird");
    expect(await under("de", "facesMissingTwo")).toContain("2 Flächen werden");
    expect(await under("de", "faceTakenOne")).toContain("Die Halterung hat 1 Fläche,");
    expect(await under("de", "faceTakenTwo")).toContain("Die Last hat 2 Flächen,");
    expect(await under("de", "pickFaceSupport")).toBe("Wählen Sie eine Fläche für die Halterung, Esc zum Beenden");
    expect(await under("de", "failed")).toBe("Spannungsanalyse fehlgeschlagen: Solver gave up at step 7.");
  });

  it("has every key in the English catalog, so nothing falls back", () => {
    expect(tEnglish("stress.status.done", { peak: "1", factor: "no", sf: "" })).toBe("Stress: peak 1 MPa");
  });
});

describe("the pins in the view follow a language switch", () => {
  const bent: StressReply = {
    ...reply,
    safetyFactor: 3.32,
    maxVonMises: { value: 4.25, at: [0, 0, 0], face: 0 },
    surface: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], vonMises: [1.5, 4.25, 2] },
  };

  async function withPins(r: Rig) {
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: bent });
    await run;
    r.handlers().pinProbe({ tri: 0, weights: [0, 1, 0], point: [1, 0, 0] });
    r.handlers().pinProbe({ tri: 0, weights: [1, 0, 0], point: [0, 0, 0] });
  }

  it("hands the glyphs a German weak spot label and pins with the comma", async () => {
    const r = rig();
    await withPins(r);
    expect(r.pinLabels.at(-1)).toEqual(["4.25 MPa", "1.5 MPa"]);
    expect(r.weakSpots.at(-1)!.label).toBe(weakSpotLabel(3.32));
    const before = r.weakSpots.at(-1)!.label;
    await setLanguage("de");
    expect(r.weakSpots.at(-1)!.label).toBe(weakSpotLabel(3.32));
    expect(r.weakSpots.at(-1)!.label).not.toBe(before);
    expect(r.pinLabels.at(-1)).toEqual(["4,25 MPa", "1,5 MPa"]);
    expect(usePanelsStore().stress!.pins.map((p) => p.label)).toEqual(["4,25 MPa", "1,5 MPa"]);
    await setLanguage("en");
    expect(r.pinLabels.at(-1)).toEqual(["4.25 MPa", "1.5 MPa"]);
    expect(r.weakSpots.at(-1)!.label).toBe(before);
  });

  it("hands the glyphs nothing while Stress is closed or shows no result", async () => {
    const open = rig();
    open.ui.showStress();
    const calls = open.glyphCalls.length;
    const spots = open.weakSpots.length;
    await setLanguage("de");
    expect([open.glyphCalls.length, open.weakSpots.length]).toEqual([calls, spots]);

    const closed = rig();
    await withPins(closed);
    closed.ui.closeStress();
    const n = [closed.glyphCalls.length, closed.weakSpots.length, closed.pinLabels.length];
    await setLanguage("ja");
    expect([closed.glyphCalls.length, closed.weakSpots.length, closed.pinLabels.length]).toEqual(n);
  });

  it("a second session on another body keeps no pin or label of the first", async () => {
    const r = rig();
    await withPins(r);
    r.ui.closeStress();
    r.rebuild({ 1: { body: "b1", z: 0, n: -1 }, 9: { body: "b2", z: 0, n: 1 } });
    r.ui.showStress();
    r.ui.setStressBody("b2");
    const spots = r.weakSpots.length;
    const pins = r.pinLabels.length;
    await setLanguage("de");
    expect(r.weakSpots.slice(spots).filter(Boolean)).toEqual([]);
    expect(r.pinLabels.slice(pins).flat()).toEqual([]);
    expect(usePanelsStore().stress!.pins).toEqual([]);
  });
});
