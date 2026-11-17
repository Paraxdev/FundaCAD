import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, type Component, type PropType } from "vue";

import Tree from "../../../src/components/ui/Tree.vue";
import TreeItem from "../../../src/components/ui/TreeItem.vue";
import { keepTreeKeyFocus, type TreeItemActions, type TreeMeta } from "../../../src/components/ui/treeContext";

enableAutoUnmount(afterEach);

// vue-tsc types an SFC whose props hold the Named union as a function h() will not take.
const TreeC = Tree as unknown as Component;

const ITEMS: TreeMeta[] = [
  { key: "bodies", level: 1, expandable: true, expanded: true, label: "Bodies" },
  { key: "body1", level: 2, label: "Body 1" },
  { key: "body2", level: 2, label: "Body 2" },
  { key: "sketches", level: 1, expandable: true, expanded: false, label: "Sketches" },
  { key: "empty", level: 1, label: "Nothing", disabled: true },
  { key: "cut", level: 1, label: "Cut 1" },
];

const Harness = defineComponent({
  props: {
    selected: { type: Array as PropType<string[]>, default: () => [] },
    activeKey: { type: String, default: null },
    reorderBlurs: { type: Boolean, default: false },
    actions: { type: Object as PropType<Record<string, TreeItemActions>>, default: () => ({}) },
  },
  emits: ["select", "open", "rename", "remove", "menu", "reorder", "toggle"],
  setup(props, { emit }) {
    const list = ref<TreeMeta[]>([...ITEMS]);
    const onReorder = (key: string, delta: -1 | 1) => {
      emit("reorder", key, delta);
      if (!props.reorderBlurs) return;
      (document.activeElement as HTMLElement | null)?.blur();
      const i = list.value.findIndex((it) => it.key === key);
      const next = [...list.value];
      const [it] = next.splice(i, 1);
      next.splice(i + delta, 0, it!);
      list.value = next;
    };
    return () =>
      h(
        TreeC,
        {
          label: "Items",
          multiselectable: true,
          items: list.value,
          activeKey: props.activeKey,
          onSelect: (k: string, e: KeyboardEvent) => emit("select", k, e.key),
          onOpen: (k: string) => emit("open", k),
          onRename: (k: string) => emit("rename", k),
          onRemove: (k: string) => emit("remove", k),
          onMenu: (k: string, r: DOMRect) => emit("menu", k, typeof r.top),
          onReorder,
          onToggle: (k: string, x: boolean) => emit("toggle", k, x),
        },
        {
          default: () =>
            list.value.map((it) =>
              h(
                TreeItem,
                {
                  key: it.key,
                  itemKey: it.key,
                  label: it.label!,
                  selected: props.selected.includes(it.key),
                  actions: props.actions[it.key],
                },
                { default: () => (it.key === "body2" ? [it.label, h("input", { class: "rename" })] : it.label) },
              ),
            ),
        },
      );
  },
});

function render(props: Record<string, unknown> = {}) {
  return mount(Harness, { props, attachTo: document.body });
}

type W = ReturnType<typeof render>;
const rows = (w: W) => w.findAll('[role="treeitem"]');
const row = (w: W, key: string) =>
  rows(w).find((r) => r.attributes("aria-label") === ITEMS.find((it) => it.key === key)!.label)!;
const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label");

