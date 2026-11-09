import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// The app's catalog reads DEV once when it loads; a production build offers no pseudo language.
vi.hoisted(() => vi.stubEnv("DEV", false));

import LanguageCard from "../../../src/components/overlays/LanguageCard.vue";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { initLanguage, setLanguage } from "../../../src/i18n";
import { formatMessage, parseMessage, type MessageArgs } from "../../../src/i18n/format";
import { SHIPPED } from "../../../src/i18n/languages";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";
import fr from "../../../src/i18n/locales/fr.json";
import ja from "../../../src/i18n/locales/ja.json";

enableAutoUnmount(afterEach);

type Lines = Record<string, string>;
const line = (file: Lines, key: string, locale: string, args: MessageArgs = {}) =>
  formatMessage(parseMessage(file[key]!), args, locale);

async function render() {
  const w = mount(LanguageCard, { attachTo: document.body });
  await new Promise((r) => setTimeout(r, 2));
  return w;
}

const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null;
const rows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];

async function pick(lang: string | null) {
  document.querySelector<HTMLElement>("#prefs-language")!.click();
  await flushPromises();
  const row = rows().find((r) => r.querySelector(".opt-label")!.getAttribute("lang") === lang)!;
  row.click();
  await vi.waitFor(() => expect(document.documentElement.lang).toBe(lang ?? "en"));
  await flushPromises();
}

beforeEach(async () => {
  localStorage.clear();
  await initLanguage();
});

afterEach(async () => {
  await setLanguage("system");
});

describe("the Language card", () => {
  it("is the first card of Preferences, Appearance, before the theme", async () => {
    setActivePinia(createPinia());
    mount(PreferencesDialog, { attachTo: document.body });
    await flushPromises();
    const cards = [...document.querySelectorAll(".prefs-pane:first-of-type .prefs-grid > .pref-card")];
    expect(cards.slice(0, 2).map((c) => c.querySelector(".pref-head [id]")?.id)).toEqual([
      "prefs-language",
      "prefs-theme",
    ]);
  });

  it("offers System first, then English and the five machine translated languages, and no pseudo outside dev", async () => {
    const w = await render();
    const options = w.findComponent({ name: "Select" }).props("options") as {
      value: string;
      label: string;
      lang?: string;
    }[];
    expect(options.map((o) => o.value)).toEqual(["system", "en", "de", "fr", "es", "zh-CN", "ja"]);
    expect(options[0]).toEqual({
      value: "system",
      label: line(en, "prefs.language.system", "en", { name: "English" }),
    });
    expect(w.get(".select-value").text()).toBe(options[0]!.label);
  });

  it("names each language and its machine translated label in its own words, under its own lang", async () => {
    await render();
    document.querySelector<HTMLElement>("#prefs-language")!.click();
    await flushPromises();
    const labels = rows().map((r) => r.querySelector(".opt-label")!);
    const shown = labels.slice(1).map((label, i) => {
      const words = [SHIPPED[i]!.native, SHIPPED[i]!.machine];
      return [label.getAttribute("lang"), words.filter((w) => w && label.textContent!.includes(w))];
    });
    expect(shown).toEqual(SHIPPED.map((l) => [l.bcp47, [l.native, l.machine].filter(Boolean)]));
    expect([labels[0]!.getAttribute("lang"), labels[1]!.textContent]).toEqual([null, "English"]);
  });

  it("switches the card and the page lang at once, and a second language leaves none of the first", async () => {
    const w = await render();
    await pick("de");
    const german = [text(".pref-title"), text("#prefs-language-hint"), w.get(".select-value").attributes("lang")];
    expect(german).toEqual([line(de, "prefs.language.title", "de"), line(de, "prefs.language.hint", "de"), "de"]);

    await pick("fr");
    const card = w.text();
    expect([text(".pref-title"), text("#prefs-language-hint"), document.documentElement.lang]).toEqual([
      line(fr, "prefs.language.title", "fr"),
      line(fr, "prefs.language.hint", "fr"),
      "fr",
    ]);
    expect(Object.values(de).filter((v) => !v.includes("{") && card.includes(v))).toEqual([]);
  });

  it("goes back to English under System", async () => {
    const w = await render();
    await pick("ja");
    expect(text(".pref-title")).toBe(line(ja, "prefs.language.title", "ja"));
    await pick(null);
    expect([text(".pref-title"), text("#prefs-language-hint"), document.documentElement.lang]).toEqual([
      en["prefs.language.title"],
      en["prefs.language.hint"],
      "en",
    ]);
    expect(localStorage.getItem("fundacad.language")).toBe("system");
    expect(w.findComponent({ name: "Select" }).props("modelValue")).toBe("system");
  });

  it("says in the chosen language when the user's own file for it cannot be used at all", async () => {
    localStorage.setItem("fundacad.language.dropin.de", '{ "prefs.language.title": ');
    localStorage.setItem("fundacad.language.dropin.fr", "x".repeat(256 * 1024 + 1));
    localStorage.setItem("fundacad.language.dropin.ja", JSON.stringify(["prefs.language.title"]));
    localStorage.setItem("fundacad.language.dropin.es", JSON.stringify({ "prefs.language.title": "Lengua" }));
    await initLanguage();
    await render();
    const errors: (string | null)[] = [text("#prefs-language-error")];
    for (const lang of ["de", "fr", "ja", "es"]) {
      await pick(lang);
      errors.push(text("#prefs-language-error"));
    }
    expect(errors).toEqual([
      "",
      line(de, "prefs.language.error.notJson", "de"),
      line(fr, "prefs.language.error.tooLarge", "fr", { kb: 256 }),
      line(ja, "prefs.language.error.notFlat", "ja"),
      "",
    ]);
    expect(text(".pref-title")).toBe("Lengua");
    expect(document.querySelector("#prefs-language-error")!.getAttribute("role")).toBe("alert");
  });
});
