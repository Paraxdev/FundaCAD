import { describe, expect, it } from "vitest";
import { SHIPPED } from "../../src/i18n/languages";
import { checkLine } from "../../src/i18n/overrides";
import en from "../../src/i18n/locales/en.json";
import enText from "../../src/i18n/locales/en.json?raw";

const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

const sources = Object.values({
  ...import.meta.glob("../../src/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../plugins/**/*.{vue,ts}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>);

const canonical = (lines: Record<string, string>) =>
  JSON.stringify(Object.fromEntries(Object.entries(lines).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + "\n";

const unused = (keys: readonly string[], texts: readonly string[]) =>
  keys.filter((k) => !texts.some((s) => s.includes(`"${k}"`) || s.includes(`'${k}'`)));

const badKeys = (keys: readonly string[]) => keys.filter((k) => !KEY.test(k));

const shippedFiles = import.meta.glob<Record<string, unknown>>(
  ["../../src/i18n/locales/*.json", "!../../src/i18n/locales/en.json"],
  { import: "default", eager: true },
);
const shippedTexts = import.meta.glob<string>(["../../src/i18n/locales/*.json", "!../../src/i18n/locales/en.json"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const glossaries = import.meta.glob<unknown>("../../src/i18n/glossary/*.json", { import: "default", eager: true });
const codeOf = (path: string) => path.replace(/^.*\/(.+)\.json$/, "$1");
const byCode = <V>(files: Record<string, V>) => Object.entries(files).map(([path, v]) => [codeOf(path), v] as const);

const keyGaps = (lines: Record<string, unknown>, english: Record<string, string>) => ({
  missing: Object.keys(english).filter((k) => !Object.hasOwn(lines, k)),
  extra: Object.keys(lines).filter((k) => !Object.hasOwn(english, k)),
});

const badTranslations = (lines: Record<string, unknown>, english: Record<string, string>) =>
  Object.entries(lines).flatMap(([key, value]) => {
    if (!Object.hasOwn(english, key)) return [];
    const reason = typeof value === "string" ? checkLine(value, english[key]!) : "not-text";
    return reason ? [{ key, reason }] : [];
  });

const GLOSSARY_TERMS = [
  ...["Language", "System", "machine translated", "file", "folder", "line"],
  ...["Stress", "Support", "Fixed", "Pinned", "Slider", "Load", "Force", "Pressure", "Own weight", "Face", "Spot"],
  ...["Mesh detail", "Coarse", "Standard", "Fine", "Material", "Custom"],
  ...["Safety factor", "Peak stress", "Deflection", "Mesh", "Inside corner", "Thin wall", "Yield", "Reaction"],
  ...["Distance", "Taper", "Thickness", "Diameter", "Depth", "Angle", "Pitch", "Count", "Radius", "Height", "Width"],
  ...["Length", "Spacing", "Tolerance", "Offset value", "New body", "Join", "Cut", "Through all", "Operation"],
  ...["Up to face", "Up to plane", "Up to point", "Counterbore", "Countersink", "Heat-set insert", "Clearance"],
  ...["Tap drill", "Blind", "Chord length", "Continuity", "Drive", "Hole type", "Wall side", "Keep originals"],
  ...["Emboss", "Engrave", "Tapped", "Drill point", "Centered", "Two sides", "Axis", "Hand", "Right", "Left"],
  ...["Flip direction", "Fit", "Inside", "Outside", "Tangent faces", "Tangent edges"],
  ...["Delete Face", "Divide Face", "Box", "Cylinder", "Cone", "Sphere", "Torus", "Duplicate", "Remove Body"],
  ...["Thin extrude", "Features", "Curve", "Plugin", "Object"],
];

function glossaryProblems(code: string, glossary: unknown): string[] {
  const g = glossary as { language?: unknown; terms?: unknown };
  const problems: string[] = [];
  if (g.language !== code) problems.push(`language ${String(g.language)}`);
  if (Object.keys(g).some((k) => k !== "language" && k !== "terms")) problems.push("unknown field");
  if (!Array.isArray(g.terms)) problems.push("no terms");
  const terms = Array.isArray(g.terms) ? (g.terms as Record<string, unknown>[]) : [];
  for (const term of terms) {
    const texts = ["en", "text"].every((k) => typeof term[k] === "string" && (term[k] as string).trim() !== "");
    const note = term.note === undefined || typeof term.note === "string";
    if (!texts || !note || Object.keys(term).some((k) => !["en", "text", "note"].includes(k))) {
      problems.push(`term ${String(term.en)}`);
    }
  }
  const named = terms.map((t) => t.en);
  for (const en of new Set(named))
    if (named.indexOf(en) !== named.lastIndexOf(en)) problems.push(`twice ${String(en)}`);
  for (const en of GLOSSARY_TERMS) if (!named.includes(en)) problems.push(`missing ${en}`);
  return problems;
}

const badLines = (lines: Record<string, string>) =>
  Object.entries(lines).flatMap(([key, value]) => {
    const reason = checkLine(value, value);
    return reason ? [{ key, reason }] : [];
  });

describe("the English file", () => {
  it("names every line area.thing", () => {
    expect(badKeys(Object.keys(en))).toEqual([]);
  });

  it("is sorted by key, two space indented, with a newline at the end", () => {
    expect(enText.replace(/\r\n/g, "\n")).toBe(canonical(en));
  });

  it("holds only lines a dropped in file could hold too", () => {
    expect(badLines(en)).toEqual([]);
  });

  it("holds no line the code never asks for", () => {
    expect(unused(Object.keys(en), sources)).toEqual([]);
  });
});

describe("the shipped languages", () => {
  it("are the table's rows, each with its file, and only English follows System so far", () => {
    expect(SHIPPED.map((l) => [l.code, l.bcp47, l.followsSystem])).toEqual([
      ["en", "en", true],
      ["de", "de", false],
      ["fr", "fr", false],
      ["es", "es", false],
      ["zh-CN", "zh-CN", false],
      ["ja", "ja", false],
    ]);
    expect(
      byCode(shippedFiles)
        .map(([code]) => code)
        .sort(),
    ).toEqual(
      SHIPPED.filter((l) => l.code !== "en")
        .map((l) => l.code)
        .sort(),
    );
  });

  it("say they are machine translated in their own words, English does not", () => {
    expect(SHIPPED.map((l) => [l.code, l.native, l.machine ?? null])).toEqual([
      ["en", "English", null],
      ["de", "Deutsch", "maschinell übersetzt"],
      ["fr", "Français", "traduction automatique"],
      ["es", "Español", "traducción automática"],
      ["zh-CN", "简体中文", "机器翻译"],
      ["ja", "日本語", "機械翻訳"],
    ]);
  });

  it.each(byCode(shippedFiles))("%s holds every English line and no other", (_code, lines) => {
    expect(keyGaps(lines, en)).toEqual({ missing: [], extra: [] });
  });

  it.each(byCode(shippedFiles))("%s holds only lines a dropped in file could hold", (_code, lines) => {
    expect(badTranslations(lines, en)).toEqual([]);
  });

  it.each(byCode(shippedTexts))("%s is sorted by key, two space indented, with a newline at the end", (_code, text) => {
    expect(text.replace(/\r\n/g, "\n")).toBe(canonical(JSON.parse(text)));
  });

  it("are complete when they follow System", () => {
    const files = Object.fromEntries(byCode(shippedFiles));
    const following = SHIPPED.filter((l) => l.followsSystem && l.code !== "en");
    expect(following.map((l) => [l.code, keyGaps(files[l.code] ?? {}, en).missing])).toEqual(
      following.map((l) => [l.code, []]),
    );
  });

  it("each have a glossary of the words they use for the language setting and the Stress setup", () => {
    const codes = SHIPPED.filter((l) => l.code !== "en").map((l) => l.code);
    expect(byCode(glossaries).map(([code, g]) => [code, glossaryProblems(code, g)])).toEqual(
      codes.sort().map((code) => [code, []]),
    );
  });
});

describe("the checks on the shipped languages", () => {
  const english = { "a.title": "Title", "a.count": "{n, plural, one {# face} other {# faces}}", "a.name": "{name}" };

  it("find a missing and an extra line, none, one or many", () => {
    expect(keyGaps({}, {})).toEqual({ missing: [], extra: [] });
    expect(keyGaps({ "a.title": "Titel", "a.gone": "Weg" }, english)).toEqual({
      missing: ["a.count", "a.name"],
      extra: ["a.gone"],
    });
  });

  it("find a broken plural, an argument English lacks, markup and a value that is not text", () => {
    const lines = {
      "a.title": 7,
      "a.count": "{n, plural, on {# Fläche} other {# Flächen}}",
      "a.name": "{name} <b>",
      "a.gone": "<i>",
    };
    expect(badTranslations(lines, english)).toEqual([
      { key: "a.title", reason: "not-text" },
      { key: "a.count", reason: "syntax" },
      { key: "a.name", reason: "markup" },
    ]);
    expect(badTranslations({ "a.name": "{body}" }, english)).toEqual([{ key: "a.name", reason: "bad-argument" }]);
    expect(badTranslations({ "a.name": "Name" }, english)).toEqual([]);
  });

  it("find a glossary for another language, a broken term, a term twice and a missing word", () => {
    const terms = GLOSSARY_TERMS.map((en) => ({ en, text: `${en} de`, note: "plain" }));
    expect(glossaryProblems("de", { language: "de", terms })).toEqual([]);
    const broken = [
      ...terms.slice(1),
      { en: "file", text: "Datei" },
      { en: "face", text: " " },
      { en: "edge", text: "Kante", tone: "x" },
      { en: "body", text: "Körper", note: 3 },
    ];
    expect(glossaryProblems("de", { language: "fr", terms: broken, status: "machine" })).toEqual([
      "language fr",
      "unknown field",
      "term face",
      "term edge",
      "term body",
      "twice file",
      "missing Language",
    ]);
    const withoutNew = terms.filter((t) => !["Safety factor", "Reaction"].includes(t.en));
    expect(glossaryProblems("de", { language: "de", terms: withoutNew })).toEqual([
      "missing Safety factor",
      "missing Reaction",
    ]);
    const feature = ["Taper", "Heat-set insert", "Tangent edges"];
    for (const [code, g] of byCode(glossaries)) {
      const real = (g as { terms: { en: string }[] }).terms;
      for (const gone of [feature.slice(0, 1), feature]) {
        const cut = { language: code, terms: real.filter((t) => !gone.includes(t.en)) };
        expect(glossaryProblems(code, cut)).toEqual(gone.map((en) => `missing ${en}`));
      }
    }
    expect(glossaryProblems("ja", { language: "ja" })).toEqual([
      "no terms",
      ...GLOSSARY_TERMS.map((t) => `missing ${t}`),
    ]);
  });
});

describe("the checks on the English file", () => {
  it("find a key that is not area.thing", () => {
    expect(badKeys(["stress.setup.title", "Stress.title", "stress", "stress..x", "stress.setup-title"])).toEqual([
      "Stress.title",
      "stress",
      "stress..x",
      "stress.setup-title",
    ]);
  });

  it("find a file out of order", () => {
    const text = '{\n  "stress.b": "B",\n  "stress.a": "A"\n}\n';
    expect(text).not.toBe(canonical(JSON.parse(text)));
    expect(canonical({ "stress.b": "B", "stress.a": "A" })).toBe('{\n  "stress.a": "A",\n  "stress.b": "B"\n}\n');
  });

  it("find markup and broken syntax", () => {
    expect(badLines({ "a.ok": "Fine {n}", "a.markup": "<b>Bold</b>", "a.broken": "Open {" })).toEqual([
      { key: "a.markup", reason: "markup" },
      { key: "a.broken", reason: "syntax" },
    ]);
  });

  it("find a line no source names in quotes", () => {
    const texts = ['t("stress.setup.title")', "t('stress.load.force', { value })", "// stress.setup.faces"];
    expect(unused(["stress.setup.title", "stress.load.force", "stress.setup.faces", "stress.gone"], texts)).toEqual([
      "stress.setup.faces",
      "stress.gone",
    ]);
  });
});
