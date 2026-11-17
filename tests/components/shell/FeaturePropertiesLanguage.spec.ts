// The panel's own words, its hints, the problems a value box shows, the sketch rows and the Features row, follow the
// chosen language, and typing stays what it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FeatureProperties from "../../../src/components/shell/FeatureProperties.vue";
import { createDocBridge } from "../../../src/app/docBridge";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { DocumentStore } from "../../../src/document/store";
import { exprProblem, valueProblem } from "../../../src/document/numFields";
import type { GeometryBackend } from "../../../src/geometry/client";
import { setLanguage } from "../../../src/i18n";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";
import fr from "../../../src/i18n/locales/fr.json";
import ja from "../../../src/i18n/locales/ja.json";
import { toast } from "../../../src/ui/toast";
import type { CadDocument, Feature, RebuildReply } from "../../../src/types";
import { englishLeft } from "../../i18n/englishLeft";

vi.mock("../../../src/ui/toast", () => ({ toast: vi.fn() }));

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

// Typed names stay as typed in every language, so they are the allowed English of a render.
const PLATE = "Plate";
// The typed examples of a hint are literal, and a few German words are the English ones.
const ALLOWED = [PLATE.toLowerCase(), "inch"];
const SAME_IN_DE = ["operation", "start", "parameter", "features"];
const allowedIn = (code: string) => (code === "de" ? [...ALLOWED, ...SAME_IN_DE] : ALLOWED);

const DOC = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "s1",
      type: "sketch",
      plane: "XY",
      entities: [
        { type: "line", id: "l1", x1: 3.5, y1: -2, x2: 11, y2: 7.25 },
        { type: "line", id: "l2", x1: 11, y1: 7.25, x2: 14.5, y2: 1 },
        { type: "circle", id: "c1", x: 11.25, y: -3.5, radius: 6.5 },
      ],
    },
    { id: "dp1", type: "datumPlane", plane: "XY", name: PLATE, offset: 23.5, shiftX: 23.5, tiltX: 17 },
    {
      id: "e1",
      type: "extrude",
      sketch: "s1",
      distance: 12.375,
      taper: -3.5,
      operation: "join",
      startType: "plane",
      startPlane: "dp1",
    },
    { id: "f1", type: "fillet", edges: [], radius: 2.25 },
    { id: "p1", type: "patternLinear", features: ["e1", "f1"], count: 3, spacing: 10.5 },
    {
      id: "s2",
      type: "sketch",
      plane: "XZ",
      entities: [{ type: "line", id: "l9", x1: -4.5, y1: 1.25, x2: 8, y2: -6.5 }],
    },
    { id: "s3", type: "sketch", plane: "XZ", entities: [] },
  ] as unknown as Feature[],
});

let open: { store: DocumentStore; w: VueWrapper | null; dispose: () => void } | null = null;

function panel(id: string, doc: CadDocument = DOC()): VueWrapper {
  const store = new DocumentStore(backend, doc);
  const bridge = createDocBridge(store);
  store.headlessSolve = async () => null;
  const engine = {
    store,
    bridge,
    tools: { targetEdit: { active: false, editingId: null, field: null, start: () => true } },
    toolBusy: () => false,
  } as unknown as Engine;
  const w = mount(FeatureProperties, {
    props: { featureId: id, unit: "mm" },
    global: { provide: { [ENGINE as symbol]: engine } },
  });
  open = { store, w, dispose: () => bridge.dispose() };
  return w;
}

const row = (w: VueWrapper, field: string) => w.find(`.param-row[data-field="${field}"]`);
const labels = (w: VueWrapper) => w.findAll(".param-row label").map((l) => l.text());
const valueLabels = (w: VueWrapper) =>
  w
    .findAll(".param-row")
    .filter((r) => r.find("input").exists() && !r.find("[role=combobox]:not(.ui-unit-chip)").exists())
    .map((r) => r.find("label").text());
