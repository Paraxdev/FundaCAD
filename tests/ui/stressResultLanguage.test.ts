// The Stress result's rows, details, peaks and ran with line follow the picked language, also on a live switch.
import { afterEach, describe, expect, it } from "vitest";
import { markRaw } from "vue";
import { setLanguage } from "../../src/i18n";
import { argNames, parseMessage, type MessageNode } from "../../src/i18n/format";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import es from "../../src/i18n/locales/es.json";
import fr from "../../src/i18n/locales/fr.json";
import ja from "../../src/i18n/locales/ja.json";
import zh from "../../src/i18n/locales/zh-CN.json";
import type { StressReply } from "../../src/geometry/client";
import { formatStressResult, newSetup, setupSummary, type StressResultView } from "../../src/ui/stress";
import { setUnit } from "../../src/ui/units";
import { englishLeft } from "../i18n/englishLeft";

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

type Mesh = StressReply["mesh"];

const mesh = (over: Partial<Mesh> = {}): Mesh => ({
  nodes: 3100,
  elements: 12000,
  size: 2.2,
  minDihedral: 9.6,
  ...over,
});
const THREE_PASSES = [
  { elements: 4000, maxVonMises: 14.2 },
  { elements: 8000, maxVonMises: 13.1 },
  { elements: 12000, maxVonMises: 12.5 },
];

const reply = (over: Partial<StressReply> = {}): StressReply => ({
  body: "b2",
  name: "Hook",
  material: { name: "PETG", E: 2100, nu: 0.38, yield: 50 },
  mesh: mesh({ finest: 0.45, passes: THREE_PASSES, stop: "memory" }),
  maxVonMises: { value: 12.5, at: [12.5, -7.25, 31.4], face: 6 },
  maxDisplacement: { value: 0.0314, at: [-3.75, 18.2, 6.05], vector: [0.1, -0.2, -0.58] },
  safetyFactor: 2.43,
  applied: [0, -12.5, -20.5],
  reaction: [0, 12.5, 20.5],
  weight: [0, 0, -0.35],
  reactions: [
    [1.25, 3, 7],
    [-1.25, 9.5, 13],
    [0, 0, 0.5],
  ],
  ...over,
});

const KINDS = ["fixed", "pinned", "slider"] as const;
const plain = (rows: readonly { k: string; v: string }[]) => rows.map((r) => ({ k: r.k, v: r.v }));
const read = (v: StressResultView) => ({
  rows: plain(v.rows),
  details: plain(v.details),
  peaks: v.peaks.map((p) => ({ label: p.label, where: p.where, spoken: p.spoken })),
});
const full = () => formatStressResult(reply(), "mm", KINDS, "fine");
// The mesh row and the refinement row, which follow the five rows every reply has.
const meshDetail = (m: Mesh) => plain(formatStressResult(reply({ mesh: m, reactions: [] }), "mm").details).slice(5);

