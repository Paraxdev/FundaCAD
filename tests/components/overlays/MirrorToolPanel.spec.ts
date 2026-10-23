import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, shallowRef } from "vue";
import MirrorToolPanel from "../../../src/components/overlays/MirrorToolPanel.vue";
import type { MirrorPanelView } from "../../../src/stores/toolPanels";

enableAutoUnmount(afterEach);

function viewOf(over: Partial<MirrorPanelView> = {}): MirrorPanelView {
  return {
    id: 4,
    fields: [
      { key: "objects", label: "Objects", items: ["Line 1", "Circle 1", "Arc 1"], value: "3 objects", filled: true },
      { key: "line", label: "Mirror line", items: [], value: "Nothing picked", filled: false },
    ],
    active: "line",
    planes: [],
    plane: null,
    ready: false,
    onActivate: vi.fn(),
    onClear: vi.fn(),
    onRemove: vi.fn(),
    onPlane: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

function mountView(view: MirrorPanelView) {
  return mount(MirrorToolPanel, { props: { view }, attachTo: document.body });
}

const $ = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];

describe("MirrorToolPanel", () => {
  it("lists a section per field with one row per pick, the active one marked", () => {
    mountView(viewOf());
    const sections = $(".mirror-panel .tgt-section");
    expect(sections.map((r) => r.dataset.field)).toEqual(["objects", "line"]);
    expect(sections.map((r) => r.classList.contains("tgt-active"))).toEqual([false, true]);
    expect(sections.map((r) => r.querySelector(".tgt-field")!.textContent)).toEqual(["Objects", "Mirror line"]);
    expect($('[data-field="objects"] .tgt-item .tgt-label').map((l) => l.textContent)).toEqual([
      "Line 1",
      "Circle 1",
      "Arc 1",
    ]);
    expect($('[data-field="line"] .tgt-none').map((l) => l.textContent)).toEqual(["Click to set"]);
    expect($('[data-field="objects"] .tgt-none')).toEqual([]);
  });

  it("enables Clear all only on a filled list and passes its key", () => {
    const v = viewOf();
    mountView(v);
    const clears = $(".tgt-clear") as HTMLButtonElement[];
    expect(clears.map((b) => b.disabled)).toEqual([false, true]);
    clears[0]!.click();
    expect(v.onClear).toHaveBeenCalledWith("objects");
    expect(v.onActivate).not.toHaveBeenCalled();
  });

  it("removes one row by its index without activating the list", () => {
    const v = viewOf();
    mountView(v);
    ($(".tgt-remove")[1] as HTMLButtonElement).click();
    expect(vi.mocked(v.onRemove).mock.calls).toEqual([["objects", 1]]);
    expect(v.onActivate).not.toHaveBeenCalled();
  });

  it("makes a list active from anywhere in its section", () => {
    const v = viewOf();
    mountView(v);
    $('[data-field="objects"] .tgt-field')[0]!.click();
    $('[data-field="objects"] .tgt-item')[0]!.click();
    $('[data-field="line"] .tgt-none')[0]!.click();
    expect(vi.mocked(v.onActivate).mock.calls).toEqual([["objects"], ["objects"], ["line"]]);
  });

  it("holds the Mirror button until both fields are filled", () => {
    const waiting = viewOf();
    const w = mountView(waiting);
    const primary = () => $(".tgt-done")[0] as HTMLButtonElement;
    expect(primary().textContent!.trim()).toBe("Mirror");
    expect(primary().disabled).toBe(true);
    expect(primary().title).toBe("Pick mirror line first");
    w.unmount();
    const [objects, line] = viewOf().fields;
    const empty = viewOf({
      fields: [
        { ...objects, items: [], value: "Nothing picked", filled: false },
        { ...line, filled: false },
      ],
    });
    const e = mountView(empty);
    expect(primary().title).toBe("Pick objects and mirror line first");
    e.unmount();
    const ready = viewOf({ ready: true });
    mountView(ready);
    expect(primary().disabled).toBe(false);
    expect(primary().hasAttribute("title")).toBe(false);
    primary().click();
    expect(ready.onCommit).toHaveBeenCalledTimes(1);
    ($(".tgt-cancel")[0] as HTMLButtonElement).click();
    expect(ready.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows no plane chips in a sketch, and the picked one pressed in 3D", () => {
    const w = mountView(viewOf());
    expect($(".mirror-chips")).toEqual([]);
    w.unmount();
    const v = viewOf({ planes: ["XY", "XZ", "YZ"], plane: "XZ" });
    mountView(v);
    const chips = $(".mirror-chips .rd-chip");
    expect(chips.map((c) => [c.textContent!.trim(), c.getAttribute("aria-pressed")])).toEqual([
      ["XY", "false"],
      ["XZ", "true"],
      ["YZ", "false"],
    ]);
    chips[2]!.click();
    expect(v.onPlane).toHaveBeenCalledWith("YZ");
  });

  it("remounts for a new run and never calls the first run's handlers", async () => {
    const first = viewOf({ id: 7, ready: true });
    const second = viewOf({ id: 8, ready: true });
    const cur = shallowRef(first);
    const Host = defineComponent(() => () => h(MirrorToolPanel, { key: cur.value.id, view: cur.value }));
    const w = mount(Host, { attachTo: document.body });
    cur.value = second;
    await w.vm.$nextTick();
    expect($(".mirror-panel")).toHaveLength(1);
    ($(".tgt-done")[0] as HTMLButtonElement).click();
    $('[data-field="objects"] .tgt-field')[0]!.click();
    expect(second.onCommit).toHaveBeenCalledTimes(1);
    expect(second.onActivate).toHaveBeenCalledWith("objects");
    expect(first.onCommit).not.toHaveBeenCalled();
    expect(first.onActivate).not.toHaveBeenCalled();
  });
});