const chips = (w: VueWrapper) => w.findAll(".param-row .ui-unit-chip").map((c) => c.text());
const inputOf = (w: VueWrapper, field: string) => row(w, field).find<HTMLInputElement>("input");
const problemOf = (w: VueWrapper, field: string) => row(w, field).find(".param-problem").text();

// What the panel's own words add up to: row names, chosen options, hints and problems. The selection rows and the unit
// chip tips belong to other surfaces and are not read here.
function seen(w: VueWrapper): string {
  const rows = w.findAll(".param-row").filter((r) => !r.find(".target-count").exists());
  return [
    ...rows.map((r) => r.find("label").text()),
    ...rows.map((r) => (r.find(".select-value").exists() ? r.find(".select-value").text() : "")),
    ...rows.map((r) => (r.find("input").exists() ? (r.find("input").attributes("title") ?? "") : "")),
    ...w.findAll(".param-problem").map((p) => p.text()),
  ].join(" | ");
}

async function type(w: VueWrapper, field: string, text: string, commit = true) {
  const input = inputOf(w, field);
  input.element.value = text;
  await input.trigger("input");
  if (commit) await input.trigger("keydown", { key: "Enter" });
  await vi.advanceTimersByTimeAsync(400);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.mocked(toast).mockClear();
});

afterEach(async () => {
  open?.w?.unmount();
  open?.dispose();
  open = null;
  vi.useRealTimers();
  await setLanguage("system");
});

async function render(code: string, id: string) {
  await setLanguage(code);
  const w = panel(id);
  await vi.advanceTimersByTimeAsync(0);
  const text = seen(w);
  w.unmount();
  open!.dispose();
  return text;
}

describe("the words of a feature's rows", () => {
  for (const code of ["de", "ja"]) {
    it(`leave no English in an extrude, a pattern and a sketch in ${code}`, async () => {
      for (const id of ["e1", "p1", "s1"]) {
        const english = await render("en", id);
        const text = await render(code, id);
        expect(englishLeft(text, english, allowedIn(code))).toEqual([]);
      }
    });

    it(`report a row left in English in ${code}`, async () => {
      const english = await render("en", "e1");
      const text = await render(code, "e1");
      const bait = text.replace(code === "de" ? de["field.taper"] : ja["field.taper"], en["field.taper"]);
      expect(bait).not.toBe(text);
      expect(englishLeft(bait, english, allowedIn(code))).toEqual(["taper"]);
    });
  }

  it("keep the unit chips as symbols and show the language's decimal mark", async () => {
    await setLanguage("de");
    let w = panel("e1");
    expect(chips(w)).toEqual(["mm", "°", "mm"]);
    expect(inputOf(w, "distance").element.value).toBe("12,375");
    expect(inputOf(w, "taper").element.value).toBe("-3,5");
    w.unmount();
    await setLanguage("ja");
    w = panel("e1");
    expect(chips(w)).toEqual(["mm", "°", "mm"]);
    expect(inputOf(w, "distance").element.value).toBe("12.375");
    expect(inputOf(w, "taper").element.value).toBe("-3.5");
  });
});

describe("the hint on a value box", () => {
  it("is the English line in English and keeps its examples literal in German", async () => {
    await setLanguage("en");
    let w = panel("e1");
    expect(inputOf(w, "distance").attributes("title")).toBe(
      'a value with any unit (2mm, 1 inch, 1/2"), a parameter, or an expression',
    );
    w.unmount();
    w = panel("s1");
    expect(inputOf(w, "0:length").attributes("title")).toBe('a value with any unit (2mm, 1 inch, 1/2")');
    await setLanguage("de");
    await vi.advanceTimersByTimeAsync(0);
    const hint = inputOf(w, "0:length").attributes("title")!;
    expect(hint).toContain('2mm, 1 inch, 1/2"');
    expect(hint).toContain(de["field.hint.unit"].split(" ")[0]);
    expect(hint).not.toContain("a value");
  });
});

