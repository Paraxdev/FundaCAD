import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_KEY, createCatalog, type CatalogDeps, type DropInSource } from "../../src/i18n/catalog";
import { browserDropIns, noDropIns } from "../../src/i18n/dropIns";
import { formatMessage, parseMessage } from "../../src/i18n/format";
import type { Language } from "../../src/i18n/languages";
import { pseudoNodes } from "../../src/i18n/pseudo";

const english = {
  "prefs.language.system": "System ({name})",
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
    await c.setLanguage("de");
    await c.setLanguage("fr");
    expect(c.t("stress.load.force", ARGS)).toBe("Force 12.5 N sur Face 3");
    await c.setLanguage("de");
    expect([lines(c), pageLang]).toEqual([
      ["Studie einrichten", "Force 12.5 N on Face 3", "2,5 faces"],
      ["de-DE", "fr", "de-DE"],
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

  it("are System, the shipped languages in their own words, then the user's languages", async () => {
    const { c } = make({}, seed);
    await c.init();
    expect(c.choices()).toEqual([
      { value: "system", label: "System (English)" },
      { value: "en", label: "English", lang: "en" },
      { value: "de", label: "Deutsch (maschinell übersetzt)", lang: "de-DE" },
      { value: "fr", label: "Français (traduction automatique)", lang: "fr" },
      { value: "nl", label: "Nederlands (your file)", lang: "nl" },
      { value: "pl", label: "polski (your file)", lang: "pl" },
    ]);
  });

  it("say your file in the chosen language, and offer pseudo last in a dev build", async () => {
    const { c } = make({ dev: true }, { "fundacad.language.dropin.pl": "{}" });
    await c.init();
    await c.setLanguage("fr");
    expect(c.choices().slice(-2)).toEqual([
      { value: "pl", label: "polski (votre fichier)", lang: "pl" },
      { value: "pseudo", label: "Pseudo", lang: "en-XA" },
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
