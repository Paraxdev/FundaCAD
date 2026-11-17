// The verdict, its bend line and the weak spot label read in the picked language, at the boundary values.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../src/i18n";
import { argNames, parseMessage, type MessageNode } from "../../src/i18n/format";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import es from "../../src/i18n/locales/es.json";
import fr from "../../src/i18n/locales/fr.json";
import ja from "../../src/i18n/locales/ja.json";
import zh from "../../src/i18n/locales/zh-CN.json";
import {
  aboutFactor,
  deflectionNote,
  SAFE_MARGIN,
  verdictView,
  weakSpotLabel,
  type PeakPlace,
} from "../../src/ui/stressVerdict";
import { setUnit } from "../../src/ui/units";
import { englishLeft } from "../i18n/englishLeft";

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

const OTHERS = ["de", "fr", "es", "ja", "zh-CN"] as const;
const PLACES: PeakPlace[] = [null, "corner", "support"];
const FACTORS = [0, 0.005, 0.3, 0.5, 0.5001, 0.978, 1, 1.37, 1.499, 1.5, 4.57, 100, 100.01];

const view = (sf: number | null, place: PeakPlace = null, marked = true) =>
  verdictView({ safetyFactor: sf, peakPlace: place }, SAFE_MARGIN, marked);

const everyText = () => {
  const out: string[] = [];
  for (const sf of [...FACTORS, null]) {
    for (const place of PLACES) {
      for (const marked of [true, false]) {
        const v = view(sf, place, marked);
        out.push(v.headline, v.detail ?? "");
      }
    }
    out.push(weakSpotLabel(sf));
  }
  for (const scale of [0, 0.25, 1, 12]) out.push(deflectionNote(0.0314, "mm", scale) ?? "");
  return out;
};

describe("the verdict in German", () => {
  it("states the factors with a comma at the boundaries 0.5, 1 and 1.5", async () => {
    await setLanguage("de");
    expect([0.3, 0.5, 0.5001].map((sf) => view(sf).detail)).toEqual([
      "Die Last ist etwa 3,4-mal so groß, wie das Teil aufnehmen kann.",
      "Die Last ist etwa 2-mal so groß, wie das Teil aufnehmen kann.",
      "Die Last ist etwa 100 % größer, als das Teil aufnehmen kann.",
    ]);
    expect(view(1).headline).toBe("Hält, mindestens 1-fach sicher, halten Sie aber etwa das 1,5-Fache ein.");
    expect(view(1.37).headline).toBe("Hält, mindestens 1,3-fach sicher, halten Sie aber etwa das 1,5-Fache ein.");
    expect(view(1.499).headline).toBe("Hält, mindestens 1,4-fach sicher, halten Sie aber etwa das 1,5-Fache ein.");
    expect(view(1.5).headline).toBe("Hält, mindestens 1,5-fach sicher.");
    expect(view(4.57).headline).toBe("Hält, mindestens 4,5-fach sicher.");
    expect(view(100).headline).toBe("Hält, mindestens 100-fach sicher.");
    expect(view(100.01).headline).toBe("Hält, mehr als 100-fach sicher.");
    expect(view(0.978).headline).toBe("Versagt wahrscheinlich an der markierten Stelle.");
    expect(view(0.005).detail).toBe("Die Last ist mehr als 100-mal so groß, wie das Teil aufnehmen kann.");
  });

  it("keeps the level and the none verdict as in English, and the weak spot unmarked says nothing more", async () => {
    await setLanguage("de");
    expect(view(null)).toEqual({
      level: "none",
      headline: "Nichts steht unter Spannung, prüfen Sie die Lasten.",
      detail: null,
    });
    expect(view(3.32, null, false)).toEqual({
      level: "holds",
      headline: "Hält, mindestens 3,3-fach sicher.",
      detail: null,
    });
    expect(view(0.62, null, false).headline).toBe("Versagt wahrscheinlich.");
  });

  it("says the corner and the support edge, marked and not, with the rough reading", async () => {
    await setLanguage("de");
    expect(view(0.8, "corner")).toEqual({
      level: "fails",
      headline: "Versagt wahrscheinlich an der markierten scharfen Ecke, nach grober Ablesung.",
      detail:
        "Die Last ist etwa 25 % größer, als das Teil aufnehmen kann. Die Zahl an einer scharfen Ecke ist grob, und eine Verrundung der Ecke macht das Teil stärker.",
    });
    expect(view(1.3, "support", false)).toEqual({
      level: "marginal",
      headline: "Hält nach grober Ablesung, mindestens 1,3-fach sicher, halten Sie aber etwa das 1,5-Fache ein.",
      detail:
        "Am schwächsten am Rand einer Halterung. Die Zahl dort ist grob, lesen Sie die Farbe daher etwas daneben ab.",
    });
    expect(view(2.94, "corner", false).detail).toContain("Am schwächsten an einer scharfen Innenecke.");
    expect(view(0.8, "support", false).headline).toBe(
      "Versagt wahrscheinlich am Rand einer Halterung, nach grober Ablesung.",
    );
  });

  it("labels the weak spot and the bend with the comma, at scale 0, 1, 0.25 and 12", async () => {
    await setLanguage("de");
    expect([1.37, 100.01, 0.62, 0.31, 0.005, null].map(weakSpotLabel)).toEqual([
      "Schwächste Stelle, mindestens 1,3-fach sicher",
      "Schwächste Stelle, mehr als 100-fach sicher",
      "Schwächste Stelle, 62 % überlastet",
      "Schwächste Stelle, 3,3-fach überlastet",
      "Schwächste Stelle, mehr als 100-fach überlastet",
      "Schwächste Stelle",
    ]);
    expect([0, 1, 0.25, 12, 0.59].map((s) => deflectionNote(0.4712, "mm", s))).toEqual([
      "Biegt sich höchstens um 0,471 mm, nicht dargestellt.",
      "Biegt sich höchstens um 0,471 mm, in wahrer Größe dargestellt.",
      "Biegt sich höchstens um 0,471 mm, in 0,25-facher wahrer Größe dargestellt.",
      "Biegt sich höchstens um 0,471 mm, 12-fach vergrößert dargestellt.",
      "Biegt sich höchstens um 0,471 mm, in 0,59-facher wahrer Größe dargestellt.",
    ]);
    expect(deflectionNote(null, "mm", 1)).toBeNull();
    expect(aboutFactor(250, "down")).toBe("mehr als 100");
    expect(aboutFactor(4.57, "down")).toBe("4,5");
  });

  it("reads the same text again in English once the language goes back", async () => {
    await setLanguage("de");
    const german = view(0.31).detail;
    await setLanguage("en");
    expect(view(0.31).detail).toBe("The load is about 3.3x what it can take.");
    expect(german).not.toBe(view(0.31).detail);
    expect(aboutFactor(250, "down")).toBe("more than 100");
  });
});

