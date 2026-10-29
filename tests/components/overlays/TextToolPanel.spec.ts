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
import { escapeClaimed } from "../../../src/ui/escapeClaim";

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

const q = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel)!;
const down = (el: Element) => {
  const e = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input"));
};
const sizeBox = () => document.querySelectorAll<HTMLInputElement>(".text-tool-num input")[0]!;
// A claimed Escape is released a task later.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("TextToolPanel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("reaches the store through the facade, with the fonts the engine listed", async () => {
    open();
    const store = useToolPanelStore();
    expect(store.text).not.toBeNull();
    expect(store.text!.fonts).toEqual(["Arial", "Courier"]);
    const font = q<HTMLButtonElement>(".select-trigger");
    expect(font.textContent!.trim()).toBe("Default font");
    font.click();
    await nextTick();
    // one option per font plus the "Default font" entry
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent!.trim())).toEqual([
      "Default font",
      "Arial",
      "Courier",
    ]);
    expect([...document.querySelectorAll('[role="radio"]')].map((o) => o.textContent!.trim())).toEqual([
      "Left",
      "Center",
      "Right",
    ]);
  });

  it("opens with the values of the text object being edited", () => {
    open({ text: "Hi", height: 6, style: "bolditalic", align: "right" });
    const ta = document.querySelector("textarea")!;
    const boxes = document.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(ta.value).toBe("Hi");
    expect(boxes[0]!.checked).toBe(true); // bold
    expect(boxes[1]!.checked).toBe(true); // italic
    expect(q('[role="radio"][aria-checked="true"]').textContent!.trim()).toBe("Right");
    expect(sizeBox().value).toBe("6");
  });

  it("names the style boxes Bold and Italic while they show B and I", () => {
    open();
    // The name a screen reader builds from the wrapping label: its text without aria-hidden parts.
    const named = (el: Element): string =>
      [...el.childNodes]
        .map((n) => (n instanceof Element ? (n.getAttribute("aria-hidden") === "true" ? "" : named(n)) : n.textContent))
        .join("");
    const boxes = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(
      boxes.map((b) => {
        const label = b.closest("label")!;
        return [
          b.getAttribute("aria-label"),
          named(label).trim(),
          label.querySelector(".ui-checkbox-label")!.textContent,
        ];
      }),
    ).toEqual([
      [null, "Bold", "BBold"],
      [null, "Italic", "IItalic"],
    ]);
  });

  it("focuses the text on open", () => {
    open();
    expect(document.activeElement).toBe(document.querySelector("textarea"));
  });

  it("fires the live preview on every edit", async () => {
    const { handlers } = open();
    const ta = document.querySelector("textarea")!;
    ta.value = "abc";
    ta.dispatchEvent(new Event("input"));
    await nextTick();
    expect(handlers.onChange).toHaveBeenCalled();
    expect(handlers.onChange.mock.lastCall![0].text).toBe("abc");

    type(sizeBox(), "12");
    expect(handlers.onChange.mock.lastCall![0].height).toBe(12);
    q("input[type=checkbox]").dispatchEvent(new Event("change"));
    await nextTick();
    expect(handlers.onChange.mock.lastCall![0].style).toBe("bold");
    document.querySelectorAll<HTMLElement>('[role="radio"]')[1]!.click();
    expect(handlers.onChange.mock.lastCall![0].align).toBe("center");
    q<HTMLButtonElement>(".select-trigger").click();
    await nextTick();
    document.querySelectorAll<HTMLElement>('[role="option"]')[2]!.click();
    await nextTick();
    expect(handlers.onChange.mock.lastCall![0].font).toBe("Courier");
  });

  it("marks a size that does not read and says why", async () => {
    const { handlers } = open();
    type(sizeBox(), "1x");
    await nextTick();
    expect(sizeBox().getAttribute("aria-invalid")).toBe("true");
    expect(sizeBox().title).not.toBe("");
    expect(q('[data-testid="text-field-error"]').textContent).toBe(sizeBox().title);
    // the preview falls back to the default height rather than a NaN
    expect(handlers.onChange.mock.lastCall![0].height).toBe(10);
  });

  it("commits on Ctrl+Enter or Cmd+Enter in the text, and a plain Enter types a new line", async () => {
    const first = open({ text: "Hi" });
    const ta = document.querySelector("textarea")!;
    expect(key(ta, "Enter")).toBe(true);
    expect(first.handlers.onCommit).not.toHaveBeenCalled();
    key(ta, "Enter", { ctrlKey: true });
    expect(first.handlers.onCommit).toHaveBeenCalledOnce();
    first.w.unmount();
    const second = open({ text: "Yo" });
    key(document.querySelector("textarea")!, "Enter", { metaKey: true });
    expect(second.handlers.onCommit).toHaveBeenCalledOnce();
  });

  it("commits on Add and closes the panel", async () => {
    const { handlers } = open({ text: "Hi" });
    // Acting on the press, with its default refused, keeps focus (and the last keystroke) in the field.
    expect(down(q(".text-tool-add")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("textarea"));
    await nextTick();
    expect(handlers.onCommit).toHaveBeenCalledOnce();
    expect(handlers.onCommit.mock.lastCall![0].text).toBe("Hi");
    expect(useToolPanelStore().text).toBeNull();
  });

  // Committing empty text would add an invisible entity nobody can select.
  it("drops an empty commit instead of adding a blank text object", async () => {
    const { handlers } = open({ text: "   " });
    down(q(".text-tool-add"));
    await nextTick();
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(useToolPanelStore().text).toBeNull(); // still closes
  });

  it("cancels on Cancel", async () => {
    const { handlers } = open({ text: "Hi" });
    const cancel = q(".text-tool-cancel");
    expect(cancel.title).toBe("Cancel");
    expect(cancel.getAttribute("aria-label")).toBe("Cancel");
    expect(down(cancel).defaultPrevented).toBe(true);
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

  // SketchMode skips Escape only for a focused text field, so a focused list, box or button claims it.
  it("claims Escape while focus is anywhere in the panel, and gives it up when focus leaves", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    open();
    expect(escapeClaimed()).toBe(true);
    q<HTMLButtonElement>(".select-trigger").focus();
    await settle();
    expect(escapeClaimed()).toBe(true);
    outside.focus();
    await settle();
    expect(escapeClaimed()).toBe(false);
  });

  it("cancels on Escape from the font list's trigger, and an open list takes the first Escape", async () => {
    const { handlers, w } = open();
    const font = q<HTMLButtonElement>(".select-trigger");
    font.focus();
    font.click();
    await nextTick();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    key(font, "Escape");
    await nextTick();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    key(font, "Escape");
    await nextTick();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    // App.vue drops the panel once the store lets go of it, and the claim goes with it.
    w.unmount();
    await settle();
    expect(escapeClaimed()).toBe(false);
  });

  // A native <select> shielded the keymap as a text field does; the base list, the boxes and the buttons do not.
  it("keeps plain keys typed on its controls out of the global keymap, and lets Ctrl or Cmd shortcuts pass", () => {
    open();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.key}`);
    window.addEventListener("keydown", onKey);
    key(q(".select-trigger"), "l");
    key(q("input[type=checkbox]"), "Delete");
    key(q('[role="radio"]'), "r");
    key(q(".select-trigger"), "s", { ctrlKey: true });
    window.removeEventListener("keydown", onKey);
    expect(seen).toEqual(["Ctrl+s"]);
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
