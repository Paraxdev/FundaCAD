import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// The app's catalog reads DEV once when it loads; a production build offers no pseudo language.
vi.hoisted(() => vi.stubEnv("DEV", false));

import LanguageCard from "../../../src/components/overlays/LanguageCard.vue";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { initLanguage, languageFileStatus, languageSetting, setLanguage } from "../../../src/i18n";
import { formatMessage, parseMessage, type MessageArgs } from "../../../src/i18n/format";
import { SHIPPED } from "../../../src/i18n/languages";
import de from "../../../src/i18n/locales/de.json";
import en from "../../../src/i18n/locales/en.json";
import es from "../../../src/i18n/locales/es.json";
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
  const row = rows().find(
    (r) => (r.querySelector(".opt-label[lang], .opt-label [lang]")?.getAttribute("lang") ?? null) === lang,
  )!;
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

  it("says machine translated text may read oddly only under a machine translated language", async () => {
    await render();
    const shown = () => [
      text("#prefs-language-hint"),
      document.querySelector("#prefs-language")!.getAttribute("aria-describedby"),
    ];
    const english = shown();
    await pick("es");
    const spanish = shown();
    await pick("en");
    expect([english, spanish, shown()]).toEqual([
      [null, null],
      [line(es, "prefs.language.hint", "es"), "prefs-language-hint"],
      [null, null],
    ]);
  });

  it("goes back to English under System", async () => {
    const w = await render();
    await pick("ja");
    expect(text(".pref-title")).toBe(line(ja, "prefs.language.title", "ja"));
    await pick(null);
    expect([text(".pref-title"), text("#prefs-language-hint"), document.documentElement.lang]).toEqual([
      en["prefs.language.title"],
      null,
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
    const errors: (string | null)[][] = [[text("#prefs-language-error"), text(".prefs-language-status")]];
    for (const lang of ["de", "fr", "ja", "es"]) {
      await pick(lang);
      errors.push([text("#prefs-language-error"), text(".prefs-language-status")]);
    }
    expect(errors).toEqual([
      ["", ""],
      [line(de, "prefs.language.error.notJson", "de", { line: 1, column: 27 }), ""],
      [line(fr, "prefs.language.error.tooLarge", "fr", { kb: 256 }), ""],
      [line(ja, "prefs.language.error.notFlat", "ja"), ""],
      ["", line(es, "prefs.language.inUse", "es", { n: 1 })],
    ]);
    expect(text(".pref-title")).toBe("Lengua");
    expect(document.querySelector("#prefs-language-error")!.getAttribute("role")).toBe("alert");
  });
});