describe("the verdict in Japanese", () => {
  it("reads the failing and holding verdicts as the design words them, caution kept", async () => {
    await setLanguage("ja");
    expect(view(0.8, "corner")).toEqual({
      level: "fails",
      headline: "マークした鋭い角で破損する可能性が高いです（概算）。",
      detail:
        "荷重は、耐えられる大きさより約 25% 大きくなっています。鋭い角での数値は概算で、角を丸めると強くなります。",
    });
    expect(view(1.37).headline).toBe("耐えます。安全率は少なくとも 1.3 倍です。ただし約 1.5 倍を確保してください。");
    expect(view(3.32).headline).toBe("耐えます。安全率は少なくとも 3.3 倍です。");
    expect(view(100.01).headline).toBe("耐えます。安全率は100 倍を超えています。");
    expect(view(0.3).detail).toBe("荷重は、耐えられる大きさの約 3.4 倍です。");
    expect(view(null).headline).toBe("応力がかかっていません。荷重を確認してください。");
    expect([1.37, 0.62, 0.3, 0.005].map(weakSpotLabel)).toEqual([
      "最も弱い箇所、安全率は少なくとも 1.3 倍",
      "最も弱い箇所、62% 超過",
      "最も弱い箇所、3.4 倍の超過",
      "最も弱い箇所、100 倍超の超過",
    ]);
  });

  it("joins the spoken verdict without a space and bends in the language", async () => {
    await setLanguage("ja");
    expect(deflectionNote(12.5, "mm", 12)).toBe("最大で 12.5 mm たわみます。12 倍に拡大して表示しています。");
    expect(deflectionNote(12.5, "mm", 0.25)).toBe("最大で 12.5 mm たわみます。実寸の 0.25 倍で表示しています。");
  });
});

describe("every language", () => {
  it.each(OTHERS)("%s leaves no English and no open brace in any verdict text", async (code) => {
    await setLanguage("en");
    const english = everyText();
    await setLanguage(code);
    const said = everyText();
    expect(said).toHaveLength(english.length);
    said.forEach((text, i) => {
      expect(text).not.toMatch(/[{}]/);
      if (english[i] === "") expect(text).toBe("");
      else expect(englishLeft(text, english[i]!, [])).toEqual([]);
    });
  });

  it("keeps the strength: likely to fail is a probability, and a hold names its factor", async () => {
    const strong = { de: "wahrscheinlich", fr: "probable", es: "Probablemente", ja: "可能性", "zh-CN": "很可能" };
    const least = { de: "mindestens", fr: "d’au moins", es: "de al menos", ja: "少なくとも", "zh-CN": "至少" };
    for (const code of OTHERS) {
      await setLanguage(code);
      expect(view(0.62).headline).toContain(strong[code]);
      expect(view(3.32).headline).toContain(least[code]);
      expect(view(3.32).headline).toContain("3");
      expect(view(0.62).headline).not.toBe(view(3.32).headline);
    }
  });
});

const names = (nodes: readonly MessageNode[], into: string[] = []): string[] => {
  for (const n of nodes) {
    if (n.t !== "select" && n.t !== "plural") continue;
    into.push(`${n.name}:${[...n.options.keys()].sort().join("|")}`);
    for (const o of n.options.values()) names(o, into);
  }
  return into.sort();
};

describe("the verdict lines", () => {
  const files = { de, fr, es, ja, "zh-CN": zh } as Record<string, Record<string, string>>;
  const keys = Object.keys(en).filter((k) => k.startsWith("stress.verdict."));

  it("are the nine keys, in every language", () => {
    expect(keys).toHaveLength(9);
    for (const file of Object.values(files)) {
      expect(Object.keys(file).filter((k) => k.startsWith("stress.verdict."))).toEqual(keys);
    }
  });

  it.each(keys)("%s keeps English's select options and arguments in every language", (key) => {
    const english = parseMessage(en[key as keyof typeof en]);
    for (const [code, file] of Object.entries(files)) {
      const nodes = parseMessage(file[key]!);
      expect(names(nodes), code).toEqual(names(english));
      expect([...argNames(nodes)].sort(), code).toEqual([...argNames(english)].sort());
    }
  });

  it("fails the option check on a line that dropped the corner option", () => {
    const dropped = parseMessage(en["stress.verdict.failDetail"].replace(/corner \{[^}]*\} /, ""));
    expect(names(dropped)).not.toEqual(names(parseMessage(en["stress.verdict.failDetail"])));
  });
});
