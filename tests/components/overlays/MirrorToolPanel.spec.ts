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
const disabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

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
    const clears = $(".tgt-clear");
    expect(clears.map(disabled)).toEqual([false, true]);
    clears[0]!.click();
    expect(v.onClear).toHaveBeenCalledWith("objects");
    // The empty list's Clear all refuses the click, and the press does not activate its section either.
    clears[1]!.click();
    expect(vi.mocked(v.onClear).mock.calls).toEqual([["objects"]]);
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
    expect(disabled(primary())).toBe(true);
    expect(primary().title).toBe("Pick mirror line first");
    primary().click();
    expect(waiting.onCommit).not.toHaveBeenCalled();
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
    expect(disabled(primary())).toBe(false);
    expect(primary().hasAttribute("title")).toBe(false);
    primary().click();
    expect(ready.onCommit).toHaveBeenCalledTimes(1);
    ($(".tgt-cancel")[0] as HTMLButtonElement).click();
    expect(ready.onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows no plane chips in a sketch, and the picked one checked in 3D", () => {
    const w = mountView(viewOf());
    expect($(".mirror-chips")).toEqual([]);
    w.unmount();
    const v = viewOf({ planes: ["XY", "XZ", "YZ"], plane: "XZ" });
    mountView(v);
    expect($('.mirror-chips [role="radiogroup"]')[0]!.getAttribute("aria-label")).toBe("Mirror plane");
    const chips = $('.mirror-chips [role="radio"]');
    expect(chips.map((c) => [c.textContent!.trim(), c.getAttribute("aria-checked")])).toEqual([
      ["XY", "false"],
      ["XZ", "true"],
      ["YZ", "false"],
    ]);
    chips[2]!.click();
    expect(v.onPlane).toHaveBeenCalledWith("YZ");
  });

  // Picking a plane hands the next canvas click back to Objects, the plane already set included.
  it("picks the plane again on a click of the chip already checked, once per click", () => {
    const v = viewOf({ planes: ["XY", "XZ", "YZ"], plane: "XY" });
    mountView(v);
    const chips = $('.mirror-chips [role="radio"]');
    chips[0]!.click();
    chips[1]!.click();
    expect(v.onPlane.mock.calls).toEqual([["XY"], ["XZ"]]);
  });

  // Focus stays where it was (the canvas), so the tool's Enter and Tab still reach it after a click in the panel.
  it("keeps a press in the panel from taking focus", () => {
    mountView(viewOf({ ready: true, planes: ["XY", "XZ"], plane: "XY" }));
    for (const sel of [".tgt-done", ".tgt-cancel", ".tgt-clear", ".tgt-remove", '.mirror-chips [role="radio"]']) {
      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      $(sel)[0]!.dispatchEvent(down);
      expect(down.defaultPrevented, sel).toBe(true);
    }
  });

  // The tool owns Escape, and leaves Enter to a panel button that has focus.
  it("lets Escape through from a focused button, disabled or not, and Enter from an enabled one", () => {
    mountView(viewOf());
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(`${e.key}:${e.defaultPrevented}`);
    window.addEventListener("keydown", onKey);
    const press = (sel: string, key: string) => {
      const b = $(sel)[0]!;
      b.focus();
      b.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    press(".tgt-done", "Escape");
    press(".tgt-cancel", "Escape");
    press(".tgt-cancel", "Enter");
    window.removeEventListener("keydown", onKey);
    expect(seen).toEqual(["Escape:false", "Escape:false", "Enter:false"]);
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
