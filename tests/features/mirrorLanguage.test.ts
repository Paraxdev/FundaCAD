// The Mirror tool's pick prompt and counts follow the chosen language, and read right in a language with one plural form.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { countLabel, nextPick, type MirrorFields } from "../../src/features/mirrorFields";

afterEach(async () => {
  await setLanguage("system");
});

const fields = (objects: string[], line: string | null, active: "objects" | "line"): MirrorFields<string> => ({
  objects,
  line,
  lineId: line ? "ax7" : null,
  active,
});

const ENGLISH = /\b(pick|mirror|nothing|bod(y|ies)|objects?|cancel|done|more|then)\b/i;

describe("countLabel", () => {
  it("counts 0, 1, 2 and 5 in German", async () => {
    await setLanguage("de");
    expect([0, 1, 2, 5].map((n) => countLabel(n, "body"))).toEqual([
      "Nichts gewählt",
      "1 Körper",
      "2 Körper",
      "5 Körper",
    ]);
    expect([0, 1, 2, 5].map((n) => countLabel(n, "object"))).toEqual([
      "Nichts gewählt",
      "1 Objekt",
      "2 Objekte",
      "5 Objekte",
    ]);
  });

  it("counts 0, 1, 2 and 5 in Japanese, which has one plural form", async () => {
    await setLanguage("ja");
    expect([0, 1, 2, 5].map((n) => countLabel(n, "body"))).toEqual([
      "何も選ばれていません",
      "1 ボディ",
      "2 ボディ",
      "5 ボディ",
    ]);
    expect([0, 1, 2, 5].map((n) => countLabel(n, "object"))).toEqual([
      "何も選ばれていません",
      "1 オブジェクト",
      "2 オブジェクト",
      "5 オブジェクト",
    ]);
  });

  it("keeps the English wording, and follows a switch back", async () => {
    await setLanguage("de");
    expect(countLabel(3, "object")).toBe("3 Objekte");
    await setLanguage("en");
    expect([0, 1, 2, 5].map((n) => countLabel(n, "body"))).toEqual([
      "Nothing picked",
      "1 body",
      "2 bodies",
      "5 bodies",
    ]);
    expect([1, 5].map((n) => countLabel(n, "object"))).toEqual(["1 object", "5 objects"]);
  });
});

describe("nextPick", () => {
  const states = () => ({
    plane: nextPick(fields([], null, "line"), "plane"),
    line: nextPick(fields(["e4", "e9"], null, "line"), "line"),
    none: nextPick(fields([], null, "objects"), "plane"),
    some: nextPick(fields(["e4"], null, "objects"), "plane"),
    ready: nextPick(fields(["e4", "e9"], "ax7", "objects"), "plane"),
    readyList: nextPick(fields(["e4", "e9"], "ax7", "objects"), "plane", true),
    lineSet: nextPick(fields(["e4"], "ax7", "line"), "line", true),
  });

  it("says each state in German, with and without the list row", async () => {
    await setLanguage("de");
    expect(states()).toEqual({
      plane: "Wählen Sie die Spiegelebene",
      line: "Wählen Sie die Spiegellinie",
      none: "Wählen Sie, was gespiegelt werden soll",
      some: "Wählen Sie, was gespiegelt werden soll, Enter zum Abschließen",
      ready: "Enter zum Spiegeln, oder wählen Sie weitere Elemente",
      readyList: "F6 zur Ansicht, dann Enter zum Spiegeln, oder wählen Sie weitere Elemente",
      lineSet: "Wählen Sie die Spiegellinie",
    });
  });

  it("says each state in Japanese", async () => {
    await setLanguage("ja");
    expect(states()).toEqual({
      plane: "ミラーの平面を選んでください",
      line: "ミラーの線を選んでください",
      none: "ミラーするものを選んでください",
      some: "ミラーするものを選び、終わったら Enter を押してください",
      ready: "Enter でミラーします。さらに選ぶこともできます",
      readyList: "F6 でビューに移り、Enter でミラーします。さらに選ぶこともできます",
      lineSet: "ミラーの線を選んでください",
    });
  });

  it("holds no English in a German prompt and keeps the English one whole", async () => {
    await setLanguage("de");
    const line = `${nextPick(fields(["e4"], null, "objects"), "plane")} · ${countLabel(3, "body")} · ${t("mirror.escCancel")}`;
    expect(line).toBe("Wählen Sie, was gespiegelt werden soll, Enter zum Abschließen · 3 Körper · Esc bricht ab");
    for (const s of Object.values(states())) expect(s).not.toMatch(ENGLISH);
    await setLanguage("en");
    expect(states()).toEqual({
      plane: "Pick the mirror plane",
      line: "Pick the mirror line",
      none: "Pick what to mirror",
      some: "Pick what to mirror, Enter when done",
      ready: "Enter to mirror, or pick more to mirror",
      readyList: "F6 to the view, then Enter to mirror, or pick more to mirror",
      lineSet: "Pick the mirror line",
    });
    expect(t("mirror.escCancel")).toBe("Esc to cancel");
  });
});
