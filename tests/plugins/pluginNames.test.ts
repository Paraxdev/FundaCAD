import { beforeEach, describe, expect, it, vi } from "vitest";
import { computed } from "vue";
import type { createCatalog } from "../../src/i18n/catalog";
import { parseManifest, type PluginManifest } from "../../src/plugins/manifest";
import { pluginName, pluginSummary, shippedPluginName } from "../../src/plugins/pluginNames";
import * as i18n from "../../src/i18n";

vi.mock("../../src/i18n", async () => {
  const { createCatalog } = await import("../../src/i18n/catalog");
  const { browserDropIns } = await import("../../src/i18n/dropIns");
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  const catalog = createCatalog<"tool.extrude">({
    english: {
      "tool.extrude": "Extrude",
      "prefs.language.system": "System",
      "prefs.language.systemYours": "System",
      "prefs.language.yours": "Yours",
    },
    languages: [
      { code: "en", native: "English", bcp47: "en", followsSystem: true },
      { code: "de", native: "Deutsch", bcp47: "de-DE", followsSystem: false },
      { code: "de-AT", native: "Deutsch (Österreich)", bcp47: "de-AT", followsSystem: false },
      { code: "fr", native: "Français", bcp47: "fr-FR", followsSystem: false },
      { code: "pl", native: "Polski", bcp47: "pl", followsSystem: false },
    ],
    loaders: {},
    dropIns: browserDropIns(storage),
    storage,
    systemTags: () => [],
    dev: true,
    setPageLang: () => {},
  });
  return { activeLanguage: catalog.active, pluginDropInLines: catalog.pluginDropIn, catalog };
});

const catalog = (i18n as unknown as { catalog: ReturnType<typeof createCatalog<"tool.extrude">> }).catalog;
const file = (name: string, body: unknown) => new File([JSON.stringify(body)], name);

const manifest = (extra: object = {}): PluginManifest => {
  const res = parseManifest({
    id: "Acme.Rivets",
    name: "Rivet shop",
    version: "1.2.3",
    kind: "process",
    summary: "Sets 17 rivets at a slant.",
    grants: ["document.read"],
    translations: {
      de: { name: "Nietenwerk", summary: "Setzt 17 Nieten schräg." },
      fr: { name: "Atelier de rivets" },
    },
    ...extra,
  });
  if (!res.ok) throw new Error(res.why);
  return res.manifest;
};

const both = (m: PluginManifest) => [pluginName(m), pluginSummary(m)];

beforeEach(async () => {
  await catalog.setLanguage("en");
  await catalog.loadDropInFile(file("en.json", { "tool.extrude": "Extrude" }));
});

describe("plugin names and summaries follow the language", () => {
  it("reads the manifest in English, German, de-AT, and a language with no entry", async () => {
    const m = manifest();
    expect(both(m)).toEqual(["Rivet shop", "Sets 17 rivets at a slant."]);
    await catalog.setLanguage("de");
    expect(both(m)).toEqual(["Nietenwerk", "Setzt 17 Nieten schräg."]);
    await catalog.setLanguage("de-AT");
    expect(both(m)).toEqual(["Nietenwerk", "Setzt 17 Nieten schräg."]);
    await catalog.setLanguage("pl");
    expect(both(m)).toEqual(["Rivet shop", "Sets 17 rivets at a slant."]);
  });

  it("falls back per field, a name without a summary keeps the English summary", async () => {
    await catalog.setLanguage("fr");
    expect(both(manifest())).toEqual(["Atelier de rivets", "Sets 17 rivets at a slant."]);
  });

  it("a manifest without translations reads English everywhere", async () => {
    await catalog.setLanguage("de");
    expect(both(manifest({ translations: undefined }))).toEqual(["Rivet shop", "Sets 17 rivets at a slant."]);
  });

  it("a user's line wins, case insensitive on the id, and a second file brings the manifest back", async () => {
    const m = manifest();
    await catalog.setLanguage("de");
    await catalog.loadDropInFile(
      file("de.json", { "acme.RIVETS:plugin.name": "Meine Nieten", "Zeta.Bolts:plugin.name": "Falsch" }),
    );
    expect(both(m)).toEqual(["Meine Nieten", "Setzt 17 Nieten schräg."]);
    await catalog.loadDropInFile(file("de.json", { "Acme.Rivets:plugin.summary": "Mein Text" }));
    expect(both(m)).toEqual(["Nietenwerk", "Mein Text"]);
    await catalog.loadDropInFile(file("de.json", { "tool.extrude": "Kern" }));
    expect(both(m)).toEqual(["Nietenwerk", "Setzt 17 Nieten schräg."]);
  });

  it("stretches the manifest English under Pseudo, not a translation", async () => {
    await catalog.setLanguage("pseudo");
    expect(both(manifest())).toEqual(["[Ríívéétt shööpp]", "[Séétss 17 ríívéétss áátt áá slááññtt.]"]);
  });

  it("a computed follows a live switch", async () => {
    const shown = computed(() => pluginName(manifest()));
    expect(shown.value).toBe("Rivet shop");
    await catalog.setLanguage("de");
    expect(shown.value).toBe("Nietenwerk");
    await catalog.setLanguage("fr");
    expect(shown.value).toBe("Atelier de rivets");
  });

  it("names a shipped plugin in the language and an unknown id by itself", async () => {
    expect(shippedPluginName("FundaCAD.Onshape")).toBe("Onshape link");
    await catalog.setLanguage("de");
    expect(shippedPluginName("FundaCAD.Onshape")).toBe("Onshape-Link");
    expect(shippedPluginName("Nobody.Here")).toBe("Nobody.Here");
  });
});
