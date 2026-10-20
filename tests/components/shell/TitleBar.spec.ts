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

function mountBar() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(TitleBar, {
    global: {
      plugins: [pinia],
      provide: { [ENGINE as symbol]: {} },
      stubs: { WorkspaceToggle: true, MenuBar: true, LiveSessionPill: true, ErrorNotice: true },
    },
  });
}

describe("TitleBar undo and redo", () => {
  it("names both buttons for screen readers", () => {
    const w = mountBar();
    expect(w.get("#undo-btn").attributes("aria-label")).toBe("Undo");
    expect(w.get("#redo-btn").attributes("aria-label")).toBe("Redo");
  });

  it("keeps the disabled state with the label", async () => {
    const w = mountBar();
    expect(w.get("#undo-btn").attributes("disabled")).toBeDefined();
    useUiStore().canUndo = true;
    await nextTick();
    expect(w.get("#undo-btn").attributes("disabled")).toBeUndefined();
    expect(w.get("#redo-btn").attributes("disabled")).toBeDefined();
  });
});
