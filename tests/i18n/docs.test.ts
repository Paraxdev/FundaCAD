import { describe, expect, it } from "vitest";
import { checkLine } from "../../src/i18n/overrides";
import design from "../../docs/DESIGN.md?raw";
import doc from "../../docs/I18N.md?raw";
import readme from "../../README.md?raw";
import manual from "../../manual/docs/reference/preferences.md?raw";
import en from "../../src/i18n/locales/en.json";

const KEY = /^([A-Za-z][A-Za-z0-9.-]*:)?[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
// Only the roots globbed into repoFiles; a path under another root goes unchecked.
const REPO_PATH = /`((?:src|src-tauri\/src|scripts|tests|docs|manual\/docs|e2e)\/[^`\s<>*]+?)(?::\d+)?`/g;

// Vite writes each key relative to this file, so a file beside it comes as ./name.
const globbed = import.meta.glob([
  "../../src/**/*",
  "../../src-tauri/src/**/*",
  "../../scripts/**/*",
  "../../tests/**/*",
  "../../docs/**/*",
  "../../manual/docs/**/*",
  "../../e2e/**/*",
]);
const repoFiles = new Set(
  Object.keys(globbed).map((k) => decodeURIComponent(new URL(k, "http://repo/tests/i18n/").pathname.slice(1))),
);
const inRepo = (p: string) => (p.endsWith("/") ? [...repoFiles].some((f) => f.startsWith(p)) : repoFiles.has(p));

const missingPaths = (text: string, exists: (p: string) => boolean) =>
  [...new Set([...text.matchAll(REPO_PATH)].map((m) => m[1]!))].filter((p) => !exists(p));

// A json block whose values are all strings is language lines, held to the shipped files' rules.
function badExamples(text: string): string[] {
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
  return blocks.flatMap((block, i) => {
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch {
      return [`block ${i + 1}: not json`];
    }
    const entries = Object.entries(data as Record<string, unknown>);
    if (!entries.every(([, v]) => typeof v === "string")) return [];
    return entries.flatMap(([key, value]) => {
      const reason = KEY.test(key) ? checkLine(value as string, value as string) : "key";
      return reason ? [`${key}: ${reason}`] : [];
    });
  });
}

const voiceSection = (text: string) => text.slice(text.indexOf("## 9. Voice"), text.indexOf("## 10."));

describe("docs/I18N.md", () => {
  it("names only files that exist", () => {
    expect(missingPaths(doc, inRepo)).toEqual([]);
  });

  it("shows only lines a shipped language file could hold", () => {
    expect(badExamples(doc)).toEqual([]);
  });

  it("is linked from the wording rules and the developer notes in the README", () => {
    expect([voiceSection(design).includes("(I18N.md)"), readme.includes("(docs/I18N.md)")]).toEqual([true, true]);
  });
});

describe("the manual's Language section", () => {
  it("shows only lines FundaCAD has, each one a language file could hold", () => {
    const keys = [...manual.matchAll(/^ {2}"([^"]+)": "/gm)].map((m) => m[1]!);
    const core = keys.filter((k) => !k.includes(":"));
    const plugin = keys.filter((k) => k.includes(":"));
    expect([core.length, core.filter((k) => !Object.hasOwn(en, k)), plugin, badExamples(manual)]).toEqual([
      3,
      [],
      ["FundaCAD.Printing:menu.file.send"],
      [],
    ]);
  });
});

describe("the checks on docs/I18N.md", () => {
  const files = new Set(["src/i18n/format.ts", "scripts/check-ui-strings.mjs"]);
  const exists = (p: string) => files.has(p);

  it("find no, one or many missing files, and read past a line number and a placeholder", () => {
    expect(missingPaths("Nothing named.", exists)).toEqual([]);
    expect(missingPaths("`src/i18n/format.ts:42` and `src/i18n/locales/<code>.json`", exists)).toEqual([]);
    expect(missingPaths("`src/i18n/gone.ts:7` beside `scripts/check-ui-strings.mjs`", exists)).toEqual([
      "src/i18n/gone.ts",
    ]);
    expect(missingPaths("`tests/a.test.ts`, `docs/B.md` and `tests/a.test.ts` again", exists)).toEqual([
      "tests/a.test.ts",
      "docs/B.md",
    ]);
  });

  it("see a real file and a real folder, not a missing file or a file named as a folder", () => {
    const named = ["src-tauri/src/languages.rs", "src/i18n/locales/", "src/i18n/gone.ts", "src/i18n/format.ts/"];
    expect(named.map(inRepo)).toEqual([true, true, false, false]);
  });

  it("find broken json, a bad key, markup and a broken plural, and pass a glossary block", () => {
    const fence = (body: string) => "```json\n" + body + "\n```\n";
    expect(badExamples(fence('{ "a.b": "{n, plural, one {# face} other {# faces}}" }'))).toEqual([]);
    expect(badExamples(fence('{ "language": "de", "terms": [{ "en": "Face", "text": "<b>" }] }'))).toEqual([]);
    expect(
      badExamples(
        fence('{ "a.b": "x", ') +
          fence('{ "Bad.key": "x", "a.tag": "<b>bold</b>", "a.count": "{n, plural, one {# face}}" }'),
      ),
    ).toEqual(["block 1: not json", "Bad.key: key", "a.tag: markup", "a.count: syntax"]);
  });

  it("read only the Voice and wording section for the link", () => {
    const after = "## 9. Voice\nwords\n## 10. Themes\n(I18N.md)";
    const inside = "## 8. Motion\n## 9. Voice\nsee (I18N.md)\n## 10. Themes";
    expect([voiceSection(after).includes("(I18N.md)"), voiceSection(inside).includes("(I18N.md)")]).toEqual([
      false,
      true,
    ]);
  });
});
