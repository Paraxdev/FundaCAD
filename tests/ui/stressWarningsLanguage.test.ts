// The engine's warnings and refusals read in the picked language, its text stays English on the wire.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, tEnglish } from "../../src/i18n";
import { panelMessage } from "../../src/ui/stress";
import { plainError, plainWarning, plainWarningFor, sentence } from "../../src/ui/stressWarnings";
import { englishLeft } from "../i18n/englishLeft";
import { REFUSAL_TEXTS, WALL_EXAMPLE, WARNING_TEXTS } from "./stressEngineText";

afterEach(() => setLanguage("system"));

const warning = (name: string) => WARNING_TEXTS.find((r) => r.name === name)!.example;
const refusal = (name: string) => REFUSAL_TEXTS.find((r) => r.name === name)!.example;

const THIN = warning("thin walls");
const UNSETTLED_FINE = warning("unsettled, a fine run reads it closer");
const UNSETTLED_FINER = warning("unsettled, a Fine run");
const NARROW = (n: number, which: string) =>
  `${n} of the ${which} faces got no elements, they are narrower than the element size and hold nothing`;
const THIN_WALL_REFUSAL = refusal("thin walls");
const MEMORY = refusal("memory");
const FIXED_FACE = refusal("fixed face");

const SHARED = { de: ["detail"], fr: ["face", "faces", "options"], es: [], ja: [], "zh-CN": [] } as const;
const OTHERS = ["de", "fr", "es", "ja", "zh-CN"] as const;
const PICK_DE = " Wählen Sie unter „Netzfeinheit“ in „Weitere Optionen“ die Stufe „Fein“.";

const everyLine = () => [
  ...WARNING_TEXTS.map((r) => plainWarning(r.example)),
  ...REFUSAL_TEXTS.map((r) => plainError(r.example + WALL_EXAMPLE)),
];

describe("every rule in each shipped language", () => {
  it.each(OTHERS)("%s leaves no English and no open brace", async (code) => {
    await setLanguage("en");
    const english = everyLine();
    await setLanguage(code);
    const said = everyLine();
    expect(said).toHaveLength(english.length);
    said.forEach((text, i) => {
      expect(text).not.toBe(english[i]);
      expect(text).not.toMatch(/[{}]/);
      expect(englishLeft(text, english[i]!, SHARED[code])).toEqual([]);
    });
  });
});

describe("the narrow faces warning", () => {
  it("counts 0, 1 and 4 faces with the plural of the language", async () => {
    await setLanguage("de");
    expect([0, 1, 4].map((n) => plainWarning(NARROW(n, "held")))).toEqual([
      `0 der gehaltenen Flächen sind zu schmal für das Netz und halten nichts.${PICK_DE}`,
      `1 der gehaltenen Flächen ist zu schmal für das Netz und hält nichts.${PICK_DE}`,
      `4 der gehaltenen Flächen sind zu schmal für das Netz und halten nichts.${PICK_DE}`,
    ]);
    expect(plainWarning(NARROW(4, "fixed"))).toContain("4 der festen Flächen sind");
    await setLanguage("ja");
    expect(plainWarning(NARROW(4, "held"))).toBe(
      "保持される面のうち 4 面は、メッシュに対して狭すぎて何も保持できません。「その他のオプション」の「メッシュの細かさ」で「細かい」を選んでください。",
    );
  });

  it("shows a word the engine may add later as it came", async () => {
    await setLanguage("de");
    expect(plainWarning(NARROW(3, "pinned"))).toContain("3 der pinned Flächen sind");
    await setLanguage("en");
    expect(plainWarning(NARROW(3, "pinned"))).toContain("3 of the pinned faces are too narrow");
  });
});

describe("the choose Fine tail", () => {
  it("is there for a Standard run and gone for a Fine run, in German", async () => {
    await setLanguage("de");
    const body = "Das Netz ist für die dünnsten Wände zu grob, daher wirken sie steifer, als sie sind.";
    expect(plainWarningFor(THIN, false)).toBe(body + PICK_DE);
    expect(plainWarningFor(THIN, true)).toBe(body);
    expect(plainWarningFor(NARROW(2, "held"), true)).not.toContain("Fein");
  });

  it("is gone from the unsettled warning when the engine said allowing more elements", async () => {
    await setLanguage("de");
    const said = (pct: number) =>
      `Die Spitze hat sich beim letzten Durchgang um ${pct} % bewegt, daher hat sie sich möglicherweise noch nicht eingependelt.`;
    expect(plainWarningFor(UNSETTLED_FINE, false)).toBe(said(12) + PICK_DE);
    expect(plainWarningFor(UNSETTLED_FINE, true)).toBe(said(12));
    expect(plainWarningFor(UNSETTLED_FINER, false)).toBe(said(7));
  });

  it("keeps may not have settled a possibility in every language", async () => {
    const said: Record<string, string> = {};
    for (const code of OTHERS) {
      await setLanguage(code);
      said[code] = plainWarningFor(UNSETTLED_FINER, true);
    }
    expect(said.ja).toBe("最後のパスでピークが 7% 動きました。まだ収束していない可能性があります。");
    expect(said.de).toContain("möglicherweise");
    expect(said.fr).toContain("il se peut");
    expect(said.es).toContain("puede que");
    expect(said["zh-CN"]).toContain("可能");
    expect(said.ja).not.toContain("収束していません");
  });
});

