import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_KEY, createCatalog, type CatalogDeps, type DropInSource } from "../../src/i18n/catalog";
import { browserDropIns, noDropIns } from "../../src/i18n/dropIns";
import { formatMessage, parseMessage } from "../../src/i18n/format";
import type { Language } from "../../src/i18n/languages";
import { pseudoNodes } from "../../src/i18n/pseudo";

const english = {
  "prefs.language.system": "System ({name})",
  "prefs.language.systemYours": "System, {name} (your file)",
  "prefs.language.yours": "{name} (your file)",
  "stress.load.force": "Force {value} N on {faces}",
  "stress.setup.faces": "{n, plural, =0 {No faces} one {# face} other {# faces}}",
  "stress.setup.title": "Set up the study",
};
type Key = keyof typeof english;

const de = {
  "stress.load.force": "Kraft {value} N auf {faces}",
  "stress.setup.faces": "{n, plural, =0 {Keine Flächen} one {# Fläche} other {# Flächen}}",
  "stress.setup.title": "Studie einrichten",
};
const fr = {
  "prefs.language.system": "Système ({name})",
  "prefs.language.systemYours": "Système, {name} (votre fichier)",
  "prefs.language.yours": "{name} (votre fichier)",
  "stress.setup.title": "Configurer l'étude",
};

const LANGUAGES: Language[] = [
  { code: "en", native: "English", bcp47: "en", followsSystem: true },
  { code: "de", native: "Deutsch", machine: "maschinell übersetzt", bcp47: "de-DE", followsSystem: false },
  { code: "fr", native: "Français", machine: "traduction automatique", bcp47: "fr", followsSystem: false },
];

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const files = (d: Record<string, unknown>, f: Record<string, unknown> = fr) => ({
  "./locales/de.json": async () => ({ default: d as Record<string, string> }),
  "./locales/fr.json": async () => ({ default: f as Record<string, string> }),
});

function make(o: Partial<CatalogDeps<Key>> = {}, seed: Record<string, string> = {}) {
  const pageLang: string[] = [];
  const storage = memoryStorage(seed);
  const c = createCatalog<Key>({
    english,
    languages: LANGUAGES,
    loaders: files(de),
    dropIns: browserDropIns(storage),
    storage,
    systemTags: () => ["fr-CA", "de-AT"],
    dev: false,
    setPageLang: (l) => pageLang.push(l),
    ...o,
  });
  return { c, pageLang, storage };
}

const file = (name: string, body: unknown) =>
  new File([typeof body === "string" ? body : JSON.stringify(body)], name, { type: "application/json" });