describe("the user's own file in the browser", () => {
  let picker: HTMLInputElement | null = null;
  const json = (name: string, body: unknown) =>
    new File([typeof body === "string" ? body : JSON.stringify(body)], name, { type: "application/json" });
  const buttons = () => [...document.querySelectorAll(".prefs-actions button")].map((b) => b.textContent!.trim());
  const status = () => [...document.querySelectorAll(".prefs-language-status p")].map((p) => p.textContent!.trim());
  const listed = () => [...document.querySelectorAll(".prefs-language-skipped li")].map((li) => li.textContent!.trim());
  const dropIns = () => Object.keys(localStorage).filter((k) => k.startsWith("fundacad.language.dropin."));

  beforeEach(() => {
    picker = null;
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      picker = this;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function load(file: File) {
    document.querySelector<HTMLElement>(".prefs-language-load")!.click();
    await vi.waitFor(() => expect(picker?.accept).toBe("application/json,.json"));
    Object.defineProperty(picker!, "files", { value: [file], configurable: true });
    picker!.dispatchEvent(new Event("change"));
    picker = null;
  }

  it("uses the good lines of a file, lists each skipped one with its reason, and Remove brings the shipped lines back", async () => {
    await render();
    expect([buttons(), text(".prefs-language-file-hint")]).toEqual([
      [en["prefs.language.load"]],
      en["prefs.language.fileHint"],
    ]);
    await load(
      json("de.json", {
        "prefs.language.title": "Meine Sprache",
        "prefs.language.hint": "<b>Tipp</b>",
        "x.y": "z",
        "prefs.language.more": "und {nummer, number} weitere",
      }),
    );
    await vi.waitFor(() => expect(text(".pref-title")).toBe("Meine Sprache"));
    expect(languageFileStatus()).toEqual({
      lines: 1,
      skipped: [
        { key: "prefs.language.hint", reason: "markup" },
        { key: "x.y", reason: "unknown-key" },
        { key: "prefs.language.more", reason: "bad-argument", arg: "nummer" },
      ],
    });
    expect([
      languageSetting(),
      text("#prefs-language-hint"),
      status(),
      listed(),
      buttons(),
      text("#prefs-language-error"),
    ]).toEqual([
      "de",
      line(de, "prefs.language.hint", "de"),
      [line(de, "prefs.language.inUse", "de", { n: 1 }), line(de, "prefs.language.skipped", "de", { n: 3 })],
      [
        line(de, "prefs.language.skip", "de", { key: "prefs.language.hint", reason: "markup", tag: "<b>" }),
        line(de, "prefs.language.skip", "de", { key: "x.y", reason: "unknownKey" }),
        line(de, "prefs.language.skip", "de", { key: "prefs.language.more", reason: "badArgument", arg: "{nummer}" }),
      ],
      [line(de, "prefs.language.load", "de"), line(de, "prefs.language.remove", "de")],
      "",
    ]);

    document.querySelector<HTMLElement>(".prefs-language-remove")!.click();
    await vi.waitFor(() => expect(text(".pref-title")).toBe(line(de, "prefs.language.title", "de")));
    expect([languageFileStatus(), text(".prefs-language-status"), buttons(), dropIns(), languageSetting()]).toEqual([
      null,
      "",
      [line(de, "prefs.language.load", "de")],
      [],
      "de",
    ]);
  });

  it("shows five skipped lines and counts the rest, with no line in use, and a key's control characters replaced", async () => {
    const keys = ["a\u202Eb.c", "k.one", "k.two", "k.three", "k.four", "k.five", "k.six"];
    await render();
    await load(json("en.json", Object.fromEntries(keys.map((k) => [k, "x"]))));
    await vi.waitFor(() => expect(listed()).toHaveLength(6));
    const skip = (key: string) => line(en, "prefs.language.skip", "en", { key, reason: "unknownKey", max: 2000 });
    expect([status(), listed()]).toEqual([
      [line(en, "prefs.language.inUse", "en", { n: 0 }), line(en, "prefs.language.skipped", "en", { n: 7 })],
      [skip("a\uFFFDb.c"), ...keys.slice(1, 5).map(skip), line(en, "prefs.language.more", "en", { n: 2 })],
    ]);
  });

  it("skips an empty or blank line and says so plainly", async () => {
    await render();
    await load(json("en.json", { "prefs.language.title": "", "prefs.language.reload": "  " }));
    await vi.waitFor(() => expect(listed()).toHaveLength(2));
    expect([text(".pref-title"), listed()]).toEqual([
      en["prefs.language.title"],
      ["prefs.language.title: is empty", "prefs.language.reload: is empty"],
    ]);
  });

  it("names a shipped language as the user's file once a file for it is in use", async () => {
    await render();
    await pick("de");
    const before = text(".select-value");
    await load(json("de.json", { "prefs.language.title": "Meine Sprache" }));
    await vi.waitFor(() => expect(text(".pref-title")).toBe("Meine Sprache"));
    const name = document.querySelector(".select-value [lang]");
    expect([before, text(".select-value"), name?.getAttribute("lang"), name?.textContent]).toEqual([
      "Deutsch (maschinell übersetzt)",
      line(de, "prefs.language.yours", "de", { name: "Deutsch (maschinell übersetzt)" }),
      "de",
      "Deutsch (maschinell übersetzt)",
    ]);
  });

  it("keeps the lines that tell about the file as shipped, and says why", async () => {
    await render();
    await load(json("en.json", { "prefs.language.inUse": "All fine.", "prefs.language.title": "Words" }));
    await vi.waitFor(() => expect(listed()).toHaveLength(1));
    expect([text(".pref-title"), status(), listed()]).toEqual([
      "Words",
      [line(en, "prefs.language.inUse", "en", { n: 1 }), line(en, "prefs.language.skipped", "en", { n: 1 })],
      ["prefs.language.inUse: tells you about your file, so a file cannot change it"],
    ]);
  });

  it("replaces a first file of a language wholly with a second one", async () => {
    await render();
    await load(json("de.json", { "prefs.language.title": "Erste Sprache" }));
    await vi.waitFor(() => expect(text(".pref-title")).toBe("Erste Sprache"));
    const second = { "prefs.language.hint": "Zweiter Hinweis" };
    await load(json("de.json", second));
    await vi.waitFor(() => expect(text("#prefs-language-hint")).toBe("Zweiter Hinweis"));
    expect([text(".pref-title"), localStorage.getItem("fundacad.language.dropin.de"), languageFileStatus()]).toEqual([
      line(de, "prefs.language.title", "de"),
      JSON.stringify(second),
      { lines: 1, skipped: [] },
    ]);
  });

  it("never shows a German file's lines or status under French", async () => {
    const w = await render();
    await load(json("de.json", { "prefs.language.title": "Meine Sprache", "x.y": "z" }));
    await vi.waitFor(() => expect(text(".pref-title")).toBe("Meine Sprache"));
    await pick("fr");
    expect([
      text(".pref-title"),
      text(".prefs-language-status"),
      buttons(),
      w.text().includes("Meine Sprache"),
    ]).toEqual([line(fr, "prefs.language.title", "fr"), "", [line(fr, "prefs.language.load", "fr")], false]);
    await pick("de");
    expect(text(".pref-title")).toBe("Meine Sprache");
  });

  it("adds a language FundaCAD does not ship as the user's own file, the rest in English", async () => {
    const w = await render();
    await load(json("pl.json", { "prefs.language.title": "Język" }));
    await vi.waitFor(() => expect(document.documentElement.lang).toBe("pl"));
    await flushPromises();
    const options = w.findComponent({ name: "Select" }).props("options") as { value: string }[];
    expect([
      options.at(-1),
      languageSetting(),
      text(".pref-title"),
      text("#prefs-language-hint"),
      w.get(".select-value").attributes("lang"),
      w.findAll(".select-value span").map((s) => [s.text(), s.attributes("lang")]),
    ]).toEqual([
      {
        value: "pl",
        label: line(en, "prefs.language.yours", "en", { name: "polski" }),
        parts: [{ text: "polski", lang: "pl" }, { text: line(en, "prefs.language.yours", "en", { name: "" }) }],
      },
      "pl",
      "Język",
      null,
      undefined,
      [
        ["polski", "pl"],
        [line(en, "prefs.language.yours", "en", { name: "" }).trim(), undefined],
      ],
    ]);
  });

  it("takes a picked pl.json.txt as pl.json, and a plain bad name is still refused", async () => {
    await render();
    await load(json("pl.json.txt", { "prefs.language.title": "Język" }));
    await vi.waitFor(() => expect(document.documentElement.lang).toBe("pl"));
    await flushPromises();
    const taken = [dropIns(), languageSetting(), text(".pref-title"), text("#prefs-language-error")];
    await load(json("Polish.json", { "prefs.language.title": "Język" }));
    await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(line(en, "prefs.language.error.badName", "en")));
    expect([taken, dropIns(), languageSetting()]).toEqual([
      [["fundacad.language.dropin.pl"], "pl", "Język", ""],
      ["fundacad.language.dropin.pl"],
      "pl",
    ]);
  });

  it("refuses a file not named by a language code, and a pick clears the message", async () => {
    await render();
    await load(json("Polish.json", { "prefs.language.title": "Język" }));
    await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(line(en, "prefs.language.error.badName", "en")));
    expect([dropIns(), languageSetting()]).toEqual([[], "system"]);
    await pick("es");
    expect(text("#prefs-language-error")).toBe("");
  });

  it("loads a file of exactly 256 KB and refuses one byte more before reading it", async () => {
    await render();
    const head = '{"prefs.language.title":"Größe"';
    const pad = 256 * 1024 - new TextEncoder().encode(head + "}").length;
    const over = json("de.json", head + " ".repeat(pad + 1) + "}");
    const read = vi.spyOn(over, "text");
    await load(over);
    const tooLarge = line(en, "prefs.language.error.pickedTooLarge", "en", { kb: 256 });
    await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(tooLarge));
    expect([over.size, read.mock.calls.length, dropIns()]).toEqual([262145, 0, []]);
    await load(json("de.json", head + " ".repeat(pad) + "}"));
    await vi.waitFor(() => expect(text(".pref-title")).toBe("Größe"));
    expect([text("#prefs-language-error"), localStorage.getItem("fundacad.language.dropin.de")!.length]).toEqual([
      "",
      262144 - 2,
    ]);
  });

  it("says a refused pick is the picked file, the file before staying in use", async () => {
    await render();
    await load(json("de.json", { "prefs.language.title": "Meine Sprache" }));
    await vi.waitFor(() => expect(text(".pref-title")).toBe("Meine Sprache"));
    const kept = localStorage.getItem("fundacad.language.dropin.de");
    const notJson = line(de, "prefs.language.error.pickedNotJson", "de", { line: 1, column: 27 });
    const notFlat = line(de, "prefs.language.error.pickedNotFlat", "de");
    const shown: (string | null)[][] = [];
    for (const [body, error] of [
      ['{ "prefs.language.title": ', notJson],
      [{ "prefs.language.title": { de: "Sprache" } }, notFlat],
    ] as const) {
      await load(json("de.json", body));
      await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(error));
      shown.push([text(".prefs-language-status"), text(".pref-title")]);
    }
    const inUse = line(de, "prefs.language.inUse", "de", { n: 1 });
    expect([shown, localStorage.getItem("fundacad.language.dropin.de")]).toEqual([
      [
        [inUse, "Meine Sprache"],
        [inUse, "Meine Sprache"],
      ],
      kept,
    ]);
  });

  it("skips a markup line put in storage by hand at the next start", async () => {
    localStorage.setItem("fundacad.language.dropin.de", JSON.stringify({ "prefs.language.title": "<b>Sprache</b>" }));
    localStorage.setItem("fundacad.language", "de");
    await initLanguage();
    await render();
    expect([languageFileStatus(), text(".pref-title"), listed()]).toEqual([
      { lines: 0, skipped: [{ key: "prefs.language.title", reason: "markup" }] },
      line(de, "prefs.language.title", "de"),
      [line(de, "prefs.language.skip", "de", { key: "prefs.language.title", reason: "markup", tag: "<b>" })],
    ]);
  });

  it("says so when the browser's storage refuses the file, and keeps the language", async () => {
    await render();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await load(json("de.json", { "prefs.language.title": "Meine Sprache" }));
    await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(line(en, "prefs.language.error.storage", "en")));
    expect([languageSetting(), text(".pref-title"), dropIns()]).toEqual(["system", en["prefs.language.title"], []]);
  });
});
