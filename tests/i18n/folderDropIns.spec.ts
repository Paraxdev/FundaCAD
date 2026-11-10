// The desktop app's own language files: the page asks Rust for them by language code alone, never by path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const tauri = vi.hoisted(() => {
  vi.stubEnv("DEV", false);
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return { files: new Map<string, string>(), invoke: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import LanguageCard from "../../src/components/overlays/LanguageCard.vue";
import { initLanguage, languageChoices, languageFileStatus, languageSetting, setLanguage, t } from "../../src/i18n";
import { createCatalog, type DropInSource } from "../../src/i18n/catalog";
import { folderDropIns, pickDropInSource } from "../../src/i18n/dropIns";
import { formatMessage, parseMessage, type MessageArgs } from "../../src/i18n/format";
import { SHIPPED } from "../../src/i18n/languages";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import fr from "../../src/i18n/locales/fr.json";

enableAutoUnmount(afterEach);

type Lines = Record<string, string>;
const line = (file: Lines, key: string, locale: string, args: MessageArgs = {}) =>
  formatMessage(parseMessage(file[key]!), args, locale);

async function folder(cmd: string, args?: { code?: string }): Promise<unknown> {
  if (cmd === "language_files_list") return [...tauri.files.keys()].sort();
  if (cmd === "language_file_read") return tauri.files.get(args!.code!) ?? null;
  if (cmd === "language_folder_open") return undefined;
  throw new Error(`unexpected ${cmd}`);
}

function answer(cmd: string, reply: (args?: { code?: string }) => Promise<unknown>) {
  tauri.invoke.mockImplementation((c: string, args?: { code?: string }) => (c === cmd ? reply(args) : folder(c, args)));
}

const after = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (code: string, lines: Lines) => tauri.files.set(code, JSON.stringify(lines));
const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null;
const buttons = () => [...document.querySelectorAll(".prefs-actions button")].map((b) => b.textContent!.trim());
const status = () => [...document.querySelectorAll(".prefs-language-status p")].map((p) => p.textContent!.trim());
const click = (sel: string) => document.querySelector<HTMLElement>(sel)!.click();

// The app's own catalog loads a shipped file through a real import, which fake timers cannot wait for.
const catalog = (dropIns: DropInSource) =>
  createCatalog({
    english: en,
    languages: SHIPPED,
    loaders: { "./locales/de.json": async () => ({ default: de }) },
    dropIns,
    storage: localStorage,
    systemTags: () => ["de-DE"],
    dev: false,
    setPageLang: () => {},
  });

async function start(stored?: string) {
  localStorage.clear();
  if (stored) localStorage.setItem("fundacad.language", stored);
  tauri.invoke.mockClear();
  await initLanguage();
}

async function render() {
  const w = mount(LanguageCard, { attachTo: document.body });
  await flushPromises();
  return w;
}

beforeEach(() => {
  tauri.files.clear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(folder);
});

afterEach(async () => {
  vi.useRealTimers();
  delete window.__FUNDACAD_SAFE_MODE__;
  tauri.files.clear();
  tauri.invoke.mockImplementation(folder);
  await start();
});

describe("the desktop app's language folder at the start", () => {
  it("reads only the stored language's file, by its code alone, out of many in the folder", async () => {
    put("de", { "prefs.language.title": "Meine Sprache" });
    put("fr", { "prefs.language.title": "Ma langue" });
    put("pl", { "prefs.language.title": "Mój język" });
    await start("de");
    expect([
      tauri.invoke.mock.calls,
      t("prefs.language.title"),
      languageFileStatus(),
      document.documentElement.lang,
    ]).toEqual([
      [["language_files_list"], ["language_file_read", { code: "de" }]],
      "Meine Sprache",
      { lines: 1, skipped: [] },
      "de",
    ]);
  });

  it("reads no file under System when the folder holds none for English, and en.json when it does", async () => {
    put("de", { "prefs.language.title": "Meine Sprache" });
    await start();
    const without = [...tauri.invoke.mock.calls];
    put("en", { "prefs.language.title": "My language" });
    await start();
    expect([without, tauri.invoke.mock.calls, t("prefs.language.title")]).toEqual([
      [["language_files_list"]],
      [["language_files_list"], ["language_file_read", { code: "en" }]],
      "My language",
    ]);
  });

  it("lists a language FundaCAD does not ship as the user's own, and never asks for a name that is no language code", async () => {
    put("pl", { "prefs.language.title": "Mój język" });
    answer("language_files_list", async () => ["pl", "PL", "../x", "de", "pl"]);
    await start("pl");
    expect([
      languageChoices().filter((c) => !SHIPPED.some((l) => l.code === c.value) && c.value !== "system"),
      tauri.invoke.mock.calls,
      t("prefs.language.title"),
      t("prefs.language.hint"),
      document.documentElement.lang,
    ]).toEqual([
      [{ value: "pl", label: "polski (your file)", parts: [{ text: "polski", lang: "pl" }, { text: " (your file)" }] }],
      [["language_files_list"], ["language_file_read", { code: "pl" }]],
      "Mój język",
      en["prefs.language.hint"],
      "pl",
    ]);
  });

  it("asks Rust for a language code only, and for none of a name that is not one", async () => {
    put("de-AT", { "prefs.language.title": "Meine Sprache" });
    const read = await Promise.all(["de-AT", "../de", "PL", "de/../fr", ""].map((code) => folderDropIns.read(code)));
    expect([read, tauri.invoke.mock.calls]).toEqual([
      [JSON.stringify({ "prefs.language.title": "Meine Sprache" }), null, null, null, null],
      [["language_file_read", { code: "de-AT" }]],
    ]);
  });

  it("shows the shipped lines and says so when Rust refuses the file, and init never rejects", async () => {
    put("de", { "prefs.language.title": "Meine Sprache" });
    answer("language_file_read", () => Promise.reject("de.json is larger than 262144 bytes"));
    localStorage.setItem("fundacad.language", "de");
    await expect(initLanguage()).resolves.toBeUndefined();
    await render();
    expect([t("prefs.language.title"), languageFileStatus(), status(), text("#prefs-language-error")]).toEqual([
      line(de, "prefs.language.title", "de"),
      { lines: 0, skipped: [], error: "not-read" },
      [],
      line(de, "prefs.language.error.notRead", "de"),
    ]);
  });

  it("starts in the stored shipped language when the folder cannot be listed, reading nothing", async () => {
    put("de", { "prefs.language.title": "Meine Sprache" });
    answer("language_files_list", () => Promise.reject(new Error("denied")));
    localStorage.setItem("fundacad.language", "de");
    tauri.invoke.mockClear();
    await expect(initLanguage()).resolves.toBeUndefined();
    expect([tauri.invoke.mock.calls, t("prefs.language.title"), languageFileStatus()]).toEqual([
      [["language_files_list"]],
      line(de, "prefs.language.title", "de"),
      null,
    ]);
  });

  it("uses a file read within 2 s and starts without one that takes longer", async () => {
    put("de", { "prefs.language.title": "Meine Sprache" });
    localStorage.setItem("fundacad.language", "de");
    await folderDropIns.list();
    vi.useFakeTimers();
    async function startWithReadOf(ms: number) {
      answer("language_file_read", async (args) => (await after(ms), folder("language_file_read", args)));
      const c = catalog(folderDropIns);
      let done = false;
      void c.init().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1999);
      const early = done;
      await vi.advanceTimersByTimeAsync(1);
      return [early, done, c.t("prefs.language.title"), c.dropInStatus()];
    }
    expect([await startWithReadOf(1999), await startWithReadOf(2001), await startWithReadOf(60_000)]).toEqual([
      [true, true, "Meine Sprache", { lines: 1, skipped: [] }],
      [false, true, line(de, "prefs.language.title", "de"), null],
      [false, true, line(de, "prefs.language.title", "de"), null],
    ]);
  });

  it("starts under System without a listing that takes over 2 s, and Reload finds the user's language then", async () => {
    put("pl", { "prefs.language.title": "Mój język" });
    localStorage.setItem("fundacad.language", "pl");
    vi.useFakeTimers();
    answer("language_files_list", async () => (await after(2500), ["pl"]));
    let done = false;
    void initLanguage().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2000);
    const started = [done, languageSetting(), languageChoices().some((c) => c.value === "pl")];
    vi.useRealTimers();
    tauri.invoke.mockImplementation(folder);
    await render();
    click(".prefs-language-reload");
    await vi.waitFor(() => expect(languageChoices().some((c) => c.value === "pl")).toBe(true));
    await setLanguage("pl");
    expect([started, t("prefs.language.title")]).toEqual([[true, "system", false], "Mój język"]);
  });
});