describe("the result in German", () => {
  it("reads every row with the comma, a semicolon in lists and no English", async () => {
    await setLanguage("de");
    expect(read(full())).toEqual({
      rows: [
        { k: "Sicherheitsfaktor", v: "2,43" },
        { k: "Spitzenspannung", v: "12,5 MPa" },
        { k: "Max. Durchbiegung", v: "0,0314 mm" },
      ],
      details: [
        { k: "Material", v: "PETG" },
        { k: "Streckgrenze", v: "50 MPa" },
        { k: "Gewicht", v: "0; 0; -0,35 N" },
        { k: "Aufgebrachte Kraft", v: "0; -12,5; -20,5 N" },
        { k: "Reaktionskraft", v: "0; 12,5; 20,5 N" },
        { k: "Halterung 1, fest", v: "1,25; 3; 7 N" },
        { k: "Halterung 2, drehbar", v: "-1,25; 9,5; 13 N" },
        { k: "Halterung 3, gleitend", v: "0; 0; 0,5 N" },
        { k: "Netz", v: "12000 Elemente, 2,2 mm, 0,45 mm an der Spitze, 3 Durchläufe" },
        {
          k: "Netzfeinheit",
          v: "2 Mal verfeinert, die Spitzenspannung ging von 14,2 auf 12,5 MPa, danach gestoppt, da ein feineres Netz mehr Speicher braucht",
        },
        { k: "Hinweis", v: de["stress.result.fineNote"] },
      ],
      peaks: [
        {
          label: "Spitzenspannung",
          where: "x 12,5; y -7,25; z 31,4 mm",
          spoken: "Spitzenspannung, 12,5 MPa, bei x 12,5; y -7,25; z 31,4 mm",
        },
        {
          label: "Max. Durchbiegung",
          where: "x -3,75; y 18,2; z 6,05 mm",
          spoken: "Max. Durchbiegung, 0,0314 mm, bei x -3,75; y 18,2; z 6,05 mm",
        },
      ],
    });
  });

  it("counts elements and passes with the plural of the language, no grouping", async () => {
    await setLanguage("de");
    const line = (elements: number, passes: typeof THREE_PASSES) =>
      meshDetail(mesh({ elements, finest: 0.45, passes, stop: "elements" }))[0]!.v;
    expect(line(1, THREE_PASSES.slice(0, 2))).toBe("1 Element, 2,2 mm, 0,45 mm an der Spitze, 2 Durchläufe");
    expect(line(12000, [...THREE_PASSES, { elements: 20000, maxVonMises: 12.1 }])).toBe(
      "12000 Elemente, 2,2 mm, 0,45 mm an der Spitze, 4 Durchläufe",
    );
    expect(meshDetail(mesh({ elements: 1 }))).toEqual([{ k: "Netz", v: "1 Element, 2,2 mm" }]);
  });

  it("says once for one refinement and many times for more, then why it stopped", async () => {
    await setLanguage("de");
    const two = THREE_PASSES.slice(0, 2);
    expect(meshDetail(mesh({ passes: two, stop: "settled" }))[1]!.v).toBe(
      "Einmal verfeinert, die Spitzenspannung ging von 14,2 auf 13,1 MPa, danach würde ein feineres Netz die Spitze kaum verändern",
    );
    expect(meshDetail(mesh({ passes: THREE_PASSES, stop: "off" }))[1]!.v).toBe(
      "2 Mal verfeinert, die Spitzenspannung ging von 14,2 auf 12,5 MPa",
    );
  });

  it("names what a one pass run did, and has no detail row for a stop it does not know", async () => {
    await setLanguage("de");
    const one = [THREE_PASSES[0]!];
    const detail = (stop: string | undefined, passes = one) =>
      meshDetail(mesh({ passes, ...(stop === undefined ? {} : { stop }) }))[1]?.v ?? null;
    expect([
      detail("off"),
      detail("settled"),
      detail("elements"),
      detail("time"),
      detail("memory"),
      detail("unrefinable"),
      detail("odd"),
      detail(undefined),
    ]).toEqual([
      "Grob",
      "Nicht nötig, ein feineres Netz würde die Spitze kaum verändern",
      "Am Elementlimit gestoppt",
      "Gestoppt, um bei etwa einer Minute zu bleiben",
      "Gestoppt, da ein feineres Netz mehr Speicher braucht",
      "Nichts mehr zu verfeinern",
      null,
      null,
    ]);
    expect(detail("odd", THREE_PASSES)).toBe("2 Mal verfeinert, die Spitzenspannung ging von 14,2 auf 12,5 MPa");
  });

  it("keeps the mesh line plain when the finest size is not finer or only one pass ran", async () => {
    await setLanguage("de");
    const rows = (m: Partial<Mesh>) => meshDetail(mesh(m))[0]!.v;
    expect(rows({ finest: 2.2, passes: THREE_PASSES })).toBe("12000 Elemente, 2,2 mm");
    expect(rows({ finest: 2.19, passes: THREE_PASSES })).toBe(
      "12000 Elemente, 2,2 mm, 2,19 mm an der Spitze, 3 Durchläufe",
    );
    expect(rows({ finest: 0.45, passes: THREE_PASSES.slice(0, 1) })).toBe("12000 Elemente, 2,2 mm");
  });

  it("leaves out the weight, the per support rows and the note when there are none", async () => {
    await setLanguage("de");
    const v = formatStressResult(reply({ weight: null, reactions: [[1, 2, 3]], safetyFactor: null }), "mm", KINDS);
    expect(plain(v.rows)[0]).toEqual({ k: "Sicherheitsfaktor", v: "keine, keine Spannung" });
    expect(plain(v.details).map((d) => d.k)).toEqual([
      "Material",
      "Streckgrenze",
      "Aufgebrachte Kraft",
      "Reaktionskraft",
      "Netz",
      "Netzfeinheit",
    ]);
  });

  it("writes a support without a known kind as its number alone", async () => {
    await setLanguage("de");
    const v = formatStressResult(
      reply({
        reactions: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      }),
      "mm",
      ["slider"],
    );
    expect(plain(v.details).filter((d) => d.k.startsWith("Halterung"))).toEqual([
      { k: "Halterung 1, gleitend", v: "1; 2; 3 N" },
      { k: "Halterung 2", v: "4; 5; 6 N" },
    ]);
  });

  it("spells the bend in the display unit", async () => {
    setUnit("in");
    await setLanguage("de");
    const v = read(
      formatStressResult(reply({ maxDisplacement: { value: 25.4, at: [25.4, -12.7, 50.8], vector: [0, 0, 1] } }), "in"),
    );
    expect([v.rows[2], v.peaks[1]]).toEqual([
      { k: "Max. Durchbiegung", v: "1 in" },
      {
        label: "Max. Durchbiegung",
        where: "x 1; y -0,5; z 2 in",
        spoken: "Max. Durchbiegung, 1 in, bei x 1; y -0,5; z 2 in",
      },
    ]);
  });
});

