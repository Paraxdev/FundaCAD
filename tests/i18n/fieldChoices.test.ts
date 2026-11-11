// The dropdown choices of a feature's properties, their tips, the datum, axis and drive rows and the frame around a later
// feature's refusal follow the language. The stored values, the field ids and the engine's own text do not.
import { computed } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOLEAN_COMMANDS } from "../../src/features/booleanOps";
import {
  type ChoiceField,
  choiceFieldsFor,
  datumChoiceRow,
  FEATURE_CHOICE_FIELDS,
  patternAxisChoice,
  PICKED_POINT,
  PLACED_AXIS,
} from "../../src/document/optionFields";
import { mechanismDriveChoice, NO_DRIVE } from "../../src/document/mechanism";
import { DocumentStore } from "../../src/document/store";
import { setLanguage, t } from "../../src/i18n";
import { resetContributions } from "../../src/plugins/contrib";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import ENGLISH from "./fieldChoices.en.json";

type Row = { field: string; label: string; fallback: string; title: string | null; options: [string, string][] };

const ALL = ["en", "de", "es", "fr", "ja", "zh-CN"];

const table = (rows: readonly ChoiceField[]): Row[] =>
  rows.map((r) => ({
    field: r.field,
    label: r.label,
    fallback: r.fallback,
    title: r.title ?? null,
    options: r.options.map((o) => [o.value, o.label]),
  }));

const optionLabels = (type: string, field: string) =>
  choiceFieldsFor(type)
    .find((c) => c.field === field)!
    .options.map((o) => o.label);

const optionValues = (type: string, field: string) =>
  choiceFieldsFor(type)
    .find((c) => c.field === field)!
    .options.map((o) => o.value);

afterEach(async () => {
  resetContributions();
  await setLanguage("system");
});