describe("the Language card in the desktop app", () => {
  it("has Open folder and Reload and none of the browser's buttons", async () => {
    await start();
    await render();
    expect([buttons(), document.querySelector(".prefs-language-load")]).toEqual([
      [en["prefs.language.open"], en["prefs.language.reload"]],
      null,
    ]);
  });

  it("opens the folder by the command's name alone, and says so when that fails until the next action", async () => {
    await start();
    await render();
    click(".prefs-language-open");
    await flushPromises();
    const opened = [...tauri.invoke.mock.calls.slice(1)];
    answer("language_folder_open", () => Promise.reject("the languages folder is a link"));
    click(".prefs-language-open");
    await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(en["prefs.language.error.folder"]));
    click(".prefs-language-reload");
    await vi.waitFor(() => expect(text("#prefs-language-error")).toBe(""));
    expect(opened).toEqual([["language_folder_open"]]);
  });

  it("rereads the folder on Reload: a changed line shows, a removed line and then a removed file go back to shipped", async () => {
    put("de", { "prefs.language.title": "Meine Sprache", "prefs.language.hint": "Mein Hinweis" });
    await start("de");
    await render();
    const first = [text(".pref-title"), text("#prefs-language-hint"), status()];
    put("de", { "prefs.language.hint": "Neuer Hinweis" });
    click(".prefs-language-reload");
    await vi.waitFor(() => expect(text("#prefs-language-hint")).toBe("Neuer Hinweis"));
    const changed = [text(".pref-title"), status()];
    tauri.files.delete("de");
    click(".prefs-language-reload");
    await vi.waitFor(() => expect(text("#prefs-language-hint")).toBe(line(de, "prefs.language.hint", "de")));
    expect([first, changed, status(), languageFileStatus(), languageSetting()]).toEqual([
      ["Meine Sprache", "Mein Hinweis", [line(de, "prefs.language.inUse", "de", { n: 2 })]],
      [line(de, "prefs.language.title", "de"), [line(de, "prefs.language.inUse", "de", { n: 1 })]],
      [],
      null,
      "de",
    ]);
  });

  it("goes back to System on Reload once the user's own language file is gone", async () => {
    put("pl", { "prefs.language.title": "Mój język" });
    await start("pl");
    await render();
    tauri.files.delete("pl");
    click(".prefs-language-reload");
    await vi.waitFor(() => expect(languageSetting()).toBe("system"));
    expect([text(".pref-title"), document.documentElement.lang, localStorage.getItem("fundacad.language")]).toEqual([
      en["prefs.language.title"],
      "en",
      "pl",
    ]);
  });

  it("never shows a German file's lines or status under French", async () => {
    put("de", { "prefs.language.title": "Meine Sprache", "x.y": "z" });
    put("fr", { "prefs.language.hint": "Mon indice" });
    await start("de");
    await render();
    const german = languageFileStatus();
    await setLanguage("fr");
    await flushPromises();
    expect([german, languageFileStatus(), text(".pref-title"), text("#prefs-language-hint")]).toEqual([
      { lines: 1, skipped: [{ key: "x.y", reason: "unknown-key" }] },
      { lines: 1, skipped: [] },
      line(fr, "prefs.language.title", "fr"),
      "Mon indice",
    ]);
  });
});

