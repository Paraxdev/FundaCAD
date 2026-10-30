import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { buildMenubar } from "../../src/app/menubarDef";
import { usePanelsStore } from "../../src/stores/panels";
import type { Engine } from "../../src/app/engine";

describe("Undo and Redo in the Edit menu", () => {
  beforeEach(() => setActivePinia(createPinia()));

  const offFor = (e: unknown) => {
    const edit = buildMenubar(e as Engine).find((m) => m.label === "Edit")!;
    const item = (label: string) => edit.items.find((i) => i.label === label)!;
    return () => [item("Undo").disabled?.(), item("Redo").disabled?.()];
  };

  it("follow the Stress setup while the panel is open, and the model once it closes", () => {
    const off = offFor({ sketch: { active: false }, store: { canUndo: true, canRedo: false } });
    const panels = usePanelsStore();
    panels.showStress("body1");
    expect(off()).toEqual([true, true]);
    panels.stress!.canRedo = true;
    expect(off()).toEqual([true, false]);
    panels.stress = null;
    expect(off()).toEqual([false, true]);
  });

  it("follow an open sketch before Stress", () => {
    const sketch = { active: true, canUndoSketch: true, canRedoSketch: false };
    const off = offFor({ sketch, store: { canUndo: false, canRedo: true } });
    usePanelsStore().showStress("body1");
    expect(off()).toEqual([false, true]);
  });
});