describe("the choice tables", () => {
  it("read as today's English, option by option and tip by tip, in English", async () => {
    await setLanguage("en");
    const got = Object.fromEntries(Object.entries(FEATURE_CHOICE_FIELDS).map(([type, rows]) => [type, table(rows!)]));
    expect(got).toEqual(ENGLISH);
  });

  it("keep every field id, value and fallback in every language, and no label shows its key", async () => {
    const values = (rows: Row[]) =>
      rows.map((r) => ({ field: r.field, fallback: r.fallback, values: r.options.map((o) => o[0]) }));
    const wanted = Object.fromEntries(
      Object.entries(ENGLISH as unknown as Record<string, Row[]>).map(([type, rows]) => [type, values(rows)]),
    );
    for (const code of ALL) {
      await setLanguage(code);
      const got = Object.fromEntries(Object.entries(FEATURE_CHOICE_FIELDS).map(([type, rows]) => [type, table(rows!)]));
      expect(Object.fromEntries(Object.entries(got).map(([type, rows]) => [type, values(rows)])), code).toEqual(wanted);
      for (const rows of Object.values(got)) {
        for (const r of rows) {
          for (const text of [r.label, r.title ?? "", ...r.options.map((o) => o[1])]) {
            expect(text, `${code} ${r.field}`).not.toMatch(/^field\.|^tool\./);
          }
          if (r.title !== null) expect(r.title.length, `${code} ${r.field}`).toBeGreaterThan(8);
        }
      }
    }
  });

  it("offer the three booleans in the order of the commands", async () => {
    await setLanguage("de");
    expect(optionValues("boolean", "operation")).toEqual(BOOLEAN_COMMANDS.map((c) => c.op));
    expect(optionLabels("boolean", "operation")).toEqual(["Vereinigen", "Subtrahieren", "Schnittmenge"]);
  });

  it.each([
    ["de", ["Neuer Körper", "Verbinden", "Ausschneiden", "Schnittmenge"]],
    ["ja", ["新しいボディ", "結合", "切り取り", "交差"]],
  ])("list an extrude's Operation in order in %s", async (code, labels) => {
    await setLanguage(code);
    expect(optionValues("extrude", "operation")).toEqual(["new", "join", "cut", "intersect"]);
    expect(optionLabels("extrude", "operation")).toEqual(labels);
  });

  it("list an extrude's start and end choices in German, symbols and ids untouched", async () => {
    await setLanguage("de");
    expect(optionValues("extrude", "startType")).toEqual(["sketch", "offset", "face", "plane", "point"]);
    expect(optionLabels("extrude", "startType")).toEqual(["Skizzenebene", "Versatz", "Fläche", "Ebene", "Punkt"]);
    expect(optionValues("extrude", "endType")).toEqual([
      "distance",
      "upToFace",
      "upToPlane",
      "upToPoint",
      "throughAll",
    ]);
    expect(optionLabels("extrude", "endType")).toEqual([
      "Abstand",
      "Bis Fläche",
      "Bis Ebene",
      "Bis Punkt",
      "Durch alles",
    ]);
    expect(optionLabels("extrude", "side")).toEqual(["Zentriert", "Innen", "Außen", "Zwei Seiten"]);
    expect(optionLabels("extrude", "startPlane")).toEqual(["XY", "XZ", "YZ"]);
    expect(optionLabels("revolve", "axis")).toEqual(["X", "Y", "Z"]);
    expect(optionLabels("fillet", "continuity")).toEqual(["G1", "G2", "G3"]);
  });

  it("list a hole's Standard, type and fit in German and Japanese, the sizes as written", async () => {
    await setLanguage("de");
    expect(optionValues("hole", "standard")).toEqual(["clearance", "tap", "custom"]);
    expect(optionLabels("hole", "standard")).toEqual(["Durchgangsbohrung", "Kernloch", "Eigene Werte"]);
    expect(optionLabels("hole", "holeType")).toEqual(["Einfach", "Flachsenkung", "Kegelsenkung", "Einschmelzmutter"]);
    expect(optionLabels("hole", "fit")).toEqual(["Eng", "Normal", "Locker"]);
    expect(optionLabels("hole", "extent")).toEqual(["Sackloch", "Durch alles"]);
    const sizes = optionLabels("hole", "size");
    expect(sizes).toEqual(optionValues("hole", "size"));
    expect(sizes).toContain("M12");
    await setLanguage("ja");
    expect(optionLabels("hole", "standard")).toEqual(["通し穴", "下穴", "カスタム"]);
    expect(optionLabels("hole", "size")).toEqual(sizes);
  });

  it("list the other tables in German", async () => {
    await setLanguage("de");
    expect(optionLabels("thread", "hand")).toEqual(["Rechts", "Links"]);
    expect(optionLabels("thread", "operation")).toEqual(["Verbinden", "Ausschneiden"]);
    expect(optionLabels("textOnFace", "operation")).toEqual(["Prägen", "Gravieren"]);
    expect(optionLabels("textOnFace", "align")).toEqual(["Links", "Zentriert", "Rechts"]);
    expect(optionLabels("sweep", "operation")).toEqual(["Neuer Körper", "Verbinden", "Ausschneiden"]);
    expect(optionLabels("thicken", "operation")).toEqual(["Neuer Körper", "Verbinden"]);
    expect(optionLabels("press-pull", "mode")).toEqual([
      "Automatisch",
      "Neuer Körper",
      "Verbinden",
      "Ausschneiden",
      "Schnittmenge",
    ]);
    expect(optionLabels("press-pull", "direction")).toEqual(["Entlang der Normalen", "Entlang der Achse"]);
    expect(optionLabels("fillet", "sizeType")).toEqual(["Radius", "Sehnenlänge"]);
    expect(optionLabels("chamfer", "chamferType")).toEqual(["Gleicher Abstand", "Zwei Abstände"]);
    expect(optionLabels("mechanism", "drive")).toEqual(["Keine"]);
  });
});