describe("safe mode in the desktop app", () => {
  it("never asks Rust for a file, while the desktop app outside it does", async () => {
    const info = { reason: "flag" as const, failedStarts: 0 };
    const safe = pickDropInSource({ __TAURI_INTERNALS__: {}, __FUNDACAD_SAFE_MODE__: info }, localStorage);
    put("de", { "prefs.language.title": "Meine Sprache" });
    localStorage.setItem("fundacad.language", "de");
    tauri.invoke.mockClear();
    const c = catalog(safe);
    await c.init();
    await c.reloadDropIns();
    expect([
      safe.kind,
      pickDropInSource({ __TAURI_INTERNALS__: {} }, localStorage).kind,
      tauri.invoke.mock.calls,
      c.t("prefs.language.title"),
      c.dropInStatus(),
      await c.openDropInFolder(),
    ]).toEqual(["none", "folder", [], line(de, "prefs.language.title", "de"), null, "folder"]);
  });

  it("shows the folder buttons off with the reason, and a click on them does nothing", async () => {
    window.__FUNDACAD_SAFE_MODE__ = { reason: "crashes", failedStarts: 0, crashes: 3 };
    await start();
    tauri.invoke.mockClear();
    await render();
    const shown = [...document.querySelectorAll(".prefs-actions button")].map((b) => [
      b.textContent!.trim(),
      b.getAttribute("aria-disabled"),
      b.getAttribute("title"),
    ]);
    click(".prefs-language-open");
    click(".prefs-language-reload");
    await flushPromises();
    expect([shown, text(".prefs-language-locked"), tauri.invoke.mock.calls]).toEqual([
      [
        [en["prefs.language.open"], "true", en["prefs.language.safeMode"]],
        [en["prefs.language.reload"], "true", en["prefs.language.safeMode"]],
      ],
      en["prefs.language.safeMode"],
      [],
    ]);
  });
});