describe("the engine's own numbers", () => {
  it("get the language's mark in the memory refusal, text by text", async () => {
    await setLanguage("de");
    expect(plainError(MEMORY, true)).toBe(
      "Diese Untersuchung braucht etwa 5,4 GB Speicher, mehr als die 3,2 GB, die sie nutzen darf.",
    );
    await setLanguage("ja");
    expect(plainError(MEMORY, true)).toBe("この検討には約 5.4 GB のメモリが必要で、使用できる 3.2 GB を超えています。");
    await setLanguage("en");
    expect(plainError(MEMORY, true)).toBe("This study needs about 5.4 GB of memory, more than the 3.2 GB it may use.");
  });

  it("get it in the thinnest wall words, a coordinate list joined as the language joins it", async () => {
    const message = THIN_WALL_REFUSAL + WALL_EXAMPLE;
    await setLanguage("de");
    const head = "Das Netz zerfällt in den dünnen Wänden dieses Körpers.";
    const wall = "Die dünnste Wand ist etwa 0,45 mm dick, nahe (12,0; -3,5; 7,0) mm.";
    expect(plainError(message, true)).toBe(`${head} ${wall}`);
    expect(plainError(message)).toBe(`${head} ${wall} Dickere Wände würden die Berechnung ermöglichen.`);
    await setLanguage("ja");
    expect(plainError(message, true)).toBe(
      "このボディの薄い壁でメッシュが崩れます。最も薄い壁の厚さは約 0.45 mm で、(12.0, -3.5, 7.0) mm 付近です。",
    );
    await setLanguage("en");
    expect(plainError(message)).toBe(
      "The mesh comes apart in the thin walls of this body. The thinnest wall is about 0.45 mm thick, near (12.0, -3.5, 7.0) mm. Thicker walls would let it run.",
    );
  });

  it("name the fix only when no finer run is offered, in German", async () => {
    await setLanguage("de");
    expect(plainError(FIXED_FACE, false)).toBe(
      "Die feste Fläche ist zu schmal, als dass das Netz sie erreicht. Wählen Sie eine breitere Fläche.",
    );
    expect(plainError(FIXED_FACE, true)).toBe("Die feste Fläche ist zu schmal, als dass das Netz sie erreicht.");
  });
});

describe("the names inside a warning", () => {
  it("say which support or load a spot belongs to, with the numbers as numbers", async () => {
    const support = warning("small spot of a support");
    const load = warning("small spot of a load");
    await setLanguage("de");
    expect(plainWarningFor(support, true)).toBe(
      "Stelle 3 von Halterung 2 ist winzig im Vergleich zum Netz, daher ist die Spannung genau dort nur grob.",
    );
    expect(plainWarningFor(load, true)).toBe(
      "Stelle 2 von Last 4 ist winzig im Vergleich zum Netz, daher ist die Spannung genau dort nur grob.",
    );
    await setLanguage("ja");
    expect(plainWarningFor(load, true)).toBe(
      "荷重 4 のスポット 2はメッシュに比べて小さいため、その位置の応力は大まかな値です。",
    );
  });

  it("say which kind of support ends at the peak, and show a kind it does not know as it came", async () => {
    const edge = (words: string) => `the peak stress is where a ${words} ends, look at the colour away from it`;
    await setLanguage("de");
    const said = (what: string) =>
      `Die Spitze liegt dort, wo ${what} endet. Die Spannung dort wächst, je feiner das Netz ist, lesen Sie die Farbe daher etwas daneben ab.`;
    expect(
      ["fixed spot", "fixed face", "pinned face", "slider face", "hinged face"].map((w) => plainWarning(edge(w))),
    ).toEqual(
      ["eine feste Stelle", "eine feste Fläche", "eine drehbare Fläche", "eine gleitende Fläche", "hinged face"].map(
        said,
      ),
    );
    await setLanguage("en");
    expect(plainWarning(edge("hinged face"))).toContain("where a hinged face ends.");
  });

  it("falls back to the panel's words when a spot label does not parse", async () => {
    const odd = "spot 2 of body (radius 0.300 mm) is smaller than the elements (1.250 mm), so it takes about one";
    await setLanguage("de");
    expect(plainWarningFor(odd, true)).toBe(
      "Spot 2 of body ist winzig im Vergleich zum Netz, daher ist die Spannung genau dort nur grob.",
    );
  });
});

describe("a text no rule knows", () => {
  it("passes through as the engine sent it, in any language", async () => {
    const unknown = "the refinement stopped after 2 of its passes because the time ran out, so the peak may read lower";
    const unknownRefusal = "support 2 (supports[1].faces[0]) matches no face of body1";
    for (const code of ["en", "de", "ja"]) {
      await setLanguage(code);
      expect(plainWarning(unknown)).toBe(sentence(panelMessage(unknown)));
      expect(plainWarning(unknown)).toBe(
        "The refinement stopped after 2 of its passes because the time ran out, so the peak may read lower.",
      );
      expect(plainError(unknownRefusal)).toBe("Support 2 matches no face of body1.");
    }
  });

  it("keeps English the byte for byte text of the same line", async () => {
    await setLanguage("en");
    const args = { n: 2, which: "held", pick: "fine" };
    expect(plainWarning(NARROW(2, "held"))).toBe(tEnglish("stress.warn.narrowFaces", args));
    expect(plainWarning(NARROW(2, "held"))).toBe(
      "2 of the held faces are too narrow for the mesh and hold nothing. Choose Fine under Mesh detail in More options.",
    );
  });
});