describe("the tips", () => {
  it("read in the language, one per row that has one", async () => {
    await setLanguage("de");
    const rows = Object.values(FEATURE_CHOICE_FIELDS).flat();
    expect(rows.filter((r) => r!.title !== undefined).map((r) => `${r!.field}`)).toEqual([
      "endType",
      "endType2",
      "side",
      "drive",
      "mode",
      "direction",
      "sizeType",
      "continuity",
      "holeType",
      "standard",
    ]);
    const tip = (type: string, field: string) => choiceFieldsFor(type).find((c) => c.field === field)!.title;
    expect(tip("hole", "standard")).toContain("ISO 273");
    expect(tip("hole", "standard")).toContain("Kernloch");
    expect(tip("extrude", "endType")).toBe(tip("extrude", "endType2"));
    expect(tip("fillet", "continuity")).toContain("G3");
    expect(tip("hole", "fit")).toBeUndefined();
  });

  it("differ per language, and the English one is today's sentence", async () => {
    const tip = () => choiceFieldsFor("hole").find((c) => c.field === "holeType")!.title;
    const seen = new Set<string | undefined>();
    for (const code of ALL) {
      await setLanguage(code);
      seen.add(tip());
    }
    expect(seen.size).toBe(ALL.length);
    await setLanguage("en");
    expect(tip()).toBe("Heat-set insert sizes the bore for a brass insert of the chosen size");
  });

  it("re-read on a switch inside a computed, label, option and tip together", async () => {
    await setLanguage("en");
    const row = computed(() => {
      const c = { ...choiceFieldsFor("hole")[0]! };
      return [c.label, c.options[1]!.label, c.title];
    });
    expect(row.value).toEqual([
      "Hole type",
      "Counterbore",
      "Heat-set insert sizes the bore for a brass insert of the chosen size",
    ]);
    await setLanguage("de");
    expect(row.value).toEqual([
      "Bohrungstyp",
      "Flachsenkung",
      "Einschmelzmutter bemisst die Bohrung für eine Messingmutter der gewählten Größe",
    ]);
    await setLanguage("ja");
    expect(row.value[1]).toBe("座ぐり");
  });
});

const datum = (id: string, name?: string): Feature =>
  ({ id, type: "datumPlane", plane: "XY", offset: 23.5, tiltX: 17, ...(name ? { name } : {}) }) as unknown as Feature;

const extrude = (over: Record<string, unknown>): Feature =>
  ({ id: "e1", type: "extrude", sketch: "s1", distance: 12.375, operation: "new", ...over }) as unknown as Feature;

describe("the datum rows", () => {
  const features = (over: Record<string, unknown>) => [datum("dp1", "Platte {x}"), datum("dp2"), extrude(over)];
  const row = (over: Record<string, unknown>, field = "startPlane") => {
    const all = features(over);
    return datumChoiceRow(all[2]!, field, all)!;
  };

  it("offer the world planes and the datums above, a name as typed, in German", async () => {
    await setLanguage("de");
    expect(row({ startType: "plane", startPlane: "dp2" })).toEqual({
      options: [
        { value: "XY", label: "XY" },
        { value: "XZ", label: "XZ" },
        { value: "YZ", label: "YZ" },
        { value: "dp1", label: "Platte {x}" },
        { value: "dp2", label: "dp2" },
      ],
      current: "dp2",
    });
  });

  it("add a picked point for a vertex, in each language", async () => {
    const want: Record<string, string> = {
      en: "Picked point",
      de: "Gewählter Punkt",
      fr: "Point choisi",
      ja: "選択した点",
    };
    for (const [code, label] of Object.entries(want)) {
      await setLanguage(code);
      const got = row({ startType: "point", startPoint: [1.5, -2.25, 7] }, "startPoint");
      expect(got.current).toBe(PICKED_POINT);
      expect(got.options).toEqual([{ value: PICKED_POINT, label }]);
    }
  });

  it("add the missing datum with its id as stored, the words in German", async () => {
    await setLanguage("de");
    const got = row({ startType: "plane", startPlane: "gone7" });
    expect(got.current).toBe("gone7");
    expect(got.options.at(-1)).toEqual({ value: "gone7", label: "gone7 (fehlt)" });
    expect(got.options).toHaveLength(6);
  });

  it("never read the stored id as message syntax", async () => {
    await setLanguage("de");
    const got = row({ startType: "plane", startPlane: "{count, number} 'a'" });
    expect(got.options.at(-1)!.label).toBe("{count, number} 'a' (fehlt)");
  });

  it("say Choose one for an empty row, first, in German", async () => {
    await setLanguage("de");
    const got = row({ startType: "plane", startPlane: "" });
    expect(got.current).toBe("");
    expect(got.options.map((o) => o.label)).toEqual(["Auswählen", "XY", "XZ", "YZ", "Platte {x}", "dp2"]);
  });

  it("read as today's English in English", async () => {
    await setLanguage("en");
    expect(row({ startType: "plane", startPlane: "gone7" }).options.at(-1)!.label).toBe("gone7 (missing)");
    expect(row({ startType: "plane", startPlane: "" }).options[0]).toEqual({ value: "", label: "Choose one" });
  });
});

