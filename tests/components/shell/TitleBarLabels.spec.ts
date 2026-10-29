// Undo and Redo are icon buttons, so their names come from aria-label; the
// keys in the tooltip are not part of the name a screen reader says.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ENGINE } from "../../../src/app/engineKey";
import { useUiStore } from "../../../src/stores/ui";
import TitleBar from "../../../src/components/shell/TitleBar.vue";

vi.mock("../../../src/app/menubarDef", () => ({ buildMenubar: () => [] }));

enableAutoUnmount(afterEach);

const engine = { doUndo: vi.fn(), doRedo: vi.fn() };

function mountBar() {
  engine.doUndo.mockClear();
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(TitleBar, {
    attachTo: document.body,
    global: {
      plugins: [pinia],
      provide: { [ENGINE as symbol]: engine },
      stubs: { WorkspaceToggle: true, MenuBar: true, LiveSessionPill: true, ErrorNotice: true },
    },
  });
}

describe("TitleBar undo and redo", () => {
  it("names both buttons for screen readers", () => {
    const w = mountBar();
    expect(w.get("#undo-btn").attributes("aria-label")).toBe("Undo");
    expect(w.get("#redo-btn").attributes("aria-label")).toBe("Redo");
    expect(w.get("#undo-btn").attributes("title")).toBe("Undo (Ctrl+Z)");
    expect(w.get("#redo-btn").attributes("title")).toBe("Redo (Ctrl+Y)");
  });

  it("keeps the disabled state with the label", async () => {
    const w = mountBar();
    expect(w.get("#undo-btn").attributes("aria-disabled")).toBe("true");
    useUiStore().canUndo = true;
    await nextTick();
    expect(w.get("#undo-btn").attributes("aria-disabled")).toBeUndefined();
    expect(w.get("#redo-btn").attributes("aria-disabled")).toBe("true");
    expect(w.get("#undo-btn").attributes("title")).toBe("Undo (Ctrl+Z)");
  });

  it("refuses a click and Enter while there is nothing to undo, and takes them once there is", async () => {
    const w = mountBar();
    await new Promise((r) => setTimeout(r, 2));
    const undo = w.get("#undo-btn").element as HTMLButtonElement;
    undo.click();
    undo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(engine.doUndo).not.toHaveBeenCalled();
    useUiStore().canUndo = true;
    await nextTick();
    undo.click();
    expect(engine.doUndo).toHaveBeenCalledTimes(1);
  });
});

describe("TitleBar undo and redo toolbar", () => {
  const press = (key: string) =>
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  it("puts both buttons in one named toolbar with one Tab stop, even while both are disabled", async () => {
    const w = mountBar();
    await nextTick();
    const bar = w.get("[role=toolbar]");
    expect(bar.attributes("aria-label")).toBe("Undo and redo");
    expect(bar.find("#undo-btn").exists() && bar.find("#redo-btn").exists()).toBe(true);
    expect([w.get("#undo-btn").attributes("tabindex"), w.get("#redo-btn").attributes("tabindex")]).toEqual(["0", "-1"]);
  });

  it("walks Undo and Redo with the arrows and moves the Tab stop along", async () => {
    const w = mountBar();
    useUiStore().canRedo = true;
    await nextTick();
    (w.get("#undo-btn").element as HTMLElement).focus();
    press("ArrowRight");
    expect(document.activeElement?.id).toBe("redo-btn");
    expect([w.get("#undo-btn").attributes("tabindex"), w.get("#redo-btn").attributes("tabindex")]).toEqual(["-1", "0"]);
    press("ArrowLeft");
    expect(document.activeElement?.id).toBe("undo-btn");
  });
});
