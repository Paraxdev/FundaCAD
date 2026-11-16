// The sketch prompts, the dimension tool's hints and errors and the labels on a shape's dimensions read in the chosen
// language, are built when they are shown so they follow a switch, and still read exactly as before in English.
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../../src/i18n";
import { isDimError, resolveDim, unsupportedMessage, type DimTarget } from "../../src/sketch/dimensionTool";
import { entityDims } from "../../src/sketch/entityDims";
import { dimTitle, glyphTitle } from "../../src/sketch/annotationFormat";
import type { ResolvedEntity } from "../../src/sketch/snap";

afterEach(() => setLanguage("system"));

const line: ResolvedEntity = { type: "line", id: "l", x1: 0, y1: 0, x2: 10, y2: 0 };
const flat: ResolvedEntity = { type: "line", id: "z", x1: 2, y1: 2, x2: 2, y2: 2 };
const rect: ResolvedEntity = { type: "rectangle", id: "r", x: 0, y: 0, width: 20, height: 10 };
const pick = (e: ResolvedEntity): DimTarget => ({ kind: "entity", e });

const linePlan = () => {
  const r = resolveDim([pick(line)]);
  if (isDimError(r)) throw new Error(r.message);
  return { label: r.fields[0]!.label, hint: r.hint };
};
const message = (picks: DimTarget[]) => {
  const r = resolveDim(picks);
  if (!isDimError(r)) throw new Error("expected an error");
  return r.message;
};
const labels = () => entityDims(rect).map((d) => d.label);

describe("the dimension tool", () => {
  it("reads its label, hint and errors in German and Japanese, read again after each switch", async () => {
    expect(linePlan()).toEqual({
      label: "Length",
      hint: "Line: type a length, or pick a second entity · click to place",
    });
    expect(message([pick(flat)])).toBe("That line measures 0, nothing to drive.");

    await setLanguage("de");
    expect(linePlan()).toEqual({
      label: "Länge",
      hint: "Linie: Länge eingeben oder ein zweites Element wählen · klicken zum Platzieren",
    });
    expect(message([pick(flat)])).toBe("Diese Linie misst 0, es gibt nichts zu steuern.");
    expect(unsupportedMessage("text")).toMatch(/^Ein Text lässt sich noch nicht bemaßen/);

    await setLanguage("ja");
    expect(linePlan().label).toBe("長さ");
    expect(linePlan().hint).toBe("線: 長さを入力するか、2 つ目の要素を選択 · クリックで配置");
    expect(message([pick(flat)])).toBe("その線の寸法は 0 なので、駆動するものがありません。");
  });

  it("keeps the English it had", () => {
    expect(unsupportedMessage("text")).toBe(
      "A text can't be dimensioned yet, pick a line, arc, circle or rectangle edge.",
    );
    expect(unsupportedMessage("spline")).toMatch(/^A spline can't/);
  });
});

describe("a shape's dimension labels", () => {
  it("follow a switch on the next build", async () => {
    expect(labels()).toEqual(["Width", "Height"]);
    await setLanguage("de");
    expect(labels()).toEqual(["Breite", "Höhe"]);
    await setLanguage("ja");
    expect(labels()).toEqual(["幅", "高さ"]);
  });
});

describe("the badges and constraint glyphs", () => {
  it("read in German and Japanese", async () => {
    await setLanguage("de");
    expect(glyphTitle("conflict")).toBe("Widersprüchliche Abhängigkeit, klicken zum Auswählen, Entf entfernt sie");
    expect(dimTitle({ driven: true })).toBe("Referenzbemaßung (gemessen, nicht steuernd)");
    await setLanguage("ja");
    expect(glyphTitle(null)).toBe("クリックで選択、Delete キーで削除");
    expect(dimTitle({ fx: true, expr: "width / 2" })).toBe("= width / 2 · クリックで編集");
  });
});

describe("the sketch mode lines", () => {
  it("read in German and Japanese, with their counts", async () => {
    await setLanguage("de");
    expect(t("sketch.mode.tied", { n: 1, rest: 2 })).toBe("1 offenes Ende verbunden, 2 übrig");
    expect(t("sketch.mode.tied", { n: 3, rest: 0 })).toBe("3 offene Enden verbunden");
    expect(t("sketch.menu.delete", { n: 4 })).toBe("4 Elemente löschen");
    expect(t("sketch.mode.nothingToUndo")).toBe("In dieser Skizze gibt es nichts mehr rückgängig zu machen");
    await setLanguage("ja");
    expect(t("sketch.mode.patternPick", { n: 2, circular: "yes" })).toBe(
      "2 個を選択 · さらにクリックで追加 · 中心をクリック · Esc",
    );
    expect(t("sketch.mode.tieWouldOverConstrain", { reach: "no" })).toBe(
      "これらの端を結合するとスケッチが過拘束になります",
    );
  });

  it("say in English what the old text said", () => {
    const tied = (n: number, rest: number) => `Tied ${n} loose end${n === 1 ? "" : "s"}${rest ? `, ${rest} left` : ""}`;
    for (const [n, rest] of [
      [1, 0],
      [1, 2],
      [3, 0],
      [3, 1],
    ] as const)
      expect(t("sketch.mode.tied", { n, rest })).toBe(tied(n, rest));
    expect(t("sketch.mode.tieWouldOverConstrain", { reach: "yes" })).toBe(
      "Tying these ends would over constrain the sketch, draw a line to close the gap",
    );
    expect(t("sketch.mode.patternPick", { n: 2, circular: "no" })).toBe(
      "2 picked · click more to add · click where the pattern starts · Esc",
    );
    expect(t("sketch.mode.patternsRemoved", { n: 1 })).toBe(
      "A pattern was removed: its source entity no longer exists",
    );
    expect(t("sketch.mode.patternsRemoved", { n: 3 })).toBe(
      "3 patterns were removed: their source entities no longer exist",
    );
    expect([1, 2].map((n) => t("sketch.menu.breakLink", { n }))).toEqual(["Break Link", "Break Link (2)"]);
    expect([0, 1, 5].map((n) => t("sketch.menu.delete", { n }))).toEqual(["Delete", "Delete", "Delete 5 entities"]);
    expect(t("sketch.mode.tieGap", { n: 2, gap: "0.4" })).toBe("Tie the 2 open ends across the 0.4 mm gap?");
  });
});
