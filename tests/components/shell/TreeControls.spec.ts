import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TreeRow from "../../../src/components/shell/TreeRow.vue";
import TreeFolder from "../../../src/components/shell/TreeFolder.vue";
import { useBrowserStore } from "../../../src/stores/browser";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

const row = (props: Record<string, unknown> = {}) =>
  mount(TreeRow, { props: { label: "Plate", icon: "body", depth: 1, ...props }, attachTo: document.body });
const folder = (props: Record<string, unknown> = {}) =>
  mount(TreeFolder, {
    props: { label: "Robot", icon: "folder", count: 2, depth: 0, collapsed: true, ...props },
    attachTo: document.body,
  });

describe("tree row eye", () => {
  it("is a base icon button that keeps its class, state and title", () => {
    const w = row({ toggleVis: vi.fn(), visible: false });
    const eye = w.get(".tree-eye");
    expect(eye.element.tagName).toBe("BUTTON");
    expect(eye.classes()).toContain("icon-btn");
    expect(eye.attributes("data-visible")).toBe("false");
    expect(eye.attributes("title")).toContain("Show/hide");
    expect(eye.attributes("aria-label")).toContain("Show/hide");
    expect(eye.find("svg").attributes("data-icon")).toBe("hidden");
  });

  it("toggles on a keyboard click and neither selects nor edits the row", async () => {
    const toggleVis = vi.fn();
    const activate = vi.fn();
    const edit = vi.fn();
    const w = row({ toggleVis, activate, edit });
    await w.get(".tree-eye").trigger("click");
    await w.get(".tree-eye").trigger("dblclick");
    expect(toggleVis).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("paints from its press, so a pointer click after it does not toggle again", async () => {
    const toggleVis = vi.fn();
    const eyeDown = vi.fn();
    const w = row({ toggleVis, eyeDown });
    await w.get(".tree-eye").trigger("pointerdown", { button: 0, altKey: true });
    await w.get(".tree-eye").trigger("click", { detail: 1 });
    expect(eyeDown).toHaveBeenCalledTimes(1);
    expect((eyeDown.mock.calls[0]![0] as PointerEvent).altKey).toBe(true);
    expect(toggleVis).not.toHaveBeenCalled();
  });

  it("renders no eye when the row has no visibility", () => {
    expect(row().find(".tree-eye").exists()).toBe(false);
  });
});

describe("tree folder caret and eye", () => {
  it("the caret is a base icon button that names and toggles the disclosure", async () => {
    const w = folder({ activate: vi.fn() });
    const caret = w.get(".tree-caret");
    expect(caret.element.tagName).toBe("BUTTON");
    expect(caret.attributes("aria-label")).toBe("Expand");
    expect(caret.attributes("aria-expanded")).toBe("false");
    await caret.trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
    await w.setProps({ collapsed: false });
    expect(w.get(".tree-caret").attributes("aria-label")).toBe("Collapse");
    expect(w.get(".tree-folder").attributes("aria-expanded")).toBe("true");
  });

  it("a click on the head selects instead of toggling when the folder selects", async () => {
    const activate = vi.fn();
    const w = folder({ activate });
    await w.get(".tree-label").trigger("click");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(w.emitted("toggle")).toBeUndefined();
  });

  it("the eye toggles without collapsing the folder", async () => {
    const toggleVis = vi.fn();
    const w = folder({ toggleVis, visible: true });
    const eye = w.get(".tree-eye");
    expect(eye.element.tagName).toBe("BUTTON");
    await eye.trigger("click");
    expect(toggleVis).toHaveBeenCalledTimes(1);
    expect(w.emitted("toggle")).toBeUndefined();
  });
});

describe("rename field inside a tree head", () => {
  async function renaming<T extends { find: ReturnType<typeof row>["find"] }>(mountIt: () => T) {
    useBrowserStore().pendingRenameId = "n1";
    const w = mountIt();
    await nextTick();
    await nextTick();
    return { w, input: w.find(".tree-label.renaming input") };
  }
  const shiftPress = (el: Element) => {
    const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("a double click in a row's field selects a word and does not edit the row", async () => {
    const edit = vi.fn();
    const { input } = await renaming(() => row({ id: "n1", edit, rename: vi.fn() }));
    expect(input.exists()).toBe(true);
    await input.trigger("dblclick");
    expect(edit).not.toHaveBeenCalled();
  });

  it("a Shift press keeps the caret in the field but takes a run anywhere else on the row", async () => {
    const { w, input } = await renaming(() => row({ id: "n1", rename: vi.fn() }));
    expect(shiftPress(input.element)).toBe(false);
    expect(shiftPress(w.get(".feature-icon").element)).toBe(true);
  });

  it("a double click in a folder's field does not fold it", async () => {
    const { w, input } = await renaming(() => folder({ id: "n1", activate: vi.fn(), rename: vi.fn() }));
    expect(input.exists()).toBe(true);
    await input.trigger("dblclick");
    expect(shiftPress(input.element)).toBe(false);
    expect(w.emitted("toggle")).toBeUndefined();
  });
});
