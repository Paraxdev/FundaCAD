import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, type Component } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TreeRow from "../../../src/components/shell/TreeRow.vue";
import TreeFolder from "../../../src/components/shell/TreeFolder.vue";
import { useBrowserStore } from "../../../src/stores/browser";
import { useContextMenuStore } from "../../../src/stores/contextMenu";
import Tree from "../../../src/components/ui/Tree.vue";
import type { TreeMeta } from "../../../src/components/ui/treeContext";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

const row = (props: Record<string, unknown> = {}) =>
  mount(TreeRow, { props: { label: "Plate", icon: "body", depth: 1, ...props }, attachTo: document.body });
const folder = (props: Record<string, unknown> = {}) =>
  mount(TreeFolder, {
    props: { label: "Robot", icon: "folder", count: 2, depth: 0, collapsed: true, ...props },
    attachTo: document.body,
  });

// vue-tsc types an SFC whose props hold the Named union as a function h() will not take.
const TreeC = Tree as unknown as Component;
// Vue skips a handler attached in the same millisecond an event was first seen in, and the row's capture listener sees
// a key first, so the keys wait a tick of the clock after the mount.
async function inTree(comp: Component, props: Record<string, unknown>, meta: Partial<TreeMeta> = {}) {
  const host = defineComponent({
    emits: ["tree"],
    setup(_, { emit }) {
      const items: TreeMeta[] = [{ key: "k", level: 1, label: "Plate", ...meta }];
      const on =
        (name: string) =>
        (...args: unknown[]) =>
          emit("tree", name, ...args);
      return () =>
        h(
          TreeC,
          {
            label: "Items",
            multiselectable: true,
            items,
            onSelect: on("select"),
            onOpen: on("open"),
            onRename: on("rename"),
            onRemove: on("remove"),
            onMenu: on("menu"),
            onToggle: on("toggle"),
          },
          { default: () => h(comp, { treeKey: "k", ...props }) },
        );
    },
  });
  const w = mount(host, { attachTo: document.body });
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

describe("tree row eye", () => {
  it("is a base icon button that keeps its class, state and title", () => {
    const w = row({ toggleVis: vi.fn(), visible: false });
    const eye = w.get(".tree-eye");
    expect(eye.element.tagName).toBe("BUTTON");
    expect(eye.classes()).toContain("icon-btn");
    expect(eye.attributes("data-visible")).toBe("false");
    expect(eye.attributes("title")).toContain("Show/hide");
    expect(eye.find("svg").attributes("data-icon")).toBe("hidden");
  });

  it("is named by its action and row, with the long help as its description", async () => {
    const w = row({ toggleVis: vi.fn(), visible: false });
    const eye = () => w.get(".tree-eye");
    expect([eye().attributes("aria-label"), eye().attributes("aria-pressed")]).toEqual(["Show Plate", undefined]);
    expect(document.getElementById(eye().attributes("aria-describedby")!)?.textContent).toContain("drag across eyes");
    await w.setProps({ visible: true });
    expect(eye().attributes("aria-label")).toBe("Hide Plate");
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
    expect(caret.attributes("aria-label")).toBe("Expand Robot");
    expect(caret.attributes("aria-expanded")).toBe("false");
    await caret.trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
    await w.setProps({ collapsed: false });
    expect(w.get(".tree-caret").attributes("aria-label")).toBe("Collapse Robot");
  });

  it("a pointer click on the caret drops its focus, so Enter or Space cannot fold again, a keyboard click keeps it", async () => {
    const w = folder();
    const caret = w.get<HTMLButtonElement>(".tree-caret");
    caret.element.focus();
    await caret.trigger("click", { detail: 1 });
    const keptAfterPointer = document.activeElement === caret.element;
    caret.element.focus();
    await caret.trigger("click", { detail: 0 });
    expect([keptAfterPointer, document.activeElement === caret.element, w.emitted("toggle")?.length]).toEqual([
      false,
      true,
      2,
    ]);
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

  it("the eye is named by its action and folder", () => {
    const w = folder({ toggleVis: vi.fn(), visible: false });
    expect([w.get(".tree-eye").attributes("aria-label"), w.get(".tree-eye").attributes("aria-pressed")]).toEqual([
      "Show Robot",
      undefined,
    ]);
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

describe("tree rows and heads as tree items", () => {
  afterEach(() => setMacForTest(null));
  const plate = { label: "Plate", icon: "body", depth: 1 };
  const bodies = { label: "Bodies", icon: "folder", count: 2, depth: 0 };

  it("outside a Tree a row and a head carry no tree role and no roleless aria-expanded", () => {
    expect(row().get(".feature-row").attributes("role")).toBeUndefined();
    const head = folder().get(".tree-folder");
    expect([head.attributes("role"), head.attributes("aria-expanded")]).toEqual([undefined, undefined]);
  });

  it("a row is a treeitem named by its label that keeps its class, id and title", async () => {
    const w = await inTree(TreeRow, { ...plate, id: "b1", title: "Body", selected: true, activate: vi.fn() });
    const r = w.get(".feature-row");
    expect([r.attributes("role"), r.attributes("aria-label"), r.attributes("aria-selected")]).toEqual([
      "treeitem",
      "Plate",
      "true",
    ]);
    expect([r.attributes("data-id"), r.attributes("title"), r.attributes("tabindex")]).toEqual(["b1", "Body", "0"]);
  });

  const description = (el: { attributes: (k: string) => string | undefined }) => {
    const by = el.attributes("aria-describedby");
    return by ? document.getElementById(by)?.textContent?.trim() : undefined;
  };

  it("a row says it failed, is hidden or suppressed in its description", async () => {
    const w = await inTree(TreeRow, { ...plate, error: true, suppressed: true, visible: false, toggleVis: vi.fn() });
    expect(description(w.get(".feature-row"))).toBe("failed, hidden, suppressed");
    const plain = await inTree(TreeRow, { ...plate, visible: false });
    expect(description(plain.get(".feature-row"))).toBeUndefined();
  });

  it("a head says it is hidden and how many it holds", async () => {
    const w = await inTree(TreeFolder, { ...bodies, collapsed: true, visible: false, toggleVis: vi.fn() });
    expect(description(w.get(".tree-folder"))).toBe("2 items, hidden");
    w.unmount();
    const one = await inTree(TreeFolder, { ...bodies, count: 1 });
    expect(description(one.get(".tree-folder"))).toBe("1 item");
  });

  it("the eye and caret leave the Tab order to the treeitem inside a Tree, and keep it outside one", async () => {
    const w = await inTree(TreeFolder, { ...bodies, collapsed: true, toggleVis: vi.fn() });
    expect([w.get(".tree-caret").attributes("tabindex"), w.get(".tree-eye").attributes("tabindex")]).toEqual([
      "-1",
      "-1",
    ]);
    const r = await inTree(TreeRow, { ...plate, toggleVis: vi.fn() });
    expect(r.get(".tree-eye").attributes("tabindex")).toBe("-1");
    expect(folder({ toggleVis: vi.fn() }).get(".tree-eye").attributes("tabindex")).toBeUndefined();
  });

  it("the menu of a row or head with an eye hides or shows it", async () => {
    const toggleVis = vi.fn();
    const menu = useContextMenuStore();
    const w = await inTree(TreeRow, { ...plate, visible: true, toggleVis, rename: vi.fn() });
    press(w.get(".feature-row").element, "F10", { shiftKey: true });
    expect(menu.items.map((i) => i.label)).toEqual(["Hide", "Rename"]);
    menu.items[0]!.onClick?.();
    expect(toggleVis).toHaveBeenCalledTimes(1);
    const f = await inTree(TreeFolder, { ...bodies, collapsed: true, visible: false, toggleVis });
    press(f.get(".tree-folder").element, "ContextMenu");
    expect(menu.items.map((i) => i.label)).toEqual(["Show"]);
  });

  it("Space is the platform toggle click, Shift+Space a run, and Enter a plain click without an edit", async () => {
    const activate = vi.fn();
    const w = await inTree(TreeRow, { ...plate, activate });
    const r = w.get(".feature-row").element;
    setMacForTest(false);
    press(r, " ");
    setMacForTest(true);
    press(r, " ");
    press(r, " ", { shiftKey: true });
    press(r, "Enter");
    const mods = activate.mock.calls.map(([e]) => {
      const m = e as MouseEvent;
      return [m.ctrlKey, m.metaKey, m.shiftKey];
    });
    expect(mods).toEqual([
      [true, false, false],
      [false, true, false],
      [false, true, true],
      [false, false, false],
    ]);
    expect(w.emitted("tree")).toBeUndefined();
  });

  it("Enter edits a row that edits, and Delete removes it", async () => {
    const edit = vi.fn();
    const remove = vi.fn();
    const w = await inTree(TreeRow, { ...plate, edit, remove, activate: vi.fn() });
    const r = w.get(".feature-row").element;
    press(r, "Enter");
    press(r, "Delete");
    expect([edit.mock.calls.length, remove.mock.calls.length]).toEqual([1, 1]);
  });

  it("F2 renames, and Enter in the field hands focus back to the row", async () => {
    const rename = vi.fn();
    const w = await inTree(TreeRow, { ...plate, rename });
    const r = w.get<HTMLElement>(".feature-row").element;
    r.focus();
    expect(press(r, "F2").defaultPrevented).toBe(true);
    await nextTick();
    await nextTick();
    const input = w.get<HTMLInputElement>(".tree-label.renaming input");
    await input.setValue("Lid");
    await input.trigger("keydown", { key: "Enter" });
    await new Promise((done) => setTimeout(done));
    expect(rename).toHaveBeenCalledWith("Lid");
    expect(document.activeElement).toBe(r);
  });

  it("a row with no rename leaves F2 to the Tree", async () => {
    const w = await inTree(TreeRow, plate);
    press(w.get(".feature-row").element, "F2");
    expect(w.emitted("tree")).toEqual([["rename", "k"]]);
  });

  it("Shift+F10 opens the row's own menu", async () => {
    const w = await inTree(TreeRow, { ...plate, rename: vi.fn(), remove: vi.fn() });
    press(w.get(".feature-row").element, "F10", { shiftKey: true });
    const menu = useContextMenuStore();
    expect([menu.open, menu.items.map((i) => i.label)]).toEqual([true, ["Rename", "Delete"]]);
  });

  it("a head is an expandable treeitem that Enter, Right and Left open and close", async () => {
    const w = await inTree(TreeFolder, { ...bodies, collapsed: true }, { expandable: true, expanded: false });
    const head = w.get(".tree-folder");
    expect([head.attributes("role"), head.attributes("aria-expanded")]).toEqual(["treeitem", "false"]);
    press(head.element, "Enter");
    press(head.element, "ArrowRight");
    // Left on a closed head goes to a parent, it has none.
    press(head.element, "ArrowLeft");
    expect(w.findComponent(TreeFolder).emitted("toggle")).toHaveLength(2);
    expect(w.emitted("tree")).toBeUndefined();
  });

  it("Space on a head that selects is a toggle click of its activate", async () => {
    const activate = vi.fn();
    setMacForTest(false);
    const w = await inTree(TreeFolder, { ...bodies, collapsed: false, activate });
    press(w.get(".tree-folder").element, " ");
    expect((activate.mock.calls[0]![0] as MouseEvent).ctrlKey).toBe(true);
    expect(w.get(".tree-folder").attributes("aria-selected")).toBe("false");
  });
});
