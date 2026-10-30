import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";

vi.mock(import("../../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

import KeyCapture, { type CapturedKey } from "../../../src/components/ui/KeyCapture.vue";
import { announce } from "../../../src/ui/announce";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  setMacForTest(false);
});
afterEach(() => setMacForTest(null));

const settle = () => new Promise((r) => setTimeout(r, 5));
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const active = () => document.activeElement as HTMLElement | null;

function key(target: EventTarget, k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
}

function render(init: { keys?: string; clearable?: boolean; refuse?: string } = {}) {
  const keys = ref(init.keys ?? "Ctrl+Z");
  const problem = ref<string | undefined>();
  const captured: CapturedKey[] = [];
  const cleared = ref(0);
  const Host = defineComponent({
    setup: () => () =>
      h(KeyCapture, {
        action: "Undo",
        keys: keys.value,
        problem: problem.value,
        clearable: init.clearable ?? false,
        class: "sc-key",
        "data-id": "undo",
        onCapture: (k: CapturedKey) => {
          captured.push(k);
          if (init.refuse) problem.value = init.refuse;
          else keys.value = `${k.ctrl ? "Ctrl+" : ""}${k.shift ? "Shift+" : ""}${k.key.toUpperCase()}`;
        },
        onClear: () => {
          cleared.value++;
          keys.value = "";
        },
      }),
  });
  const w = mount(Host, { attachTo: document.body });
  const button = () => w.find<HTMLButtonElement>("button.sc-key");
  const open = async () => {
    await button().trigger("click");
    await settle();
  };
  return { w, keys, captured, cleared, button, open };
}

const pad = () => $(".ui-dialog [role='application']");

describe("KeyCapture", () => {
  it("names the button by the action and the spoken keys, and shows the key caps", () => {
    const { button } = render();
    expect(button().attributes("aria-label")).toBe("Undo, shortcut Control Z, change");
    expect(button().attributes("data-id")).toBe("undo");
    expect(
      button()
        .findAll("kbd")
        .map((k) => k.text()),
    ).toEqual(["Ctrl", "Z"]);
  });

  it("says Command on macOS", () => {
    setMacForTest(true);
    const { button } = render();
    expect(button().attributes("aria-label")).toBe("Undo, shortcut Command Z, change");
  });

  it("shows Not set for a missing key", () => {
    const { button } = render({ keys: "" });
    expect([button().attributes("aria-label"), button().text()]).toEqual(["Undo, shortcut not set, change", "Not set"]);
  });

  it("never arms on focus: a key on the focused button opens nothing and captures nothing", async () => {
    const { button, captured } = render();
    button().element.focus();
    key(button().element, "e");
    await settle();
    expect([$(".ui-dialog"), captured.length]).toEqual([null, 0]);
  });

  it("opens a capture dialog on click, with focus in its application region", async () => {
    const { open } = render();
    await open();
    expect($(".ui-dialog")?.getAttribute("role")).toBe("dialog");
    expect($(".ui-dialog h2")?.textContent).toBe("Shortcut for Undo");
    expect(pad()?.getAttribute("aria-label")).toBe("Press the new shortcut for Undo");
    expect(active()).toBe(pad());
  });

  it("takes the next combo, emits it, closes, speaks the result and puts focus back on the button", async () => {
    const { open, captured, button } = render();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    await open();
    const e = key(pad()!, "K", { code: "KeyK", ctrlKey: true, shiftKey: true });
    await settle();
    window.removeEventListener("keydown", seen);
    expect(captured).toEqual([{ key: "k", name: "K", code: "KeyK", ctrl: true, shift: true, alt: false }]);
    expect([e.defaultPrevented, seen.mock.calls.length]).toEqual([true, 0]);
    expect($(".ui-dialog")).toBeNull();
    expect(active()).toBe(button().element);
    expect(vi.mocked(announce).mock.calls).toEqual([["Undo is now Control Shift K", "polite"]]);
  });

  it("takes the physical key on a Cyrillic layout", async () => {
    const { open, captured } = render();
    await open();
    key(pad()!, "у", { code: "KeyE" });
    await settle();
    expect(captured.map((c) => c.key)).toEqual(["e"]);
  });

  it("ignores modifier keys alone and a key still composing, and leaves Tab to move focus", async () => {
    const { open, captured } = render();
    await open();
    for (const k of ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process"]) key(pad()!, k);
    key(pad()!, "Tab");
    await settle();
    expect([captured.length, !!$(".ui-dialog")]).toEqual([0, true]);
  });

  it("cancels on Escape without a capture, focus back on the button", async () => {
    const { open, captured, button } = render();
    await open();
    key(pad()!, "Escape");
    await settle();
    expect([captured.length, $(".ui-dialog"), active()]).toEqual([0, null, button().element]);
    expect(announce).not.toHaveBeenCalled();
  });

  it("cancels from its Cancel button", async () => {
    const { open, captured } = render();
    await open();
    [...document.querySelectorAll<HTMLButtonElement>(".ui-dialog-foot button")]
      .find((b) => b.textContent?.trim() === "Cancel")!
      .click();
    await settle();
    expect([captured.length, $(".ui-dialog")]).toEqual([0, null]);
  });

  it("speaks a problem the owner hands back as assertive", async () => {
    const { open } = render({ refuse: "Ctrl+K is already used by Sketch" });
    await open();
    key(pad()!, "k", { code: "KeyK", ctrlKey: true });
    await settle();
    expect(vi.mocked(announce).mock.calls).toEqual([["Ctrl+K is already used by Sketch", "assertive"]]);
  });

  it("clears from a Clear button when clearable, and only then", async () => {
    const plain = render();
    await plain.open();
    const labels = () => [...document.querySelectorAll(".ui-dialog-foot button")].map((b) => b.textContent?.trim());
    expect(labels()).toEqual(["Cancel"]);
    key(pad()!, "Escape");
    await settle();
    plain.w.unmount();

    const { open, cleared, button } = render({ clearable: true });
    await open();
    expect(labels()).toEqual(["Clear", "Cancel"]);
    [...document.querySelectorAll<HTMLButtonElement>(".ui-dialog-foot button")][0]!.click();
    await settle();
    expect([cleared.value, $(".ui-dialog"), active()]).toEqual([1, null, button().element]);
    expect(vi.mocked(announce).mock.calls).toEqual([["Undo has no shortcut", "polite"]]);
  });

  it("captures Delete and Backspace as keys, never as a clear", async () => {
    const { open, captured, cleared } = render({ clearable: true });
    await open();
    key(pad()!, "Delete", { code: "Delete" });
    await settle();
    expect([captured.map((c) => c.key), cleared.value]).toEqual([["delete"], 0]);
  });
});