const ARGS = { value: 12.5, faces: "Face 3", n: 2.5 };
const lines = (c: ReturnType<typeof make>["c"]) => [
  c.t("stress.setup.title"),
  c.t("stress.load.force", ARGS),
  c.t("stress.setup.faces", ARGS),
];
const ENGLISH_LINES = ["Set up the study", "Force 12.5 N on Face 3", "2.5 faces"];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the lookup per line", () => {
  it("is English before init, and after init on an English System", async () => {
    const { c, pageLang } = make();
    expect(lines(c)).toEqual(ENGLISH_LINES);
    await c.init();
    expect([lines(c), c.setting(), c.active(), pageLang]).toEqual([
      ENGLISH_LINES,
      "system",
      { code: "en", bcp47: "en" },
      ["en"],
    ]);
  });

  it("takes the user's line, then the shipped line, then English", async () => {
    const seed = { "fundacad.language.dropin.de": JSON.stringify({ "stress.setup.title": "Meine Studie" }) };
    const { c } = make({ loaders: files({ "stress.load.force": de["stress.load.force"] }) }, seed);
    await c.init();
    await c.setLanguage("de");
    expect(lines(c)).toEqual(["Meine Studie", "Kraft 12.5 N auf Face 3", "2,5 faces"]);
  });

  it("formats numbers and plurals for the shipped language's own tag", async () => {
    const { c } = make();
    await c.setLanguage("de");
    expect(lines(c)).toEqual(["Studie einrichten", "Kraft 12.5 N auf Face 3", "2,5 Flächen"]);
    expect([c.t("stress.setup.faces", { n: 0 }), c.t("stress.setup.faces", { n: 1 })]).toEqual([
      "Keine Flächen",
      "1 Fläche",
    ]);
  });

  it("reads an English line's plural by English rules and its numbers by the language's tag", async () => {
    const { c } = make();
    await c.init();
    const faces = () => [0, 1, 2.5, 7].map((n) => c.t("stress.setup.faces", { n }));
    await c.loadDropInFile(file("id.json", { "stress.setup.title": "Siapkan studi" }));
    const english = faces();
    await c.loadDropInFile(
      file("id.json", { "stress.setup.faces": "{n, plural, =0 {Tidak ada} one {# muka satu} other {# muka}}" }),
    );
    expect([english, faces()]).toEqual([
      ["No faces", "1 face", "2,5 faces", "7 faces"],
      ["Tidak ada", "1 muka", "2,5 muka", "7 muka"],
    ]);
  });

  it("falls to English for a shipped line that does not parse or is not text", async () => {
    const { c } = make({ loaders: files({ ...de, "stress.setup.title": "Studie {", "stress.load.force": 7 }) });
    await c.setLanguage("de");
    expect(lines(c)).toEqual(["Set up the study", "Force 12.5 N on Face 3", "2,5 Flächen"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps two lines and two languages apart in its parse cache", async () => {
    const { c } = make();
    await c.setLanguage("de");
    const first = [c.t("stress.setup.title"), c.t("stress.setup.faces", { n: 3 })];
    const again = [c.t("stress.setup.title"), c.t("stress.setup.faces", { n: 4 })];
    await c.setLanguage("fr");
    const french = [c.t("stress.setup.title"), c.t("stress.setup.faces", { n: 3 })];
    expect([first, again, french]).toEqual([
      ["Studie einrichten", "3 Flächen"],
      ["Studie einrichten", "4 Flächen"],
      ["Configurer l'étude", "3 faces"],
    ]);
  });

  it("gives the key itself when even English does not parse", () => {
    const { c } = make({ english: { ...english, "stress.setup.title": "Set up {" } });
    expect(c.t("stress.setup.title")).toBe("stress.setup.title");
  });
});

describe("picking a language", () => {
  it("lets the newer pick win over a slower earlier one", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const loaders = {
      ...files(de),
      "./locales/de.json": async () => {
        await slow;
        return { default: de };
      },
    };
    const { c, pageLang } = make({ loaders });
    const first = c.setLanguage("de");
    await c.setLanguage("fr");
    release();
    await first;
    expect([c.active(), c.t("stress.setup.title"), pageLang]).toEqual([
      { code: "fr", bcp47: "fr" },
      "Configurer l'étude",
      ["fr"],
    ]);
  });

  it("shows English, and does not reject, when a language file fails to load", async () => {
    const { c, pageLang } = make({ loaders: { "./locales/de.json": () => Promise.reject(new Error("chunk gone")) } });
    await expect(c.setLanguage("de")).resolves.toBeUndefined();
    expect([lines(c), c.active(), pageLang]).toEqual([
      ["Set up the study", "Force 12.5 N on Face 3", "2,5 faces"],
      { code: "de", bcp47: "de-DE" },
      ["de-DE"],
    ]);
  });

  it("leaves nothing of the language before after de, fr, then de again", async () => {
    const seed = {
      "fundacad.language.dropin.fr": JSON.stringify({ "stress.load.force": "Force {value} N sur {faces}" }),
    };
    const { c, pageLang } = make({ loaders: files({ "stress.setup.title": de["stress.setup.title"] }) }, seed);
    await c.init();
    await c.setLanguage("de");
    await c.setLanguage("fr");
    expect(c.t("stress.load.force", ARGS)).toBe("Force 12.5 N sur Face 3");
    await c.setLanguage("de");
    expect([lines(c), pageLang]).toEqual([
      ["Studie einrichten", "Force 12.5 N on Face 3", "2,5 faces"],
      ["en", "de-DE", "fr", "de-DE"],
    ]);
  });

  it("stores the pick and reads it back at the next start", async () => {
    const { c, storage } = make();
    await c.setLanguage("fr");
    expect(storage.map.get(LANGUAGE_KEY)).toBe("fr");
    const next = make({}, Object.fromEntries(storage.map));
    await next.c.init();
    expect([next.c.setting(), next.c.active()]).toEqual(["fr", { code: "fr", bcp47: "fr" }]);
  });

  it("stores System for a pick that is no language", async () => {
    const { c, storage } = make();
    await c.setLanguage("de");
    await c.setLanguage("pt");
    expect([c.setting(), c.active(), storage.map.get(LANGUAGE_KEY)]).toEqual([
      "system",
      { code: "en", bcp47: "en" },
      "system",
    ]);
  });

  it("tells each listener once per change, and no more once it unsubscribes", async () => {
    const { c } = make();
    const heard: string[] = [];
    const stop = c.onChange(() => heard.push(c.active().code));
    await c.init();
    await c.setLanguage("de");
    await c.setLanguage("fr");
    stop();
    await c.setLanguage("de");
    expect(heard).toEqual(["en", "de", "fr"]);
  });
});