describe("the result in Japanese", () => {
  it("keeps the dot, joins lists with a comma and speaks Japanese", async () => {
    await setLanguage("ja");
    const v = read(full());
    expect(v.rows).toEqual([
      { k: "安全率", v: "2.43" },
      { k: "最大応力", v: "12.5 MPa" },
      { k: "最大たわみ", v: "0.0314 mm" },
    ]);
    expect(v.peaks[0]).toEqual({
      label: "最大応力",
      where: "x 12.5, y -7.25, z 31.4 mm",
      spoken: "最大応力、12.5 MPa、x 12.5, y -7.25, z 31.4 mm",
    });
    expect(v.details.slice(5, 9)).toEqual([
      { k: "支持 1、固定", v: "1.25, 3, 7 N" },
      { k: "支持 2、ピン", v: "-1.25, 9.5, 13 N" },
      { k: "支持 3、スライド", v: "0, 0, 0.5 N" },
      { k: "メッシュ", v: "12000 要素、2.2 mm、ピーク部 0.45 mm、3 回" },
    ]);
  });
});

describe("a view built in English and read after a switch", () => {
  it("rewrites rows, details and peaks on the same object, then again", async () => {
    await setLanguage("en");
    const view = markRaw(full());
    const english = read(view);
    expect(english.rows[0]).toEqual({ k: "Safety factor", v: "2.43" });
    expect(english.peaks[0]!.spoken).toBe("Peak stress, 12.5 MPa, at x 12.5, y -7.25, z 31.4 mm");

    await setLanguage("de");
    const german = read(view);
    await setLanguage("ja");
    const japanese = read(view);
    await setLanguage("en");

    expect(german.rows[0]).toEqual({ k: "Sicherheitsfaktor", v: "2,43" });
    expect(german.details[8]!.v).toBe("12000 Elemente, 2,2 mm, 0,45 mm an der Spitze, 3 Durchläufe");
    expect(german.peaks[1]!.where).toBe("x -3,75; y 18,2; z 6,05 mm");
    expect(japanese.rows[0]).toEqual({ k: "安全率", v: "2.43" });
    expect(japanese.peaks[0]!.label).toBe("最大応力");
    expect(read(view)).toEqual(english);
  });

  it("spells the refinement's peaks with the mark of the language read in, not the one run in", async () => {
    await setLanguage("de");
    const view = markRaw(formatStressResult(reply({ reactions: [] }), "mm"));
    const peaks = () => view.details[6]!.v.match(/\d+[.,]\d+/g);
    const german = peaks();
    await setLanguage("en");
    const english = peaks();
    await setLanguage("ja");
    expect([german, english, peaks()]).toEqual([
      ["14,2", "12,5"],
      ["14.2", "12.5"],
      ["14.2", "12.5"],
    ]);
  });

  it("leaves no English in the rows of any language", async () => {
    const allow = ["MPa", "PETG", "mesh", "material", "standard", "passes", "factor"];
    for (const code of ["de", "fr", "es", "ja", "zh-CN"]) {
      await setLanguage(code);
      const v = read(full());
      const text = [...v.rows, ...v.details]
        .flatMap((r) => [r.k, r.v])
        .concat(v.peaks.flatMap((p) => [p.label, p.spoken]));
      await setLanguage("en");
      const english = read(full());
      const englishText = [...english.rows, ...english.details].flatMap((r) => [r.k, r.v]);
      expect([code, englishLeft(text.join(" "), englishText.join(" "), allow)]).toEqual([code, []]);
    }
  });
});

