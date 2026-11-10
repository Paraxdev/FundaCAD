import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import en from "../../src/i18n/locales/en.json";
import { createDocumentActions } from "../../src/app/documentActions";
import { usePanelsStore } from "../../src/stores/panels";
import { useToastStore } from "../../src/stores/toasts";
import type { Engine } from "../../src/app/engine";

function engine(sketchActive: boolean, markPlace = vi.fn(() => "top")) {
  return { sketch: { active: sketchActive }, tools: { move: { pending: false } }, store: { markPlace } } as unknown as Engine;
}

describe("undoIfLatest while Stress is open", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => setLanguage("system"));

  it("says it in English and in German, and does not undo", async () => {
    const markPlace = vi.fn(() => "top");
    const actions = createDocumentActions(engine(false, markPlace));
    (usePanelsStore() as { stress: unknown }).stress = { id: 7 };
    const shown = () => useToastStore().items.map((x) => x.message);
    actions.undoIfLatest(5);
    expect(shown()).toEqual([en["history.closeStressFirst"]]);
    useToastStore().items.splice(0);
    await setLanguage("de");
    actions.undoIfLatest(9);
    expect(shown()).toEqual([de["history.closeStressFirst"]]);
    expect(en["history.closeStressFirst"]).not.toBe(de["history.closeStressFirst"]);
    expect(markPlace).not.toHaveBeenCalled();
  });

  it("an open sketch still wins over an open Stress", () => {
    const actions = createDocumentActions(engine(true));
    (usePanelsStore() as { stress: unknown }).stress = { id: 7 };
    actions.undoIfLatest(5);
    expect(useToastStore().items.map((x) => x.message)).toEqual(["Finish the sketch first, then undo."]);
  });
});