describe("machine translation", () => {
  it("is the case for a shipped machine translated language and a regional file on one, not for English or the user's own", async () => {
    const seed = {
      "fundacad.language.dropin.de-AT": "{}",
      "fundacad.language.dropin.pl": "{}",
      "fundacad.language.dropin.en": "{}",
    };
    const { c } = make({}, seed);
    await c.init();
    const seen: [string, boolean][] = [];
    for (const code of ["system", "fr", "de-AT", "pl", "en", "de"]) {
      await c.setLanguage(code);
      seen.push([code, c.machineTranslated()]);
    }
    expect(seen).toEqual([
      ["system", false],
      ["fr", true],
      ["de-AT", true],
      ["pl", false],
      ["en", false],
      ["de", true],
    ]);
  });
});

describe("the stored setting", () => {
  it.each(["pt", "PL", "../de", "", "de.json", "pl"])("%j, unknown or invalid, reads as System", async (stored) => {
    const { c, pageLang } = make({}, { [LANGUAGE_KEY]: stored });
    await c.init();
    expect([c.setting(), c.active(), pageLang]).toEqual(["system", { code: "en", bcp47: "en" }, ["en"]]);
  });

  it("is kept for a language only the user's file adds", async () => {
    const seed = {
      [LANGUAGE_KEY]: "pl",
      "fundacad.language.dropin.pl": JSON.stringify({ "stress.setup.title": "Ustaw badanie" }),
    };
    const { c, pageLang } = make({}, seed);
    await c.init();
    expect([c.setting(), c.active(), lines(c), pageLang]).toEqual([
      "pl",
      { code: "pl", bcp47: "pl" },
      ["Ustaw badanie", "Force 12.5 N on Face 3", "2,5 faces"],
      ["pl"],
    ]);
  });

  it("reads pseudo as System outside a dev build", async () => {
    const { c, pageLang } = make({}, { [LANGUAGE_KEY]: "pseudo" });
    await c.init();
    await c.setLanguage("pseudo");
    expect([c.setting(), lines(c), pageLang]).toEqual(["system", ENGLISH_LINES, ["en", "en"]]);
  });

  it("gives pseudo text and en-XA in a dev build", async () => {
    const { c, pageLang } = make({ dev: true }, { [LANGUAGE_KEY]: "pseudo" });
    await c.init();
    const pseudo = (k: Key) => formatMessage(pseudoNodes(parseMessage(english[k])), ARGS, "en");
    expect([c.setting(), lines(c), pageLang]).toEqual([
      "pseudo",
      [pseudo("stress.setup.title"), pseudo("stress.load.force"), pseudo("stress.setup.faces")],
      ["en-XA"],
    ]);
    expect(lines(c)[0]).not.toBe(ENGLISH_LINES[0]);
  });

  it("never makes init reject, whatever the storage and files do", async () => {
    const broken: DropInSource = {
      kind: "browser",
      list: () => Promise.reject(new Error("list")),
      read: () => Promise.reject(new Error("read")),
    };
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {},
    };
    const { c, pageLang } = make({
      dropIns: broken,
      storage,
      systemTags: () => {
        throw new Error("no navigator");
      },
      setPageLang: () => {
        pageLang.push("thrown");
        throw new Error("no document");
      },
    });
    await expect(c.init()).resolves.toBeUndefined();
    await expect(c.setLanguage("de")).resolves.toBeUndefined();
    expect([c.setting(), lines(c), pageLang]).toEqual([
      "de",
      ["Studie einrichten", "Kraft 12.5 N auf Face 3", "2,5 Flächen"],
      ["thrown", "thrown"],
    ]);
  });
});