function press(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

/** Focus by Tab: no pointer first, so the tree takes letters too. */
function tabTo(w: W, key: string) {
  (row(w, key).element as HTMLElement).focus();
}

describe("Tree", () => {
  it("is a named multiselectable tree whose rows carry level, position, set size and state", () => {
    const w = render({ selected: ["body1"] });
    const tree = w.find('[role="tree"]');
    expect(tree.attributes("aria-label")).toBe("Items");
    expect(tree.attributes("aria-multiselectable")).toBe("true");
    const aria = rows(w).map((r) => [
      r.attributes("aria-level"),
      r.attributes("aria-posinset"),
      r.attributes("aria-setsize"),
      r.attributes("aria-selected"),
      r.attributes("aria-expanded"),
      r.attributes("aria-disabled"),
    ]);
    expect(aria).toEqual([
      ["1", "1", "4", "false", "true", undefined],
      ["2", "1", "2", "true", undefined, undefined],
      ["2", "2", "2", "false", undefined, undefined],
      ["1", "2", "4", "false", "false", undefined],
      ["1", "3", "4", "false", undefined, "true"],
      ["1", "4", "4", "false", undefined, undefined],
    ]);
  });

  it("has one Tab stop, on the active row or else the first", () => {
    const stops = (w: W) => rows(w).map((r) => r.attributes("tabindex"));
    expect(stops(render({ activeKey: "body2" }))).toEqual(["-1", "-1", "0", "-1", "-1", "-1"]);
    expect(stops(render())[0]).toBe("0");
  });

  it("moves with Up, Down, Home and End, skips a disabled row and does not wrap", () => {
    const w = render();
    tabTo(w, "bodies");
    const seen: (string | null | undefined)[] = [];
    for (const key of ["ArrowUp", "ArrowDown", "ArrowDown", "End", "ArrowUp", "ArrowDown", "ArrowDown", "Home"]) {
      press(key);
      seen.push(focused());
    }
    expect(seen).toEqual(["Bodies", "Body 1", "Body 2", "Cut 1", "Sketches", "Cut 1", "Cut 1", "Bodies"]);
  });

  it("opens and closes with Right and Left, and steps to the first child and back to the parent", () => {
    const w = render();
    tabTo(w, "sketches");
    press("ArrowRight");
    tabTo(w, "bodies");
    press("ArrowLeft");
    expect(w.emitted("toggle")).toEqual([
      ["sketches", true],
      ["bodies", false],
    ]);
    press("ArrowRight");
    expect(focused()).toBe("Body 1");
    press("ArrowRight");
    expect(focused()).toBe("Body 1");
    press("ArrowLeft");
    expect(focused()).toBe("Bodies");
  });

  it("selects on Space, opens on Enter, renames on F2 and removes on Delete or Backspace", () => {
    const w = render();
    tabTo(w, "body1");
    for (const key of [" ", "Enter", "F2", "Delete", "Backspace"]) expect(press(key).defaultPrevented).toBe(true);
    expect(w.emitted("select")).toEqual([["body1", " "]]);
    expect(w.emitted("open")).toEqual([["body1"]]);
    expect(w.emitted("rename")).toEqual([["body1"]]);
    expect(w.emitted("remove")).toEqual([["body1"], ["body1"]]);
  });

  it("hands a key to the row's own action, and emits only the keys the row leaves out", () => {
    const own = { rename: vi.fn(), open: vi.fn(), menu: vi.fn() };
    const toggle = vi.fn();
    const w = render({ actions: { body1: own, sketches: { toggle } } });
    tabTo(w, "body1");
    for (const key of ["F2", "Enter", "Delete"]) expect(press(key).defaultPrevented).toBe(true);
    press("F10", { shiftKey: true });
    tabTo(w, "sketches");
    press("ArrowRight");
    expect([own.rename.mock.calls.length, own.open.mock.calls.length, toggle.mock.calls]).toEqual([1, 1, [[true]]]);
    expect(own.menu.mock.calls[0]![0]).toHaveProperty("top");
    expect([w.emitted("rename"), w.emitted("open"), w.emitted("menu"), w.emitted("toggle")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(w.emitted("remove")).toEqual([["body1"]]);
  });

  it("opens the row menu on Shift+F10 and the Menu key with the row's rect", () => {
    const w = render();
    tabTo(w, "cut");
    press("F10", { shiftKey: true });
    press("ContextMenu");
    press("F10");
    expect(w.emitted("menu")).toEqual([
      ["cut", "number"],
      ["cut", "number"],
    ]);
  });

  it("swallows the contextmenu event the browser sends after the Menu key, not a later right click", () => {
    const w = render();
    let menus = 0;
    row(w, "cut").element.addEventListener("contextmenu", () => menus++);
    tabTo(w, "cut");
    press("ContextMenu");
    const after = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row(w, "cut").element.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
    row(w, "cut").element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(menus).toBe(1);
  });

  it("reorders on Alt+Up and Alt+Down and keeps focus on the moved row", async () => {
    const w = render({ reorderBlurs: true });
    tabTo(w, "body1");
    press("ArrowDown", { altKey: true });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(rows(w).map((r) => r.attributes("aria-label"))[2]).toBe("Body 1");
    expect(focused()).toBe("Body 1");
    press("ArrowUp", { altKey: true });
    expect(w.emitted("reorder")).toEqual([
      ["body1", 1],
      ["body1", -1],
    ]);
  });

  it("stops the keys it acts on short of the window and lets the rest through", () => {
    const w = render();
    const heard: string[] = [];
    const listen = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", listen);
    try {
      tabTo(w, "body1");
      for (const key of ["ArrowDown", " ", "Delete", "F2", "Escape", "s"]) press(key);
      press("z", { ctrlKey: true });
    } finally {
      window.removeEventListener("keydown", listen);
    }
    expect(heard).toEqual(["Escape", "z"]);
  });

  it("types ahead once reached by keys, and leaves letters to the shortcuts after a click", () => {
    const w = render();
    tabTo(w, "bodies");
    expect(press("c").defaultPrevented).toBe(true);
    expect(focused()).toBe("Cut 1");
    const r = row(w, "body1").element as HTMLElement;
    r.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    r.focus();
    expect(press("c").defaultPrevented).toBe(false);
    expect(focused()).toBe("Body 1");
    press("ArrowDown");
    press("s");
    expect(focused()).toBe("Sketches");
  });

  it("keeps a keyboard user on their row when picking it raises a field that takes focus, not a mouse user", async () => {
    const w = render();
    const field = document.body.appendChild(document.createElement("input"));
    const raise = () => {
      field.focus();
      requestAnimationFrame(() => field.focus());
    };
    tabTo(w, "body1");
    await nextTick();
    keepTreeKeyFocus(raise);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(focused()).toBe("Body 1");
    keepTreeKeyFocus(raise);
    press("ArrowDown");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(focused()).toBe("Body 2");
    const r = row(w, "body2").element as HTMLElement;
    r.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    r.focus();
    await nextTick();
    keepTreeKeyFocus(raise);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  describe("on a slow frame", () => {
    const frames: FrameRequestCallback[] = [];
    const runFrames = () => frames.splice(0).forEach((f) => f(0));
    const setup = async (refocusInFrame = true) => {
      const w = render();
      const field = document.body.appendChild(document.createElement("input"));
      const other = document.body.appendChild(document.createElement("button"));
      const raise = () => {
        field.focus();
        if (refocusInFrame) requestAnimationFrame(() => field.focus());
      };
      tabTo(w, "body1");
      await nextTick();
      keepTreeKeyFocus(raise);
      return { w, field, other };
    };
    beforeEach(() => vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb)));
    afterEach(() => {
      vi.unstubAllGlobals();
      frames.length = 0;
      document.body.querySelectorAll("input, button").forEach((n) => n.remove());
    });

    it("leaves focus where a key moved it before the frame", async () => {
      const { other } = await setup(false);
      press("f", { ctrlKey: true });
      other.focus();
      runFrames();
      expect(document.activeElement).toBe(other);
    });

    it("still returns to the tree when no key came, after the raised field focused itself in the frame", async () => {
      const { field } = await setup();
      expect(document.activeElement).not.toBe(field);
      runFrames();
      expect(focused()).toBe("Body 1");
    });

    it("takes focus back from a focus that a pointer, not a key, put outside the tree", async () => {
      const { other } = await setup();
      other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      other.focus();
      runFrames();
      expect(focused()).toBe("Body 1");
    });

    it("keeps the tree a key walked within, after the raised field focused itself in the frame", async () => {
      await setup();
      press("ArrowDown");
      expect(focused()).toBe("Body 2");
      await nextTick();
      runFrames();
      expect(focused()).toBe("Body 2");
    });
  });

  it("lets go of a focused row when a press lands outside the tree, where the viewport keeps focus put", () => {
    const w = render();
    const outside = document.body.appendChild(document.createElement("div"));
    tabTo(w, "body1");
    row(w, "body2").element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(focused()).toBe("Body 1");
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.activeElement).not.toBe(row(w, "body1").element);
    outside.remove();
  });

  it("leaves keys typed in a field inside a row alone", () => {
    const w = render();
    const input = w.find("input.rename").element as HTMLInputElement;
    input.focus();
    for (const key of [" ", "Delete", "ArrowDown", "Home", "F2"]) expect(press(key).defaultPrevented).toBe(false);
    expect(w.emitted("remove")).toBeUndefined();
    expect(document.activeElement).toBe(input);
  });
});
