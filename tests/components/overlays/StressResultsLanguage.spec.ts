// The Stress Results tab and its legend, with a result, the colours, a deformed shape and two probe pins on show.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressPanel from "../../../src/components/overlays/StressPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { StressReply } from "../../../src/geometry/client";
import { setLanguage } from "../../../src/i18n";
import { formatMessage, parseMessage, type MessageArgs } from "../../../src/i18n/format";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";
import es from "../../../src/i18n/locales/es.json";
import fr from "../../../src/i18n/locales/fr.json";
import ja from "../../../src/i18n/locales/ja.json";
import zh from "../../../src/i18n/locales/zh-CN.json";
import { usePanelsStore } from "../../../src/stores/panels";
import { formatStressResult, STRESS_RAMPS } from "../../../src/ui/stress";
import { englishLeft } from "../../i18n/englishLeft";

type Lines = Record<string, string>;

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

const engine = {
  store: {
    onBuild: (fn: () => void) => {
      fn();
      return () => {};
    },
  },
  ui: {
    panels: {
      stressBodies: () => [{ id: "b1", name: "Bracket" }],
      setStressLook: vi.fn(),
      runStress: vi.fn(),
    },
  },
} as unknown as Engine;

const reply: StressReply = {
  body: "b1",
  name: "Hook",
  material: { name: "PETG", E: 2100, nu: 0.38, yield: 50 },
  mesh: { nodes: 1300, elements: 5200, size: 2.2, minDihedral: 9.6 },
  maxVonMises: { value: 12.5, at: [12.5, -7.25, 31.4], face: 6 },
  maxDisplacement: { value: 0.0314, at: [-3.75, 18.2, 6.05], vector: [0.1, -0.2, -0.58] },
  safetyFactor: 2.43,
  applied: [0, -12.5, -20.5],
  reaction: [0, 12.5, 20.5],
};

type State = "shown" | "playing" | "modelChanged" | "setupChanged";

