import { describe, expect, it, vi } from "vitest";
import { browserDropIns, noDropIns, pickDropInSource } from "../../src/i18n/dropIns";

function storage(seed: Record<string, string>) {
  const keys = Object.keys(seed);
  return {
    getItem: vi.fn((k: string) => seed[k] ?? null),
    key: (i: number) => keys[i] ?? null,
    length: keys.length,
  };
}

describe("the browser's stored language files", () => {
  it("lists none, one and many, sorted, by their language code", async () => {
    const many = storage({
      "fundacad.language.dropin.pl": "{}",
      "fundacad.language.dropin.de": "{}",
      "fundacad.language.dropin.zh-Hant-TW": "{}",
    });
    const lists = await Promise.all([
      browserDropIns(storage({})).list(),
      browserDropIns(storage({ "fundacad.language.dropin.es-419": "{}" })).list(),
      browserDropIns(many).list(),
    ]);
    expect(lists).toEqual([[], ["es-419"], ["de", "pl", "zh-Hant-TW"]]);
  });

  it("lists no other setting and no stored name that is not a language code", async () => {
    const s = storage({
      "fundacad.language": "de",
      "fundacad.theme": "light",
      "fundacad.language.dropin.PL": "{}",
      "fundacad.language.dropin.../de": "{}",
      "fundacad.language.dropin.": "{}",
      "fundacad.language.dropin.fr": "{}",
    });
    expect(await browserDropIns(s).list()).toEqual(["fr"]);
  });

  it("reads a file by its language code, and nothing for a missing one", async () => {
    const s = storage({ "fundacad.language.dropin.fr": '{"a.b":"c"}' });
    const source = browserDropIns(s);
    expect([await source.read("fr"), await source.read("de"), source.kind]).toEqual(['{"a.b":"c"}', null, "browser"]);
  });

  it("does not touch storage for a code that is no language code", async () => {
    const s = storage({ "fundacad.language.dropin.../de": "{}" });
    expect(await browserDropIns(s).read("../de")).toBeNull();
    expect(s.getItem).not.toHaveBeenCalled();
  });
});

describe("the source of the user's language files", () => {
  const s = storage({ "fundacad.language.dropin.de": "{}" });

  it("is the browser's storage on a plain page", () => {
    expect(pickDropInSource({}, s).kind).toBe("browser");
  });

  it("is none in safe mode, in the desktop app for now, without a page and without storage", async () => {
    const kinds = [
      pickDropInSource({ __FUNDACAD_SAFE_MODE__: { reason: "flag" } }, s),
      pickDropInSource({ __TAURI_INTERNALS__: {} }, s),
      pickDropInSource(undefined, s),
      pickDropInSource({}, null),
    ];
    expect(kinds).toEqual([noDropIns, noDropIns, noDropIns, noDropIns]);
    expect([await noDropIns.list(), await noDropIns.read("de")]).toEqual([[], null]);
  });
});