describe("the problems a value box shows", () => {
  it("name a count that is not whole and one below the minimum in German", async () => {
    await setLanguage("de");
    const w = panel("p1");
    await type(w, "count", "2.5");
    expect(problemOf(w, "count")).toContain(de["field.count"]);
    expect(problemOf(w, "count")).toContain("ganze Zahl");
    expect(problemOf(w, "count")).not.toContain("whole");
    await type(w, "count", "0");
    expect(problemOf(w, "count")).toContain("mindestens 1");
    expect(problemOf(w, "count")).not.toContain("least");
    await type(w, "count", "4");
    expect(row(w, "count").find(".param-problem").exists()).toBe(false);
  });

  it("refuse a unit of the wrong kind in the language", async () => {
    await setLanguage("de");
    const w = panel("e1");
    await type(w, "taper", "5in");
    expect(problemOf(w, "taper")).toBe("in ist kein Winkel");
    await type(w, "distance", "5deg");
    expect(problemOf(w, "distance")).toBe("° ist keine Länge");
  });

  it("say in the language that a typed name is no number and no parameter, and keep the typed text", async () => {
    const said: Record<string, string> = {};
    for (const code of ["de", "ja", "en"]) {
      await setLanguage(code);
      const w = panel("e1");
      await type(w, "distance", "widht*2.5");
      expect([inputOf(w, "distance").element.value, inputOf(w, "distance").attributes("aria-invalid")]).toEqual([
        "widht*2.5",
        "true",
      ]);
      said[code] = problemOf(w, "distance");
      w.unmount();
      open!.dispose();
      open = null;
    }
    expect(said.en).toBe('unknown parameter "widht"');
    expect([said.de!.includes("„widht“"), said.de!.includes("Parameter"), said.de!.includes("unknown")]).toEqual([
      true,
      true,
      false,
    ]);
    expect([said.ja!.includes("「widht」"), said.ja!.includes("パラメーター"), said.ja!.includes("unknown")]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("pass every other parameter engine text through as sent", async () => {
    await setLanguage("de");
    const w = panel("p1");
    await type(w, "count", "3mm");
    expect(problemOf(w, "count")).toBe("this field is unitless, write a plain number");
    expect([
      exprProblem(null),
      exprProblem('unknown parameter "gap" in sketch'),
      exprProblem('unknown function "sqr"'),
      exprProblem('unknown parameter "gap2"'),
    ]).toEqual([
      null,
      'unknown parameter "gap" in sketch',
      'unknown function "sqr"',
      "„gap2“ ist keine Zahl und kein Parameter",
    ]);
  });

  it("say that a sketch box holds no value", async () => {
    await setLanguage("ja");
    const w = panel("s2");
    await type(w, "0:length", "abc");
    expect(problemOf(w, "0:length")).toBe(ja["field.problem.notValue"]);
  });

  it("read the rule through valueProblem on both sides of every limit", async () => {
    await setLanguage("de");
    const whole = { integer: true };
    expect(valueProblem("Anzahl", whole, 2 + 5e-10)).toBeNull();
    expect(valueProblem("Anzahl", whole, 2 + 2e-9)).toContain("ganze Zahl");
    expect(valueProblem("Anzahl", whole, -3)).toBeNull();
    expect(valueProblem("Radius", { positive: true }, 0)).toContain("größer als 0");
    expect(valueProblem("Radius", { positive: true }, 1e-6)).toBeNull();
    expect(valueProblem("Radius", { positive: true }, -0.5)).toContain("größer als 0");
    const atLeast = { integer: true, atLeast: 3 };
    expect(valueProblem("Seiten", atLeast, 3)).toBeNull();
    expect(valueProblem("Seiten", atLeast, 2)).toBe("Seiten muss mindestens 3 sein");
    expect(valueProblem("Seiten", atLeast, 7)).toBeNull();
    expect(valueProblem("Abstand", { atLeast: 2.5 }, 2.25)).toContain("2,5");
    expect(valueProblem("Abstand", { atLeast: 2.5 }, 2.5)).toBeNull();
  });
});

describe("the sketch rows", () => {
  it("number two lines and leave the lone circle without a prefix", async () => {
    await setLanguage("de");
    const w = panel("s1");
    expect(labels(w)).toEqual([
      `${de["tool.line"]} 1 ${de["field.length"]}`,
      `${de["tool.line"]} 2 ${de["field.length"]}`,
      de["field.diameter"],
    ]);
    w.unmount();
    await setLanguage("ja");
    const j = panel("s1");
    expect(labels(j)).toEqual([
      `${ja["tool.line"]} 1 ${ja["field.length"]}`,
      `${ja["tool.line"]} 2 ${ja["field.length"]}`,
      ja["field.diameter"],
    ]);
  });

  it("give one line the bare word and an empty sketch no rows", async () => {
    await setLanguage("fr");
    const one = panel("s2");
    expect(labels(one)).toEqual([fr["field.length"]]);
    one.unmount();
    const none = panel("s3");
    expect(labels(none)).toEqual([]);
  });

  it("say in the language when the solver cannot keep a dimension, and in English as before", async () => {
    await setLanguage("de");
    let w = panel("s1");
    await type(w, "2:diameter", "9");
    await vi.advanceTimersByTimeAsync(0);
    const [german] = vi.mocked(toast).mock.calls[0] as [string];
    expect(german).toContain("Durchmesser");
    expect(german).not.toContain("Could not");
    w.unmount();
    vi.mocked(toast).mockClear();
    await setLanguage("en");
    w = panel("s1");
    await type(w, "2:diameter", "9");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(toast).mock.calls).toEqual([
      ["Could not satisfy this diameter with the sketch's other constraints"],
    ]);
  });
});

describe("the Features row", () => {
  it("names its row and the steps in the language", async () => {
    await setLanguage("de");
    const w = panel("p1");
    expect(w.find(".param-row label").text()).toBe(de["field.features"]);
    const names = w.find(".param-row").text();
    expect(names).toContain(de["tool.fillet"]);
    expect(names).not.toContain("Fillet");
  });
});

describe("a language switch on an open panel", () => {
  it("relabels every row at once and keeps a half typed value and the same boxes", async () => {
    await setLanguage("en");
    const w = panel("e1");
    const before = inputOf(w, "taper").element;
    await type(w, "taper", "-7.5", false);
    const englishLabels = valueLabels(w);

    await setLanguage("de");
    await vi.advanceTimersByTimeAsync(0);
    const germanLabels = valueLabels(w);
    expect(germanLabels).toHaveLength(englishLabels.length);
    expect(germanLabels.filter((l, i) => l === englishLabels[i])).toEqual([]);
    expect(germanLabels).toContain(de["field.taper"]);
    expect(inputOf(w, "taper").element).toBe(before);
    expect(inputOf(w, "taper").element.value).toBe("-7,5");

    await setLanguage("fr");
    await vi.advanceTimersByTimeAsync(0);
    expect(valueLabels(w)).toContain(fr["field.taper"]);
    expect(valueLabels(w)).not.toContain(de["field.taper"]);
    expect(inputOf(w, "taper").element).toBe(before);
    expect(inputOf(w, "taper").element.value).toBe("-7,5");
    expect(inputOf(w, "distance").attributes("title")).toContain("paramètre");
  });

  it("shows the second feature's rows and nothing of the first after the switch", async () => {
    await setLanguage("de");
    const w = panel("e1");
    await w.setProps({ featureId: "f1" });
    await setLanguage("ja");
    await vi.advanceTimersByTimeAsync(0);
    expect(valueLabels(w)).toEqual([ja["field.radius"], ja["field.profile"]]);
  });
});
