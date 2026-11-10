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

  it("puts the step where German wants it", async () => {
    await setLanguage("de");
    expect(stepMenuText("undo", "Fase 4")).toBe("Fase 4 rückgängig machen");
    expect(stepMenuText("redo", "Fase 4")).toBe("Fase 4 wiederholen");
  });

  it("clips at 32 characters, 32 exactly stays whole", async () => {
    await setLanguage("de");
    expect(stepMenuText("undo", exact)).toBe(`${exact} rückgängig machen`);
    expect(stepMenuText("undo", `${exact}X`)).toBe(`${exact}… rückgängig machen`);
  });

  it("names the sketch step", async () => {
    await setLanguage("de");
    expect(sketchStepName()).toBe("Skizzenänderung");
    expect(stepMenuText("redo", sketchStepName())).toBe("Skizzenänderung wiederholen");
  });
});