describe("the user's language file", () => {
  it("cannot change the lines that tell the user about it, and lists them as skipped", async () => {
    const seed = {
      "fundacad.language.dropin.de": JSON.stringify({
        "prefs.language.yours": "{name}",
        "stress.setup.title": "Meine Studie",
        "prefs.language.system": "System",
      }),
      "fundacad.language.dropin.pl": "{}",
    };
    const { c } = make({}, seed);
    await c.init();
    await c.setLanguage("de");
    expect([c.dropInStatus(), c.t("stress.setup.title"), c.choices()[0], c.choices().at(-1)]).toEqual([
      {
        lines: 1,
        skipped: [
          { key: "prefs.language.yours", reason: "locked" },
          { key: "prefs.language.system", reason: "locked" },
        ],
      },
      "Meine Studie",
      { value: "system", label: "System (English)" },
      { value: "pl", label: "polski (your file)", parts: [{ text: "polski", lang: "pl" }, { text: " (your file)" }] },
    ]);
  });

  it("reports its lines and the lines it skipped, and the file a whole refusal", async () => {
    const seed = {
      "fundacad.language.dropin.de": JSON.stringify({
        "stress.setup.title": "Meine Studie",
        "stress.load.force": "<b>Kraft</b> {value}",
        "stress.nope": "Nein",
      }),
      "fundacad.language.dropin.fr": "{ not json",
    };
    const { c } = make({}, seed);
    await c.init();
    const english = c.dropInStatus();
    await c.setLanguage("de");
    const german = c.dropInStatus();
    await c.setLanguage("fr");
    expect([english, german, c.dropInStatus()]).toEqual([
      null,
      {
        lines: 1,
        skipped: [
          { key: "stress.load.force", reason: "markup" },
          { key: "stress.nope", reason: "unknown-key" },
        ],
      },
      { lines: 0, skipped: [], error: "not-json" },
    ]);
  });

  it("is read again on reload, and a removed line goes back to the shipped one", async () => {
    const key = "fundacad.language.dropin.de";
    const seed = {
      [key]: JSON.stringify({ "stress.setup.title": "Meine Studie", "stress.load.force": "Kraft {value}" }),
    };
    const { c, storage } = make({}, seed);
    await c.init();
    await c.setLanguage("de");
    expect(lines(c).slice(0, 2)).toEqual(["Meine Studie", "Kraft 12.5"]);
    storage.setItem(key, JSON.stringify({ "stress.setup.title": "Neue Studie" }));
    await c.reloadDropIns();
    expect(lines(c)).toEqual(["Neue Studie", "Kraft 12.5 N auf Face 3", "2,5 Flächen"]);
    storage.removeItem(key);
    await c.reloadDropIns();
    expect([lines(c), c.dropInStatus()]).toEqual([
      ["Studie einrichten", "Kraft 12.5 N auf Face 3", "2,5 Flächen"],
      null,
    ]);
  });

  it("falls back to System once the file of the picked language is gone", async () => {
    const key = "fundacad.language.dropin.pl";
    const { c, storage } = make({}, { [key]: JSON.stringify({ "stress.setup.title": "Ustaw badanie" }) });
    await c.init();
    await c.setLanguage("pl");
    storage.removeItem(key);
    await c.reloadDropIns();
    expect([c.setting(), c.active(), storage.map.get(LANGUAGE_KEY)]).toEqual([
      "system",
      { code: "en", bcp47: "en" },
      "pl",
    ]);
  });
});

