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
      { key: "objects", label: "Objects", icon: "select-all", value: "3 objects", filled: true },
      { key: "line", label: "Mirror line", icon: "line", value: "Nothing picked", filled: false },
    ],
    active: "line",
    planes: [],
    plane: null,
    ready: false,
    onActivate: vi.fn(),
    onClear: vi.fn(),
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
  it("shows both fields with the active one pressed and lit", () => {
    mountView(viewOf());
    const rows = $(".mirror-panel .mirror-field");
    expect(rows.map((r) => r.dataset.field)).toEqual(["objects", "line"]);
    expect(rows.map((r) => r.classList.contains("active"))).toEqual([false, true]);
    expect(rows.map((r) => r.querySelector(".icon-btn")!.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(rows.map((r) => r.querySelector(".mirror-field-v")!.textContent)).toEqual(["3 objects", "Nothing picked"]);
  });

  it("enables a clear button only on a filled field and passes its key", async () => {
    const v = viewOf();
    mountView(v);
    const clears = $(".mirror-field .float-card-close") as HTMLButtonElement[];
    expect(clears.map((b) => b.disabled)).toEqual([false, true]);
    clears[0]!.click();
    expect(v.onClear).toHaveBeenCalledTimes(1);
    expect(v.onClear).toHaveBeenCalledWith("objects");
    expect(v.onActivate).not.toHaveBeenCalled();
  });

  it("makes a field active from its toggle", () => {
    const v = viewOf();
    mountView(v);
    $(".mirror-field .icon-btn")[0]!.click();
    expect(vi.mocked(v.onActivate).mock.calls).toEqual([["objects"]]);
  });

  it("makes a field active from anywhere on its row", () => {
    const v = viewOf();
    mountView(v);
    $(".mirror-field .mirror-field-k")[0]!.click();
    $(".mirror-field .mirror-field-v")[1]!.click();
    expect(vi.mocked(v.onActivate).mock.calls).toEqual([["objects"], ["line"]]);
  });

  it("holds the Mirror button until both fields are filled", () => {
    const waiting = viewOf();
    const w = mountView(waiting);
    const primary = () => $(".mirror-actions .btn-primary")[0] as HTMLButtonElement;
    expect(primary().disabled).toBe(true);
    expect(primary().title).toBe("Pick mirror line first");
    w.unmount();
    const [objects, line] = viewOf().fields;
    const empty = viewOf({
      fields: [
        { ...objects, value: "Nothing picked", filled: false },
        { ...line, value: "Nothing picked", filled: false },
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
    ($(".mirror-actions .btn:not(.btn-primary)")[0] as HTMLButtonElement).click();
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
    ($(".mirror-actions .btn-primary")[0] as HTMLButtonElement).click();
    $(".mirror-field .icon-btn")[0]!.click();
    expect(second.onCommit).toHaveBeenCalledTimes(1);
    expect(second.onActivate).toHaveBeenCalledWith("objects");
    expect(first.onCommit).not.toHaveBeenCalled();
    expect(first.onActivate).not.toHaveBeenCalled();
  });
});
