import { describe, expect, it } from "vitest";
import { MAX_OVERRIDE_BYTES, MAX_PLUGIN_LINES } from "../../src/i18n/overrides";
import { canonical, groupDisagreements, pluginProblems, type PluginFiles } from "./pluginLocaleChecks";

const localeTexts = import.meta.glob<string>("../../plugins/*/locales/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});
const sourceTexts = import.meta.glob<string>("../../plugins/*/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const manifests = import.meta.glob<string>("../../plugins/*/manifest.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const idOf = (path: string) => /plugins\/([^/]+)\//.exec(path)![1]!;

function shipped(): PluginFiles[] {
  return Object.entries(manifests).map(([path, text]) => {
    const id = idOf(path);
    const of = (files: Record<string, string>) => Object.entries(files).filter(([p]) => idOf(p) === id);
    return {
      id,
      locales: Object.fromEntries(of(localeTexts).map(([p, t]) => [/([^/]+)\.json$/.exec(p)![1]!, t])),
      sources: Object.fromEntries(of(sourceTexts)),
      translated: Object.keys((JSON.parse(text) as { translations?: object }).translations ?? {}),
    };
  });
}

const en = {
  "group.print": "Print",
  "menu.file.send": "Send to {printer}…",
  "tool.count": "{n, plural, one {# part} other {# parts}}",
};
const de = {
  "group.print": "Drucken",
  "menu.file.send": "An {printer} senden…",
  "tool.count": "{n, plural, one {# Teil} other {# Teile}}",
};
const MAIN = "plugins/Acme.Fixture/main.ts";
const code = `t("group.print"); t("menu.file.send", { printer: p }); t("tool.count", { n });`;

const good = (): PluginFiles => ({
  id: "Acme.Fixture",
  locales: { en: canonical(en), de: canonical(de) },
  sources: { [MAIN]: code },
  translated: ["de"],
});

const withLocale = (lang: string, text: string): PluginFiles => {
  const p = good();
  p.locales[lang] = text;
  return p;
};

describe("the shipped plugins' language files", () => {
  const plugins = shipped();

  it("are looked up for every plugin, with or without a locales folder", () => {
    expect(plugins.map((p) => p.id)).toContain("FundaCAD.Printing");
  });

  it.each(plugins.map((p) => [p.id, p] as const))("%s is sound", (_id, plugin) => {
    expect(pluginProblems(plugin)).toEqual([]);
  });

  it("agree on every shared group name in every language", () => {
    expect(groupDisagreements(plugins)).toEqual([]);
  });
});

describe("the plugin language checks", () => {
  it("pass a sound plugin and a plugin without a locales folder", () => {
    expect(pluginProblems(good())).toEqual([]);
    expect(pluginProblems({ id: "Acme.Bare", locales: {}, sources: {}, translated: ["de", "fr"] })).toEqual([]);
  });

  it("report a folder without en.json and an en.json that is not an object", () => {
    const p = good();
    delete p.locales.en;
    expect(pluginProblems(p)).toEqual(["en: missing"]);
    expect(pluginProblems({ ...good(), locales: { en: "[1]" } })).toEqual(["en: not an object"]);
  });

  it("report a file that is not an object or not a language code", () => {
    expect(pluginProblems(withLocale("fr", "nope"))).toEqual(["fr: not an object", "fr: no manifest translation"]);
    expect(pluginProblems(withLocale("xx_yy", canonical(de)))).toContain("xx_yy: not a language code");
  });

  it("report missing and extra keys, both at once and several", () => {
    const lines = { "group.print": "Drucken", "menu.file.new": "Neu", "menu.file.old": "Alt" };
    const found = pluginProblems({ ...good(), locales: { en: canonical(en), de: canonical(lines) } });
    expect(found.sort()).toEqual([
      "de: extra menu.file.new",
      "de: extra menu.file.old",
      "de: missing menu.file.send",
      "de: missing tool.count",
    ]);
  });

  it("report an unsorted file and a file indented four spaces", () => {
    const unsorted = JSON.stringify({ "tool.count": de["tool.count"], "group.print": "Drucken" }, null, 2) + "\n";
    expect(pluginProblems(withLocale("de", unsorted))).toContain("de: not sorted or not two space indented");
    const wide = JSON.stringify(de, null, 4) + "\n";
    expect(pluginProblems(withLocale("de", wide))).toEqual(["de: not sorted or not two space indented"]);
  });

  it("report a key that is not area.thing and a reserved plugin key", () => {
    const bad = { ...en, "Menu.file": "x", single: "y", "plugin.name": "Name" };
    const found = pluginProblems({ ...good(), locales: { en: canonical(bad) }, translated: [] });
    expect(found.filter((s) => !s.includes("unused"))).toEqual([
      "en: bad key Menu.file",
      "en: reserved key plugin.name",
      "en: bad key single",
    ]);
  });

  it("report markup, a bad argument and a broken plural against the English line", () => {
    const lines = {
      "group.print": "<b>Drucken</b>",
      "menu.file.send": "An {body} senden",
      "tool.count": "{n, plural, on {# Teil} other {# Teile}}",
    };
    expect(pluginProblems(withLocale("de", canonical(lines)))).toEqual([
      "de: line group.print is markup",
      "de: line menu.file.send is bad-argument",
      "de: line tool.count is syntax",
    ]);
    const notText = pluginProblems(withLocale("de", canonical({ ...de, "group.print": 7 })));
    expect(notText).toEqual(["de: line group.print is not-text"]);
  });

  it("report a file over the byte cap and one over the key cap, and accept the exact boundary", () => {
    const filler = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a.k${i}`, "x"]));
    const base = { id: "Acme.Big", translated: [] as string[] };
    const keysOf = (n: number) => {
      const lines = filler(n);
      return pluginProblems({ ...base, locales: { en: canonical(lines) }, sources: { [MAIN]: usedAll(lines) } });
    };
    expect(keysOf(MAX_PLUGIN_LINES)).toEqual([]);
    expect(keysOf(MAX_PLUGIN_LINES + 1)).toEqual(["en: too many lines"]);
    const text = canonical({ "a.long": "y".repeat(MAX_OVERRIDE_BYTES - 20) });
    const sources = { [MAIN]: `t("a.long");` };
    const bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBeLessThanOrEqual(MAX_OVERRIDE_BYTES);
    expect(pluginProblems({ ...base, locales: { en: text }, sources }).filter((s) => s.includes("bytes"))).toEqual([]);
    const over = canonical({ "a.long": "y".repeat(MAX_OVERRIDE_BYTES - 20 + (MAX_OVERRIDE_BYTES - bytes + 1)) });
    expect(new TextEncoder().encode(over).length).toBe(MAX_OVERRIDE_BYTES + 1);
    expect(pluginProblems({ ...base, locales: { en: over }, sources }).filter((s) => s.includes("bytes"))).toEqual([
      "en: too many bytes",
    ]);
  });

  it("report a key the code asks for that en.json lacks and a line no code asks for", () => {
    const p = good();
    p.sources[MAIN] = `${code} t("tool.ghost");`;
    expect(pluginProblems(p)).toEqual(["en: used but absent tool.ghost"]);
    p.sources[MAIN] = `t("group.print"); t("menu.file.send");`;
    expect(pluginProblems(p)).toEqual(["en: unused tool.count"]);
  });

  it("read keys from a .vue file of the plugin too", () => {
    const p = good();
    p.sources[MAIN] = `t("group.print"); t("menu.file.send");`;
    p.sources["plugins/Acme.Fixture/Panel.vue"] = `<template><p>{{ t("tool.count", { n: 3 }) }}</p></template>`;
    expect(pluginProblems(p)).toEqual([]);
  });

  it("report manifest languages that differ from the language files, both ways", () => {
    expect(pluginProblems({ ...good(), translated: [] })).toEqual(["de: no manifest translation"]);
    expect(pluginProblems({ ...good(), translated: ["de", "ja", "fr"] })).toEqual([
      "ja: manifest translation without a language file",
      "fr: manifest translation without a language file",
    ]);
  });

  it("report a shared group name that two plugins say differently, and accept the same", () => {
    const other = (word: string): PluginFiles => ({
      id: "Acme.Other",
      locales: { en: canonical({ "group.print": "Print" }), de: canonical({ "group.print": word }) },
      sources: {},
      translated: [],
    });
    expect(groupDisagreements([good(), other("Drucken")])).toEqual([]);
    expect(groupDisagreements([good(), other("Druck")])).toEqual([
      "de group.print: Acme.Fixture and Acme.Other differ",
    ]);
    expect(groupDisagreements([good()])).toEqual([]);
    expect(groupDisagreements([])).toEqual([]);
  });
});

function usedAll(lines: Record<string, unknown>): string {
  return Object.keys(lines)
    .map((k) => `t("${k}");`)
    .join("\n");
}