describe("setupSummary", () => {
  const setup = (supports: number, loads: number, gravity: boolean, material: string) => {
    const s = newSetup("b1");
    s.supports = Array.from({ length: supports }, (_, i) => ({ ...newSetup("b1").supports[0]!, id: i + 1 }));
    s.loads = Array.from({ length: loads }, (_, i) => ({ ...newSetup("b1").loads[0]!, id: i + 1 }));
    s.gravity = { on: gravity, direction: "+Y" };
    s.material = material;
    return s;
  };

  it("counts 0, 1 and many in German, with the own weight on and off and the material as typed", async () => {
    await setLanguage("de");
    expect([
      setupSummary(setup(0, 0, false, "PLA")),
      setupSummary(setup(1, 1, true, "PETG")),
      setupSummary(setup(3, 2, false, "aluminium 6061-T6")),
      setupSummary(setup(2, 0, true, "Custom")),
    ]).toEqual([
      "0 Halterungen, 0 Lasten, PLA",
      "1 Halterung, 1 Last, Eigengewicht +Y, PETG",
      "3 Halterungen, 2 Lasten, aluminium 6061-T6",
      "2 Halterungen, 0 Lasten, Eigengewicht +Y, Custom",
    ]);
  });

  it("reads in Japanese and in English", async () => {
    await setLanguage("ja");
    expect(setupSummary(setup(3, 1, true, "PETG"))).toBe("支持 3 件、荷重 1 件、自重 +Y、PETG");
    await setLanguage("en");
    expect(setupSummary(setup(1, 0, true, "PLA"))).toBe("1 support, 0 loads, own weight +Y, PLA");
  });
});

// Plural categories differ by language, so only the select options are compared.
const selects = (nodes: readonly MessageNode[], into: string[] = []): string[] => {
  for (const n of nodes) {
    if (n.t !== "select" && n.t !== "plural") continue;
    if (n.t === "select") into.push(`${n.name}:${[...n.options.keys()].sort().join("|")}`);
    for (const o of n.options.values()) selects(o, into);
  }
  return into.sort();
};

describe("the result lines of every language", () => {
  const files = { de, fr, es, ja, "zh-CN": zh } as Record<string, Record<string, string>>;
  const keys = Object.keys(en).filter((k) => k.startsWith("stress.result."));

  it("are the seventeen keys, in every language", () => {
    expect(keys).toHaveLength(17);
    for (const file of Object.values(files)) {
      expect(Object.keys(file).filter((k) => k.startsWith("stress.result."))).toEqual(keys);
    }
  });

  it.each(keys)("%s keeps English's select options and arguments in every language", (key) => {
    const english = parseMessage(en[key as keyof typeof en]);
    for (const [code, file] of Object.entries(files)) {
      const nodes = parseMessage(file[key]!);
      expect(selects(nodes), code).toEqual(selects(english));
      expect([...argNames(nodes)].sort(), code).toEqual([...argNames(english)].sort());
    }
  });

  it("fails the option check on a line that dropped the memory option", () => {
    const line = en["stress.result.refineOnce"];
    const dropped = parseMessage(line.replace(/ memory \{[^}]*\}/, ""));
    expect(selects(dropped)).not.toEqual(selects(parseMessage(line)));
  });
});