async function show(state: State = "shown") {
  const wrapper = mount(StressPanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  const p = usePanelsStore();
  p.showStress("b1");
  p.stressStarted();
  p.stressFinished({ result: formatStressResult(reply, "mm", ["fixed"]) });
  p.setStressColours(state === "modelChanged" ? "none" : "shown");
  p.setStressDeform({ scale: 2.5, auto: 2.5, max: 100, animate: state === "playing", shown: true });
  p.addStressPin({ tri: 4, weights: [0.2, 0.3, 0.5], label: "7.5 MPa" });
  p.addStressPin({ tri: 9, weights: [0.6, 0.3, 0.1], label: "11.25 MPa" });
  if (state === "setupChanged") p.stress!.setup.gravity.on = true;
  await flushPromises();
  return { wrapper, p };
}

const step = () => document.body.querySelector(".stress-results")!;
const RESULT_ROWS = ".stress-where, .stress-ran-with, .stress-key-row, .stress-detail-row, .stress-details-body";

// The chrome of the tab and the legend, without the rows the result itself fills.
function shown(wrapper: VueWrapper) {
  const all = (sel: string) => [...step().querySelectorAll(sel)].filter((e) => !e.closest(RESULT_ROWS));
  const cls = (e: Element) => [...e.classList].find((c) => c.startsWith("stress-")) ?? e.tagName;
  const pairs = (sel: string, read: (e: Element) => string | null) => all(sel).map((e) => [cls(e), read(e)]);
  return {
    stale: all(".stress-stale > span").map((e) => e.textContent!.trim()),
    titles: pairs("[title]", (e) => e.getAttribute("title")),
    labels: pairs("[aria-label]", (e) => e.getAttribute("aria-label")),
    selects: wrapper
      .findAllComponents({ name: "Select" })
      .map((s) => [s.props("label"), (s.props("options") as { label: string }[]).map((o) => o.label)]),
    buttons: pairs("button", (e) => e.textContent!.trim()),
    words: pairs(".measure-k, .stress-legend-unit", (e) => e.textContent!.trim()),
    ticks: all(".stress-tick").map((e) => e.textContent!.trim()),
  };
}

const MARK: Record<string, string> = { en: ".", de: ",", fr: ",", es: ",", "zh-CN": ".", ja: "." };
const TICKS = ["0", "3.125", "6.25", "9.375", "12.5"];

function expected(file: Lines, code: string, state: State) {
  const L = (key: string, args: MessageArgs = {}) => formatMessage(parseMessage(file[key]!), args, code);
  const R = (key: string, args: MessageArgs = {}) => L(`stress.results.${key}`, args);
  const G = (key: string) => L(`stress.legend.${key}`);
  const pins = [
    ["stress-remove-pin", R("removePoint", { i: 1 })],
    ["stress-remove-pin", R("removePoint", { i: 2 })],
  ];
  const points = [
    ["SPAN", R("point", { i: 1 })],
    ["SPAN", R("point", { i: 2 })],
  ];
  const details = ["stress-more", R("details")];
  if (state === "modelChanged") {
    return {
      stale: [R("modelChanged")],
      titles: [["stress-probe", R("probeTip")], ...pins],
      labels: pins,
      selects: [],
      buttons: [
        ["stress-rerun", R("runAgain")],
        ["stress-probe", R("probe")],
        ["stress-remove-pin", ""],
        ["stress-remove-pin", ""],
        details,
      ],
      words: points,
      ticks: [],
    };
  }
  const playing = state === "playing";
  return {
    stale: state === "setupChanged" ? [R("setupChanged")] : [],
    titles: [
      ["stress-animate", R(playing ? "pauseTip" : "playTip")],
      ["stress-deform", R("exaggeration")],
      ["stress-true-scale", R("trueSizeTip")],
      ["stress-gravity", R("coloursTip")],
      ["stress-gravity", R("deformedTip")],
      ["stress-probe", R("probeTip")],
      ...pins,
      ["stress-gravity", G("bandsTip")],
    ],
    labels: [
      ["stress-colours", R("colours")],
      ["stress-shape", R("deformed")],
      ...pins,
      ["stress-ticks", G("scale")],
      ["BUTTON", `${G("colourMap")}, ${G("perceptual")}`],
      ["stress-bands", G("bands")],
    ],
    selects: [[G("colourMap"), [G("perceptual"), G("rainbow"), G("greyscale")]]],
    buttons: [
      ...(state === "setupChanged" ? [["stress-rerun", R("runAgain")]] : []),
      ["stress-animate", R(playing ? "pause" : "play")],
      ["stress-true-scale", R("trueSize")],
      ["stress-colours", ""],
      ["stress-shape", ""],
      ["stress-probe", R("probe")],
      ["stress-remove-pin", ""],
      ["stress-remove-pin", ""],
      ["BUTTON", G("perceptual")],
      ["stress-bands", ""],
      details,
    ],
    words: [
      ["SPAN", R("exaggeration")],
      ["SPAN", R("colours")],
      ["SPAN", R("deformed")],
      ...points,
      ["stress-legend-unit", G("unit")],
      ["SPAN", G("colourMap")],
      ["SPAN", G("bands")],
      ["stress-where-head", R("where")],
    ],
    ticks: TICKS.map((t) => t.replace(".", MARK[code]!)),
  };
}

const LANGUAGES = [
  ["en", en],
  ["de", de],
  ["fr", fr],
  ["es", es],
  ["zh-CN", zh],
  ["ja", ja],
] as const;

const STATES: State[] = ["shown", "playing", "modelChanged", "setupChanged"];

describe("the Stress Results tab and its legend in the picked language", () => {
  it.each(LANGUAGES)("reads every line of the %s file in each state", async (code, file) => {
    await setLanguage(code);
    for (const state of STATES) {
      const { wrapper, p } = await show(state);
      expect(shown(wrapper), `${code} ${state}`).toEqual(expected(file as Lines, code, state));
      wrapper.unmount();
      p.stress = null;
    }
  });

  it("rewrites the open tab at once on a switch, and again on the next", async () => {
    const { wrapper } = await show("setupChanged");
    expect(shown(wrapper)).toEqual(expected(en as Lines, "en", "setupChanged"));
    await setLanguage("ja");
    await flushPromises();
    expect(shown(wrapper)).toEqual(expected(ja as Lines, "ja", "setupChanged"));
    await setLanguage("de");
    await flushPromises();
    expect(shown(wrapper)).toEqual(expected(de as Lines, "de", "setupChanged"));
  });

  it("spells the tick labels of a second result, with its own range, in the language's mark", async () => {
    await setLanguage("de");
    const { wrapper, p } = await show();
    const second = { ...reply, maxVonMises: { value: 40.2, at: [1.5, 2.5, 3.5] as [number, number, number], face: 2 } };
    p.stressFinished({ result: formatStressResult(second, "mm", ["fixed"]) });
    await flushPromises();
    expect(shown(wrapper).ticks).toEqual(["0", "10,05", "20,1", "30,15", "40,2"]);
  });

  it("offers the three colour maps in the language, one word each", async () => {
    await setLanguage("fr");
    expect(STRESS_RAMPS.map((r) => [r.value, r.label])).toEqual([
      ["perceptual", "Perceptuelle"],
      ["rainbow", "Arc-en-ciel"],
      ["greyscale", "Niveaux de gris"],
    ]);
  });

  // The words a language shares with English.
  const SHARED: Record<string, string[]> = {
    de: ["details", "pause", "material"],
    fr: ["point", "pause"],
    es: ["perceptual", "material", "factor"],
  };

  it.each(LANGUAGES.filter(([c]) => c !== "en"))("leaves no English in the whole %s tab", async (code) => {
    const text = () =>
      [
        ...[...step().querySelectorAll("*")].flatMap((e) =>
          [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent),
        ),
        ...[...step().querySelectorAll("[title], [aria-label]")].map(
          (e) => `${e.getAttribute("title") ?? ""} ${e.getAttribute("aria-label") ?? ""}`,
        ),
      ].join(" ");
    const first = await show("setupChanged");
    const english = text();
    first.wrapper.unmount();
    first.p.stress = null;
    await setLanguage(code);
    await show("setupChanged");
    expect(englishLeft(text(), english, ["hook", "petg", ...(SHARED[code] ?? [])])).toEqual([]);
  });
});
