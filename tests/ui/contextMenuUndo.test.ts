import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import { useContextMenuStore } from "../../src/stores/contextMenu";
import { usePanelsStore } from "../../src/stores/panels";

function setup(sketch = { active: false, canUndoSketch: false, canRedoSketch: false }) {
  const store = { canUndo: true, canRedo: false, undo: vi.fn(), redo: vi.fn() };
  const handleAction = vi.fn();
  const deps = { store, sketch, viewport: {}, handleAction, getLastAction: () => null } as unknown as ContextMenusDeps;
  const open = () => {
    createContextMenus(deps).openEmptyMenu(10, 10);
    const items = useContextMenuStore().items;
    const row = (label: string) => items.find((i) => i.label === label)!;
    return { undo: row("Undo"), redo: row("Redo") };
  };
  return { store, handleAction, open };
}

describe("Undo and Redo on the viewport menu", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("run the same action as Ctrl+Z and Ctrl+Y, never the model's undo directly", () => {
    const s = setup();
    usePanelsStore().showStress("body1");
    const { undo, redo } = s.open();
    undo.onClick?.();
    redo.onClick?.();
    expect(s.handleAction.mock.calls).toEqual([["undo"], ["redo"]]);
    expect(s.store.undo).not.toHaveBeenCalled();
    expect(s.store.redo).not.toHaveBeenCalled();
  });

  it("follow the Stress setup while the panel is open, and the model once it closes", () => {
    const s = setup();
    const panels = usePanelsStore();
    const off = () => {
      const { undo, redo } = s.open();
      return [undo.disabled, redo.disabled];
    };
    panels.showStress("body1");
    expect(off()).toEqual([true, true]);
    panels.stress!.canRedo = true;
    expect(off()).toEqual([true, false]);
    panels.stress = null;
    expect(off()).toEqual([false, true]);
  });

  it("follow an open sketch before Stress", () => {
    const s = setup({ active: true, canUndoSketch: false, canRedoSketch: true });
    usePanelsStore().showStress("body1");
    const { undo, redo } = s.open();
    expect([undo.disabled, redo.disabled]).toEqual([true, false]);
  });
});