describe("the pattern axis row", () => {
  const axis = (id: string, name?: string) =>
    ({
      id,
      type: "datumAxis",
      origin: [1.5, 2, 3],
      dir: [0.5, 1, 0.25],
      ...(name ? { name } : {}),
    }) as unknown as Feature;
  const pattern = (over: Record<string, unknown>) =>
    ({ id: "p1", type: "patternCircular", count: 5, ...over }) as unknown as Feature;
  const rowOf = (over: Record<string, unknown>) => {
    const p = pattern(over);
    return patternAxisChoice(p, [axis("a1", "Welle"), axis("a2"), p]);
  };

  it("name a world axis and the datum axes above, a name as typed", async () => {
    await setLanguage("de");
    expect(rowOf({ axis: { datum: "a1" } })).toEqual({
      options: [
        { value: "X", label: "X" },
        { value: "Y", label: "Y" },
        { value: "Z", label: "Z" },
        { value: "a1", label: "Welle" },
        { value: "a2", label: "a2" },
      ],
      current: "a1",
    });
  });

  it("say Picked for a picked edge and Line for a placed line", async () => {
    const want: Record<string, [string, string]> = {
      en: ["Picked", "Line"],
      de: ["Gewählt", "Linie"],
      es: ["Elegido", "Línea"],
      zh: ["已选", "直线"],
    };
    for (const [code, [picked, line]] of Object.entries(want)) {
      await setLanguage(code === "zh" ? "zh-CN" : code);
      const edge = rowOf({ axisRef: { kind: "edge", by: "nearest", point: [1.5, 2, 3] } });
      expect(edge.current).toBe(PLACED_AXIS);
      expect(edge.options.at(-1)).toEqual({ value: PLACED_AXIS, label: picked });
      const placed = rowOf({ axis: { origin: [2.5, 0, 1], dir: [0.25, 1, 0.5] } });
      expect(placed.current).toBe(PLACED_AXIS);
      expect(placed.options.at(-1)).toEqual({ value: PLACED_AXIS, label: line });
      expect(placed.options).toHaveLength(6);
    }
  });

  it("keep an unknown axis name as written", async () => {
    await setLanguage("de");
    expect(rowOf({ axis: "W" }).options.at(-1)).toEqual({ value: "W", label: "W" });
  });
});

describe("the mechanism drive row", () => {
  const joint = (id: string, mode: string) => ({ id, mode, a: "body1", b: "body2" });
  const values = (drive?: string): Record<string, unknown> => ({
    joints: [joint("slide1", "slider"), joint("pin2", "revolute"), joint("weld1", "rigid")],
    ...(drive !== undefined ? { drive } : {}),
  });

  it("reads as today's English in English", async () => {
    await setLanguage("en");
    expect(mechanismDriveChoice(values("slide1"))).toEqual({
      options: [
        { value: NO_DRIVE, label: "None" },
        { value: "slide1", label: "slide1 (slider)" },
        { value: "pin2", label: "pin2 (revolute)" },
      ],
      current: "slide1",
    });
  });

  it("names the mode and the none option in German, the ids as stored", async () => {
    await setLanguage("de");
    expect(mechanismDriveChoice(values("pin2"))).toEqual({
      options: [
        { value: NO_DRIVE, label: "Keine" },
        { value: "slide1", label: "slide1 (Schubgelenk)" },
        { value: "pin2", label: "pin2 (Drehgelenk)" },
      ],
      current: "pin2",
    });
    expect(mechanismDriveChoice(values()).current).toBe(NO_DRIVE);
  });

  it("lists a drive it cannot offer by its id in every language, and a mode it does not know as it is", async () => {
    for (const code of ALL) {
      await setLanguage(code);
      expect(mechanismDriveChoice(values("weld1")).options.at(-1), code).toEqual({ value: "weld1", label: "weld1" });
    }
    await setLanguage("de");
    expect(t("field.option.driveJoint", { joint: "g1", mode: "gear" })).toBe("g1 (gear)");
  });

  it("gives a different mode word in every language but one id", async () => {
    const labels = new Set<string>();
    for (const code of ALL) {
      await setLanguage(code);
      labels.add(mechanismDriveChoice(values("pin2")).options[2]!.label);
    }
    expect(labels.size).toBe(ALL.length);
  });
});