describe("the choices", () => {
  const seed = {
    "fundacad.language.dropin.pl": "{}",
    "fundacad.language.dropin.de": "{}",
    "fundacad.language.dropin.nl": "{}",
    "fundacad.language.dropin.PL": "{}",
  };

  it("are System, the shipped languages in their own words, one with a file marked, then the user's languages", async () => {
    const { c } = make({}, seed);
    await c.init();
    expect(c.choices()).toEqual([
      { value: "system", label: "System (English)" },
      { value: "en", label: "English", lang: "en" },
      {
        value: "de",
        label: "Deutsch (maschinell übersetzt) (your file)",
        parts: [{ text: "Deutsch (maschinell übersetzt)", lang: "de-DE" }, { text: " (your file)" }],
      },
      { value: "fr", label: "Français (traduction automatique)", lang: "fr" },
      {
        value: "nl",
        label: "Nederlands (your file)",
        parts: [{ text: "Nederlands", lang: "nl" }, { text: " (your file)" }],
      },
      { value: "pl", label: "polski (your file)", parts: [{ text: "polski", lang: "pl" }, { text: " (your file)" }] },
    ]);
  });

  it("say your file in the chosen language, and offer pseudo last in a dev build", async () => {
    const { c } = make({ dev: true }, { "fundacad.language.dropin.pl": "{}" });
    await c.init();
    await c.setLanguage("fr");
    expect(c.choices().slice(-2)).toEqual([
      {
        value: "pl",
        label: "polski (votre fichier)",
        parts: [{ text: "polski", lang: "pl" }, { text: " (votre fichier)" }],
      },
      { value: "pseudo", label: "Pseudo", lang: "en-XA" },
    ]);
  });

  it("put the lang on the name alone, wherever the line places it, once or many times or not at all", async () => {
    const shown = async (line: string) => {
      const { c } = make(
        { loaders: files({ ...de, "prefs.language.yours": line }) },
        { "fundacad.language.dropin.pl": "{}" },
      );
      await c.init();
      await c.setLanguage("de");
      return c.choices().at(-1);
    };
    expect([await shown("Ihre Datei: {name}!"), await shown("{name} ({name})"), await shown("Eigene Sprache")]).toEqual(
      [
        {
          value: "pl",
          label: "Ihre Datei: polski!",
          parts: [{ text: "Ihre Datei: " }, { text: "polski", lang: "pl" }, { text: "!" }],
        },
        {
          value: "pl",
          label: "polski (polski)",
          parts: [{ text: "polski", lang: "pl" }, { text: " (" }, { text: "polski", lang: "pl" }, { text: ")" }],
        },
        { value: "pl", label: "Eigene Sprache", parts: [{ text: "Eigene Sprache" }] },
      ],
    );
  });

  it("say so when an en.json of the user's changes English under System", async () => {
    const { c } = make({}, { "fundacad.language.dropin.en": JSON.stringify({ "stress.setup.title": "My study" }) });
    await c.init();
    expect([c.setting(), c.t("stress.setup.title"), c.choices().slice(0, 3)]).toEqual([
      "system",
      "My study",
      [
        { value: "system", label: "System, English (your file)" },
        {
          value: "en",
          label: "English (your file)",
          parts: [{ text: "English", lang: "en" }, { text: " (your file)" }],
        },
        { value: "de", label: "Deutsch (maschinell übersetzt)", lang: "de-DE" },
      ],
    ]);
  });

  it("reads cleanly under System with and without a file for the System language, or a file for another", async () => {
    const own = { "stress.setup.title": "My study" };
    const systemLabel = async (seed: Record<string, string>, language: string | null, following = false) => {
      const languages = following ? LANGUAGES.map((l) => ({ ...l, followsSystem: l.code !== "fr" })) : LANGUAGES;
      const { c } = make({ languages }, seed);
      await c.init();
      if (language) await c.setLanguage(language);
      return c.choices()[0]?.label;
    };
    const en = { "fundacad.language.dropin.en": JSON.stringify(own) };
    const de2 = { "fundacad.language.dropin.de": JSON.stringify(own) };
    const pl = { "fundacad.language.dropin.pl": JSON.stringify(own) };
    expect([
      await systemLabel(en, null),
      await systemLabel({}, null),
      await systemLabel(pl, null),
      await systemLabel(de2, null),
      await systemLabel(de2, null, true),
      await systemLabel(en, "fr"),
      await systemLabel(en, "fr", true),
      await systemLabel(de2, "fr", true),
      await systemLabel({}, "fr", true),
      await systemLabel(pl, "fr", true),
    ]).toEqual([
      "System, English (your file)",
      "System (English)",
      "System (English)",
      "System (English)",
      "System, Deutsch (your file)",
      "Système, English (votre fichier)",
      "Système (Deutsch)",
      "Système, Deutsch (votre fichier)",
      "Système (Deutsch)",
      "Système (Deutsch)",
    ]);
  });

  it("does not let a file rewrite the System label with a file line", async () => {
    const seed = {
      "fundacad.language.dropin.en": JSON.stringify({
        "prefs.language.systemYours": "Hijacked {name}",
        "prefs.language.system": "Hijacked ({name})",
      }),
    };
    const { c } = make({}, seed);
    await c.init();
    expect([c.choices()[0]?.label, c.dropInStatus()?.skipped]).toEqual([
      "System, English (your file)",
      [
        { key: "prefs.language.systemYours", reason: "locked" },
        { key: "prefs.language.system", reason: "locked" },
      ],
    ]);
  });

  it("name the System language once it follows System", async () => {
    const following = LANGUAGES.map((l) => ({ ...l, followsSystem: l.code !== "fr" }));
    const { c } = make({ languages: following, dropIns: noDropIns });
    await c.init();
    expect([c.choices()[0], c.active(), c.t("stress.setup.title")]).toEqual([
      { value: "system", label: "System (Deutsch)" },
      { code: "de", bcp47: "de-DE" },
      "Studie einrichten",
    ]);
  });
});

