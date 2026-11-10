import { afterEach, describe, expect, it } from "vitest";
import { sketchStepName, stepMenuText } from "../../src/ui/canStep";
import { setLanguage } from "../../src/i18n";

afterEach(async () => {
  await setLanguage("system");
});

const exact = "Move Bracket with the long name!";

describe("stepMenuText in English", () => {
  it("is the bare verb with no step", () => {
    expect(stepMenuText("undo", null)).toBe("Undo");
    expect(stepMenuText("redo", "")).toBe("Redo");
  });

  it("puts the step after the verb", () => {
    expect(stepMenuText("undo", "Fillet 2")).toBe("Undo Fillet 2");
    expect(stepMenuText("redo", "Delete 3 steps")).toBe("Redo Delete 3 steps");
  });

  it("clips at 32 characters with an ellipsis, and 32 exactly stays whole", () => {
    expect(exact).toHaveLength(32);
    expect(stepMenuText("undo", exact)).toBe(`Undo ${exact}`);
    expect(stepMenuText("undo", `${exact}X`)).toBe(`Undo ${exact}…`);
    expect(stepMenuText("redo", exact.repeat(2))).toBe(`Redo ${exact}…`);
  });

  it("names the sketch step", () => {
    expect(sketchStepName()).toBe("sketch edit");
    expect(stepMenuText("undo", sketchStepName())).toBe("Undo sketch edit");
  });
});

describe("stepMenuText in German", () => {
  it("is the bare verb with no step", async () => {
    await setLanguage("de");
    expect(stepMenuText("undo", null)).toBe("Rückgängig");
    expect(stepMenuText("redo", null)).toBe("Wiederholen");
  });

  it("puts the verb first, so a clipped step never pushes it away", async () => {
    await setLanguage("de");
    expect(stepMenuText("undo", "Fase 4")).toBe("Rückgängig: Fase 4");
    expect(stepMenuText("redo", "Fase 4")).toBe("Wiederholen: Fase 4");
  });

  it("clips at 32 characters, 32 exactly stays whole", async () => {
    await setLanguage("de");
    expect(stepMenuText("undo", exact)).toBe(`Rückgängig: ${exact}`);
    expect(stepMenuText("undo", `${exact}X`)).toBe(`Rückgängig: ${exact}…`);
  });

  it("names the sketch step", async () => {
    await setLanguage("de");
    expect(sketchStepName()).toBe("Skizzenänderung");
    expect(stepMenuText("redo", sketchStepName())).toBe("Wiederholen: Skizzenänderung");
  });
});

describe("stepMenuText in Japanese", () => {
  it("puts the verb first with a step, the bare verb without", async () => {
    await setLanguage("ja");
    expect([stepMenuText("undo", "フィレット 2"), stepMenuText("redo", "フィレット 2")]).toEqual([
      "元に戻す: フィレット 2",
      "やり直し: フィレット 2",
    ]);
    expect([stepMenuText("undo", null), stepMenuText("redo", null)]).toEqual(["元に戻す", "やり直し"]);
  });
});
