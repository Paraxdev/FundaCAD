import { computed } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalog, type CatalogDeps } from "../../src/i18n/catalog";
import { browserDropIns } from "../../src/i18n/dropIns";
import type { Language } from "../../src/i18n/languages";
import { MAX_LINE_CHARS, MAX_OVERRIDE_BYTES, MAX_PLUGIN_LINES } from "../../src/i18n/overrides";
import { createPluginText } from "../../src/i18n/pluginLines";

const core = {
  "prefs.language.system": "System ({name})",
  "prefs.language.systemYours": "System, {name} (your file)",
  "prefs.language.yours": "{name} (your file)",
  "tool.extrude": "Extrude",
};
type CoreKey = keyof typeof core;

const en = {
  "tool.extrude": "Rivet",
  "menu.file.send": "Send to Printer…",
  "menu.file.count": "{count, plural, one {# part} other {# parts}}",
  "menu.file.size": "{size, number} mm",
  "menu.file.onlyEn": "Only English",
};
const de = {
  "tool.extrude": "Niete",
  "menu.file.send": "An Drucker senden…",
  "menu.file.count": "{count, plural, one {# Teil} other {# Teile}}",
  "menu.file.size": "{size, number} mm",
};
const pl = { "menu.file.send": "Wyślij do drukarki…" };

const LANGUAGES: Language[] = [
  { code: "en", native: "English", bcp47: "en", followsSystem: true },
  { code: "de", native: "Deutsch", bcp47: "de-DE", followsSystem: false },
  { code: "ja", native: "日本語", bcp47: "ja", followsSystem: false },
];

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const dropIn = (code: string, lines: Record<string, string>) => ({
  [`fundacad.language.dropin.${code}`]: JSON.stringify(lines),
});

const glob = (files: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(files).map(([code, data]) => [`./locales/${code}.json`, data]));

function make(seed: Record<string, string> = {}, o: Partial<CatalogDeps<CoreKey>> = {}) {
  const storage = memoryStorage(seed);
  const catalog = createCatalog<CoreKey>({
    english: core,
    languages: LANGUAGES,
    loaders: { "./locales/de.json": async () => ({ default: { "tool.extrude": "Ziehen" } }) },
    dropIns: browserDropIns(storage),
    storage,
    systemTags: () => [],
    dev: false,
    setPageLang: () => {},
    ...o,
  });
  const pluginText = createPluginText({ active: catalog.active, pluginDropIn: catalog.pluginDropIn });
  const rivets = pluginText<typeof en>("Acme.Rivets", glob({ en, de, pl }));
  return { catalog, pluginText, rivets };
}