describe("an OS language change", () => {
  it("is followed while the setting is System, and ignored once a language is picked", async () => {
    let tags = ["fr-FR"];
    let fire: () => void = () => {};
    const following = LANGUAGES.map((l) => ({ ...l, followsSystem: l.code !== "fr" }));
    const { c, pageLang } = make({ languages: following, systemTags: () => tags, watchSystem: (cb) => (fire = cb) });
    await c.init();
    tags = ["de-AT", "fr"];
    fire();
    await vi.waitFor(() => expect(c.active().code).toBe("de"));
    fire();
    await c.setLanguage("fr");
    tags = ["en-GB"];
    fire();
    await new Promise((r) => setTimeout(r, 0));
    expect([c.setting(), c.active(), pageLang]).toEqual(["fr", { code: "fr", bcp47: "fr" }, ["en", "de-DE", "fr"]]);
  });
});

describe("loading a language file", () => {
  it("keeps the file, lists its language and switches to it, a second file of that language replacing the first", async () => {
    const { c, storage } = make(
      {},
      { "fundacad.language.dropin.fr": JSON.stringify({ "stress.setup.title": "Mon étude" }) },
    );
    await c.init();
    const first = await c.loadDropInFile(
      file("de.json", { "stress.setup.title": "Meine Studie", "stress.load.force": "<b>Kraft</b>", "x.y": "z" }),
    );
    const before = [c.setting(), lines(c), c.dropInStatus()];
    const second = await c.loadDropInFile(file("de.json", { "stress.load.force": "Kraft {value} auf {faces}" }));
    expect([first, before]).toEqual([
      null,
      [
        "de",
        ["Meine Studie", "Kraft 12.5 N auf Face 3", "2,5 Flächen"],
        {
          lines: 1,
          skipped: [
            { key: "stress.load.force", reason: "markup" },
            { key: "x.y", reason: "unknown-key" },
          ],
        },
      ],
    ]);
    expect([second, lines(c), c.dropInStatus(), storage.map.get(LANGUAGE_KEY)]).toEqual([
      null,
      ["Studie einrichten", "Kraft 12.5 auf Face 3", "2,5 Flächen"],
      { lines: 1, skipped: [] },
      "de",
    ]);
    await c.setLanguage("fr");
    expect([c.t("stress.load.force", ARGS), c.dropInStatus()]).toEqual([
      "Force 12.5 N on Face 3",
      { lines: 1, skipped: [] },
    ]);
  });

  it("adds a language FundaCAD does not ship as the user's own, its missing lines in English", async () => {
    const { c, pageLang } = make();
    await c.init();
    expect(await c.loadDropInFile(file("pl.json", { "stress.setup.title": "Ustaw badanie" }))).toBeNull();
    expect([c.setting(), c.active(), lines(c), c.choices().at(-1), pageLang.at(-1)]).toEqual([
      "pl",
      { code: "pl", bcp47: "pl" },
      ["Ustaw badanie", "Force 12.5 N on Face 3", "2,5 faces"],
      { value: "pl", label: "polski (your file)", parts: [{ text: "polski", lang: "pl" }, { text: " (your file)" }] },
      "pl",
    ]);
  });

  it("fills a regional language's missing lines from its base's shipped file, or English when none is shipped", async () => {
    const { c, pageLang } = make();
    await c.init();
    await c.loadDropInFile(file("de-AT.json", { "stress.setup.title": "Studie aufsetzen" }));
    const austrian = [c.active(), lines(c), pageLang.at(-1)];
    await c.loadDropInFile(file("es-419.json", { "stress.setup.title": "Configurar el estudio" }));
    const spanish = [c.active(), lines(c), pageLang.at(-1)];
    await c.setLanguage("de");
    expect([austrian, spanish, lines(c)]).toEqual([
      [{ code: "de-AT", bcp47: "de-AT" }, ["Studie aufsetzen", "Kraft 12.5 N auf Face 3", "2,5 Flächen"], "de-AT"],
      [{ code: "es-419", bcp47: "es-419" }, ["Configurar el estudio", "Force 12.5 N on Face 3", "2.5 faces"], "es-419"],
      ["Studie einrichten", "Kraft 12.5 N auf Face 3", "2,5 Flächen"],
    ]);
  });

  it("takes the language only from a name that is a language code and .json, reading nothing otherwise", async () => {
    const { c, storage } = make();
    await c.init();
    const names = ["Polish.json", "pl_PL.json", "pseudo.json", "pl.JSON", "pl.json.txt", "pl", ".json", "de .json"];
    const refused: unknown[] = [];
    for (const name of names) {
      const f = file(name, { "stress.setup.title": "Ustaw badanie" });
      const read = vi.spyOn(f, "text");
      refused.push([await c.loadDropInFile(f), read.mock.calls.length]);
    }
    expect(refused).toEqual(names.map(() => ["bad-name", 0]));
    expect([[...storage.map.keys()], c.setting()]).toEqual([[], "system"]);
    expect(await c.loadDropInFile(file("zh-Hant-TW.json", {}))).toBeNull();
  });

  it("loads a file of exactly 256 KB and refuses one byte more before reading it", async () => {
    const { c } = make();
    await c.init();
    const head = '{"stress.setup.title":"Größe"';
    const pad = 256 * 1024 - new TextEncoder().encode(head + "}").length;
    const fits = file("de.json", head + " ".repeat(pad) + "}");
    const over = file("de.json", head + " ".repeat(pad + 1) + "}");
    const read = vi.spyOn(over, "text");
    expect([fits.size, over.size]).toEqual([262144, 262145]);
    expect([await c.loadDropInFile(over), read.mock.calls.length, c.setting()]).toEqual(["too-large", 0, "system"]);
    expect([await c.loadDropInFile(fits), c.t("stress.setup.title")]).toEqual([null, "Größe"]);
  });

  it("refuses a whole file it cannot use and keeps the file before it", async () => {
    const { c, storage } = make();
    await c.init();
    await c.loadDropInFile(file("de.json", { "stress.setup.title": "Meine Studie" }));
    await c.setLanguage("fr");
    const results = [
      await c.loadDropInFile(file("de.json", "{ not json")),
      await c.loadDropInFile(file("de.json", ["stress.setup.title"])),
      await c.loadDropInFile(file("de.json", { "stress.setup.title": { de: "Studie" } })),
    ];
    expect([results, c.setting(), storage.map.get("fundacad.language.dropin.de")]).toEqual([
      ["not-json", "not-flat", "not-flat"],
      "fr",
      JSON.stringify({ "stress.setup.title": "Meine Studie" }),
    ]);
  });

  it("says so when the file cannot be read or kept, and changes nothing", async () => {
    const full = memoryStorage();
    full.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    const { c } = make({ dropIns: browserDropIns(full) });
    await c.init();
    const broken = file("de.json", {});
    vi.spyOn(broken, "text").mockRejectedValue(new Error("gone"));
    const results = [
      await c.loadDropInFile(file("de.json", { "stress.setup.title": "Meine Studie" })),
      await c.loadDropInFile(broken),
    ];
    const { c: none } = make({ dropIns: noDropIns });
    results.push(await none.loadDropInFile(file("de.json", {})));
    expect([results, c.setting(), c.t("stress.setup.title"), none.setting()]).toEqual([
      ["storage", "unreadable", "storage"],
      "system",
      "Set up the study",
      "system",
    ]);
  });
});