type Errors = { feature_id: string; message: string }[];

const backend = (errors: Errors): GeometryBackend =>
  ({
    async rebuild(): Promise<RebuildReply> {
      return {
        ok: true,
        result: {
          mesh: { positions: [], indices: [], faceIds: [] },
          edges: [],
          bbox: null,
          bodies: [],
          ...(errors.length ? { featureErrors: errors, featureError: errors[errors.length - 1] } : {}),
        },
      } as unknown as RebuildReply;
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  }) as unknown as GeometryBackend;

const ENGINE_TEXT = "BRep_API: command not done (code 7)";

const later = (name?: string): CadDocument => ({
  parameters: {},
  features: [
    { id: "bx", type: "box", length: 20, width: 20, height: 20 },
    { id: "f1", type: "fillet", radius: 2.5, ...(name ? { name } : {}) },
  ] as unknown as Feature[],
});

const box = (length: number): Feature => ({ id: "bx", type: "box", length, width: 20, height: 20 }) as Feature;

describe("a later feature's refusal during an edit in place", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  async function frame(doc: CadDocument, errors: Errors, length = 120) {
    const store = new DocumentStore(backend(errors), doc);
    store.beginEditPreview("bx", box(length), { inPlace: true });
    await vi.runAllTimersAsync();
    return store;
  }

  it("frames the engine's text in German and leaves it as sent, for a name that is not typed", async () => {
    await setLanguage("de");
    const store = await frame(later(), [{ feature_id: "f1", message: ENGINE_TEXT }]);
    expect(store.previewError).toBe(`Verrundung schlägt mit diesem Wert fehl: ${ENGINE_TEXT}`);
  });

  it("keeps a typed name as typed in every language, and the English frame as today", async () => {
    const want: Record<string, string> = {
      en: `Griff {a} fails with this value: ${ENGINE_TEXT}`,
      de: `Griff {a} schlägt mit diesem Wert fehl: ${ENGINE_TEXT}`,
      fr: `Griff {a} échoue avec cette valeur : ${ENGINE_TEXT}`,
      ja: `Griff {a} はこの値では失敗します: ${ENGINE_TEXT}`,
    };
    for (const [code, text] of Object.entries(want)) {
      await setLanguage(code);
      const store = await frame(later("Griff {a}"), [{ feature_id: "f1", message: ENGINE_TEXT }]);
      expect(store.previewError, code).toBe(text);
    }
  });

  it("names an unnamed feature as English reads it today in English", async () => {
    await setLanguage("en");
    const store = await frame(later(), [{ feature_id: "f1", message: ENGINE_TEXT }]);
    expect(store.previewError).toBe(`Fillet fails with this value: ${ENGINE_TEXT}`);
  });

  it("follows a switch of language on the next read", async () => {
    await setLanguage("de");
    const store = await frame(later(), [{ feature_id: "f1", message: ENGINE_TEXT }]);
    expect(store.previewError).toContain("schlägt");
    await setLanguage("es");
    expect(store.previewError).toBe(`Redondeo falla con este valor: ${ENGINE_TEXT}`);
  });

  it("passes the edited feature's own error through bare, and the earliest later failure wins", async () => {
    await setLanguage("de");
    const own = await frame(later(), [
      { feature_id: "bx", message: ENGINE_TEXT },
      { feature_id: "f1", message: "second" },
    ]);
    expect(own.previewError).toBe(ENGINE_TEXT);
    const doc = later();
    doc.features.push({ id: "f2", type: "fillet", radius: 1.25 } as unknown as Feature);
    const two = await frame(doc, [
      { feature_id: "f2", message: "later one" },
      { feature_id: "f1", message: "earlier one" },
    ]);
    expect(two.previewError).toBe("Verrundung schlägt mit diesem Wert fehl: earlier one");
  });

  it("shows nothing when nothing after the edit fails", async () => {
    await setLanguage("de");
    expect((await frame(later(), [])).previewError).toBeNull();
  });
});

beforeEach(async () => {
  await setLanguage("en");
});
