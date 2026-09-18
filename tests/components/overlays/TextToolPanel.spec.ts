// The sketch Text tool's panel. The form<->value mapping is tested purely in
// sketch/textForm.test.ts; what is left for a mounted test is the wiring the
// port could plausibly get wrong: that every field feeds the live preview, that
// commit and cancel go through the facade's ordering, and that Escape is trapped
// in the capture phase so it cancels the TEXT tool rather than whatever
// SketchMode's global handler would have cancelled.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TextToolPanel from "../../../src/components/overlays/TextToolPanel.vue";
import { useToolPanelStore } from "../../../src/stores/toolPanels";
import { TextPanel } from "../../../src/sketch/textPanel";
import type { TextValues } from "../../../src/sketch/textForm";

enableAutoUnmount(afterEach);

function open(initial: Partial<TextValues> = {}) {
  const handlers = {
    onCommit: vi.fn<(v: TextValues) => void>(),
    onCancel: vi.fn(),
    onChange: vi.fn<(v: TextValues) => void>(),
  };
  const panel = new TextPanel();
  panel.show({ x: 40, y: 60 }, ["Arial", "Courier"], initial, handlers);
  const req = useToolPanelStore().text!;
  const w = mount(TextToolPanel, { props: { req }, attachTo: document.body });
  return { panel, handlers, w };
}

describe("TextToolPanel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("reaches the store through the facade, with the fonts the engine listed", () => {
    open();
    const store = useToolPanelStore();
    expect(store.text).not.toBeNull();
    expect(store.text!.fonts).toEqual(["Arial", "Courier"]);
    // one <option> per font plus the "Default font" entry
    expect(document.querySelectorAll("option")).toHaveLength(3 + 3); // fonts + align
  });

  it("opens with the values of the text object being edited", () => {
    open({ text: "Hi", height: 6, style: "bolditalic", align: "right" });
    const ta = document.querySelector("textarea")!;
    const boxes = document.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(ta.value).toBe("Hi");
    expect(boxes[0]!.checked).toBe(true); // bold
    expect(boxes[1]!.checked).toBe(true); // italic
  });

  it("fires the live preview on every edit", async () => {
    const { handlers } = open();
    const ta = document.querySelector("textarea")!;
    ta.value = "abc";
    ta.dispatchEvent(new Event("input"));
    await nextTick();
    expect(handlers.onChange).toHaveBeenCalled();
    expect(handlers.onChange.mock.lastCall![0].text).toBe("abc");
  });

  it("commits on Add and closes the panel", async () => {
    const { handlers } = open({ text: "Hi" });
    document.querySelectorAll("button")[0]!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCommit).toHaveBeenCalledOnce();
    expect(handlers.onCommit.mock.lastCall![0].text).toBe("Hi");
    expect(useToolPanelStore().text).toBeNull();
  });

  // Committing empty text would add an invisible entity nobody can select.
  it("drops an empty commit instead of adding a blank text object", async () => {
    const { handlers } = open({ text: "   " });
    document.querySelectorAll("button")[0]!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(useToolPanelStore().text).toBeNull(); // still closes
  });

  it("cancels on Cancel", async () => {
    const { handlers } = open({ text: "Hi" });
    document.querySelectorAll("button")[1]!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(useToolPanelStore().text).toBeNull();
  });

  it("traps Escape in the capture phase so it cancels the text tool", async () => {
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    const { handlers } = open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(bubbled).not.toHaveBeenCalled();
    document.removeEventListener("keydown", bubbled);
  });

  it("stops listening for Escape once it is gone", async () => {
    const { handlers, w } = open();
    w.unmount();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("hide() drops the panel without firing onCancel", async () => {
    const { panel, handlers } = open();
    panel.hide();
    await nextTick();
    // SketchMode calls hide() on tool switch and on exit; firing a cancel there
    // would re-enter the tool it just left.
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(useToolPanelStore().text).toBeNull();
    expect(panel.isActive).toBe(false);
  });
});