describe("removing the user's lines", () => {
  const seed = {
    "fundacad.language.dropin.de": JSON.stringify({ "stress.setup.title": "Meine Studie" }),
    "fundacad.language.dropin.fr": JSON.stringify({ "stress.setup.title": "Mon étude" }),
    "fundacad.language.dropin.pl": JSON.stringify({ "stress.setup.title": "Ustaw badanie" }),
  };

  it("drops only the shown language's file, and its shipped lines come back", async () => {
    const { c, storage } = make({}, seed);
    await c.setLanguage("de");
    expect(await c.removeDropIn()).toBeNull();
    expect([c.t("stress.setup.title"), c.dropInStatus(), [...storage.map.keys()].sort()]).toEqual([
      "Studie einrichten",
      null,
      ["fundacad.language", "fundacad.language.dropin.fr", "fundacad.language.dropin.pl"],
    ]);
    await c.setLanguage("fr");
    expect(c.t("stress.setup.title")).toBe("Mon étude");
  });

  it("leaves a language only the file added, back to System, and stores System", async () => {
    const { c, storage } = make({}, seed);
    await c.init();
    await c.setLanguage("pl");
    expect(await c.removeDropIn()).toBeNull();
    expect([c.setting(), c.active(), c.choices().map((o) => o.value), storage.map.get(LANGUAGE_KEY)]).toEqual([
      "system",
      { code: "en", bcp47: "en" },
      ["system", "en", "de", "fr"],
      "system",
    ]);
  });

  it("says so when the storage refuses, keeping the lines", async () => {
    const stored = memoryStorage(seed);
    stored.removeItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    const { c } = make({ dropIns: browserDropIns(stored) }, seed);
    await c.init();
    await c.setLanguage("de");
    const { c: none } = make({ dropIns: noDropIns });
    expect([await c.removeDropIn(), c.t("stress.setup.title"), await none.removeDropIn()]).toEqual([
      "storage",
      "Meine Studie",
      "storage",
    ]);
  });

  it("tells where the files come from", () => {
    expect([make().c.dropInKind(), make({ dropIns: noDropIns }).c.dropInKind()]).toEqual(["browser", "none"]);
  });
});