// A plugin whose English holds a.b, with the given files beside it.
function loose(files: Record<string, unknown>) {
  const { catalog, pluginText } = make();
  return {
    catalog,
    text: pluginText<Record<string, string>>(
      "Acme.Rivets",
      glob({ ...files, en: { "a.b": "English", ...(files.en as object) } }),
    ),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const KEYS = ["menu.file.send", "menu.file.onlyEn", "menu.file.missing"] as never[];

describe("the lookup chain", () => {
  it("reads English before any language is set", () => {
    const { rivets } = make();
    expect(KEYS.map((k) => rivets.t(k))).toEqual(["Send to Printer…", "Only English", "menu.file.missing"]);
  });

  it("takes the user's line, then the plugin's language file, then its English, then the key", async () => {
    const seed = dropIn("de", {
      "acme.rivets:menu.file.send": "Meine Zeile",
      "Acme.Rivets:menu.file.size": "{size} Millimeter",
    });
    const { catalog, rivets } = make(seed);
    await catalog.init();
    await catalog.setLanguage("de");
    expect([...KEYS, "menu.file.size" as never].map((k) => rivets.t(k, { size: 17.5 }))).toEqual([
      "Meine Zeile",
      "Only English",
      "menu.file.missing",
      "17.5 Millimeter",
    ]);
  });

  it("takes the plugin's de for a de-AT file of the user and a pl.json for their pl.json", async () => {
    const seed = {
      ...dropIn("de-AT", { "Acme.Rivets:menu.file.onlyEn": "Nur Deutsch" }),
      ...dropIn("pl", { "Acme.Rivets:menu.file.onlyEn": "Tylko polski" }),
    };
    const { catalog, rivets } = make(seed);
    await catalog.init();
    await catalog.setLanguage("de-AT");
    expect(KEYS.slice(0, 2).map((k) => rivets.t(k))).toEqual(["An Drucker senden…", "Nur Deutsch"]);
    await catalog.setLanguage("pl");
    expect(KEYS.slice(0, 2).map((k) => rivets.t(k))).toEqual(["Wyślij do drukarki…", "Tylko polski"]);
  });

  it("falls to English for a language the plugin has no file for", async () => {
    const { catalog, rivets } = make();
    await catalog.setLanguage("ja");
    expect(rivets.t("menu.file.send")).toBe("Send to Printer…");
  });

  it("gives English from tEnglish whatever the language and the user's file", async () => {
    const { catalog, rivets } = make(dropIn("de", { "Acme.Rivets:menu.file.send": "X" }));
    await catalog.setLanguage("de");
    expect([rivets.tEnglish("menu.file.send"), rivets.tEnglish("menu.file.missing" as never)]).toEqual([
      "Send to Printer…",
      "menu.file.missing",
    ]);
  });
});

describe("a plugin key named like a core key", () => {
  it("gives the plugin's line inside the plugin and the core line in core", async () => {
    const { catalog, rivets } = make();
    await catalog.setLanguage("de");
    expect([rivets.t("tool.extrude"), catalog.t("tool.extrude")]).toEqual(["Niete", "Ziehen"]);
  });

  it("is changed by its own drop-in line only, a core line only by the core key", async () => {
    const seed = dropIn("de", { "tool.extrude": "Kern", "Acme.Rivets:tool.extrude": "Plugin" });
    const { catalog, rivets } = make(seed);
    await catalog.init();
    await catalog.setLanguage("de");
    expect([rivets.t("tool.extrude"), catalog.t("tool.extrude")]).toEqual(["Plugin", "Kern"]);
  });

  it("does not leak between two plugins with one key", async () => {
    const { catalog, pluginText } = make(dropIn("de", { "acme.rivets:menu.file.send": "Nur Rivets" }));
    const bolts = pluginText<typeof en>(
      "Zeta.Bolts",
      glob({ en: { "menu.file.send": "Bolt send" }, de: { "menu.file.send": "Bolzen" } }),
    );
    const rivets = pluginText<typeof en>("Acme.Rivets", glob({ en, de }));
    await catalog.init();
    await catalog.setLanguage("de");
    expect([rivets.t("menu.file.send"), bolts.t("menu.file.send")]).toEqual(["Nur Rivets", "Bolzen"]);
  });
});

describe("plurals and numbers", () => {
  it("use the language's rules for its own lines and English rules for the fallback", async () => {
    const { catalog, rivets } = make();
    await catalog.setLanguage("de");
    expect([1, 17, 0].map((count) => rivets.t("menu.file.count", { count }))).toEqual([
      "1 Teil",
      "17 Teile",
      "0 Teile",
    ]);
    expect(rivets.t("menu.file.size", { size: 2.5 })).toBe("2,5 mm");
    await catalog.setLanguage("ja");
    expect([1, 17].map((count) => rivets.t("menu.file.count", { count }))).toEqual(["1 part", "17 parts"]);
  });
});

describe("Pseudo", () => {
  it("stretches the plugin's English", async () => {
    const { catalog, rivets } = make({}, { dev: true });
    await catalog.setLanguage("pseudo");
    const shown = rivets.t("menu.file.send");
    expect([shown === "Send to Printer…", shown.length > "Send to Printer…".length]).toEqual([false, true]);
    expect(rivets.t("menu.file.missing" as never)).toBe("menu.file.missing");
  });
});

describe("a language switch", () => {
  it("recomputes what reads a plugin line", async () => {
    const { catalog, rivets } = make(dropIn("pl", {}));
    await catalog.init();
    const label = computed(() => rivets.t("menu.file.send"));
    expect(label.value).toBe("Send to Printer…");
    await catalog.setLanguage("de");
    expect(label.value).toBe("An Drucker senden…");
    await catalog.setLanguage("pl");
    expect(label.value).toBe("Wyślij do drukarki…");
  });
});

describe("the user's file in the store", () => {
  const file = (name: string, body: unknown) => new File([JSON.stringify(body)], name);

  it("drops a first file's plugin lines when a second file is loaded, and counts them", async () => {
    const { catalog, rivets } = make();
    expect(
      await catalog.loadDropInFile(
        file("de.json", {
          "tool.extrude": "Kern",
          "Acme.Rivets:menu.file.send": "Eins",
          "Zeta.Bolts:menu.file.send": "Zwei",
        }),
      ),
    ).toBeNull();
    expect([rivets.t("menu.file.send"), catalog.dropInStatus()?.lines]).toEqual(["Eins", 3]);
    expect(await catalog.loadDropInFile(file("ja.json", { "tool.extrude": "Kern" }))).toBeNull();
    expect([rivets.t("menu.file.send"), catalog.dropInStatus()?.lines, catalog.pluginDropIn().size]).toEqual([
      "Send to Printer…",
      1,
      0,
    ]);
    await catalog.setLanguage("de");
    expect([rivets.t("menu.file.send"), catalog.dropInStatus()?.lines]).toEqual(["Eins", 3]);
  });

  it("lists a refused plugin line and ignores a __proto__ plugin key", async () => {
    const { catalog, rivets } = make();
    await catalog.loadDropInFile(
      new File(
        ['{"Acme.Rivets:menu.file.send": "<b>", "Acme.Rivets:__proto__.x": "T", "Acme.Rivets:menu.file.onlyEn": "Ok"}'],
        "de.json",
      ),
    );
    expect(catalog.dropInStatus()?.skipped).toEqual([
      { key: "Acme.Rivets:menu.file.send", reason: "markup" },
      { key: "Acme.Rivets:__proto__.x", reason: "unknown-key" },
    ]);
    expect([rivets.t("menu.file.send"), rivets.t("menu.file.onlyEn")]).toEqual(["An Drucker senden…", "Ok"]);
  });

  it("skips a user's line using a value the plugin's English does not have, at lookup", async () => {
    const { catalog, rivets } = make(dropIn("de", { "Acme.Rivets:menu.file.send": "Hallo {who}" }));
    await catalog.init();
    await catalog.setLanguage("de");
    expect(rivets.t("menu.file.send")).toBe("An Drucker senden…");
  });
});

describe("the limits on a plugin's own files", () => {
  it("keeps a line of exactly the character limit and drops one more, with a warning", async () => {
    const { catalog, text } = loose({
      de: { "a.b": "x".repeat(MAX_LINE_CHARS), "a.c": "x".repeat(MAX_LINE_CHARS + 1) },
    });
    await catalog.setLanguage("de");
    expect([text.t("a.b").length, text.t("a.c")]).toEqual([MAX_LINE_CHARS, "a.c"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reads a file of exactly the key limit and ignores one key more", async () => {
    const letters = "abcdefghij";
    const keyOf = (i: number) => `k.${[...String(i)].map((d) => letters[+d]).join("")}`;
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [keyOf(i), "T"]));
    const full = keys(MAX_PLUGIN_LINES);
    const over = keys(MAX_PLUGIN_LINES + 1);
    expect([Object.keys(full).length, Object.keys(over).length]).toEqual([2000, 2001]);
    const { catalog, text } = loose({ de: full, ja: over });
    await catalog.setLanguage("de");
    expect([text.t(keyOf(0)), text.t(keyOf(1999))]).toEqual(["T", "T"]);
    await catalog.setLanguage("ja");
    expect([text.t(keyOf(0)), text.t("a.b")]).toEqual([keyOf(0), "English"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reads a file of exactly the byte limit and ignores one byte more", async () => {
    const size = (lines: object) => new TextEncoder().encode(JSON.stringify(lines)).length;
    // Lines of 1900 characters stay under the line limit, the last one is padded to the exact size.
    const sized = (target: number) => {
      const lines: Record<string, string> = {};
      for (let i = 0; size(lines) + 1900 + 12 < target; i++)
        lines[`k.${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)]}`] =
          "x".repeat(1900);
      lines["a.b"] = "";
      lines["a.b"] = "x".repeat(target - size(lines));
      return lines;
    };
    const atLimit = sized(MAX_OVERRIDE_BYTES);
    const over = sized(MAX_OVERRIDE_BYTES + 1);
    expect([size(atLimit), size(over)]).toEqual([MAX_OVERRIDE_BYTES, MAX_OVERRIDE_BYTES + 1]);
    const { catalog, text } = loose({ de: atLimit, ja: over });
    await catalog.setLanguage("de");
    expect(text.t("a.b")).toBe(atLimit["a.b"]);
    await catalog.setLanguage("ja");
    expect(text.t("a.b")).toBe("English");
  });

  it("drops each bad line to the next source and keeps a good sibling, with one warning", async () => {
    const { catalog, text } = loose({
      en: { "a.extra": "Hello" },
      de: {
        "a.b": "Gut",
        "a.markup": "<b>x</b>",
        "a.control": "x\u0007",
        "a.empty": "   ",
        "a.syntax": "{n, plural, one {x",
        "a.extra": "Hallo {who}",
        "Bad.Key": "T",
        "a.num": 5,
      },
    });
    await catalog.setLanguage("de");
    const keys = ["a.b", "a.markup", "a.control", "a.empty", "a.syntax", "a.extra", "Bad.Key", "a.num"];
    expect(keys.map((k) => text.t(k, { who: 3 }))).toEqual(["Gut", ...keys.slice(1, 5), "Hello", ...keys.slice(6)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toEqual(keys.slice(1));
  });

  it("ignores a path whose code is not a language code, and a file that is not an object", async () => {
    const { catalog, pluginText } = make();
    const text = pluginText<Record<string, string>>("Acme.Rivets", {
      "./locales/en.json": { "a.b": "English" },
      "./locales/DE.json": { "a.b": "Upper" },
      "./locales/de.json": ["a.b"],
      "./locales/ja.json": "text",
      "./locales/readme.txt": { "a.b": "Txt" },
    });
    for (const code of ["de", "ja", "DE"]) {
      await catalog.setLanguage(code);
      expect(text.t("a.b")).toBe("English");
    }
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]).includes("not a JSON object"))).toEqual([true, true]);
  });

  it("warns once that a lazy glob is not loaded and falls back, for English and for one language", async () => {
    const { catalog, pluginText } = make();
    const lazy = () => Promise.resolve({ default: { "a.b": "Lazy" } });
    const half = pluginText<Record<string, string>>("Acme.Rivets", {
      "./locales/en.json": { "a.b": "English" },
      "./locales/de.json": lazy,
    });
    const none = pluginText<Record<string, string>>("Acme.Gaskets", { "./locales/en.json": lazy });
    await catalog.setLanguage("de");
    expect([half.t("a.b"), half.t("a.b"), none.t("a.b"), none.t("a.b")]).toEqual(["English", "English", "a.b", "a.b"]);
    expect(warn.mock.calls.map((c: unknown[]) => [String(c[0]).includes("eager"), String(c[0]).includes("Gaskets")])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("never throws without any files", () => {
    const { pluginText } = make();
    expect(pluginText<Record<string, string>>("Acme.Rivets", {}).t("a.b")).toBe("a.b");
  });
});
