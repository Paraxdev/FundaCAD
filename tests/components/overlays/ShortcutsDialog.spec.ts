import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ShortcutsDialog from "../../../src/components/overlays/ShortcutsDialog.vue";
import ModalHost from "../../../src/components/overlays/ModalHost.vue";
import { choose } from "../../../src/ui/choice";
import { useModalStore } from "../../../src/stores/modals";
import { contribute, resetContributions, setGrantLookup } from "../../../src/plugins/contrib";
import { useDialogStore } from "../../../src/stores/dialogs";
import { resetUserShortcuts, resolveShortcut } from "../../../src/input/shortcuts";
import { announce } from "../../../src/ui/announce";
import { setMacForTest } from "../../../src/input/platform";

vi.mock(import("../../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  setGrantLookup(() => ["input.remap"]);
  vi.mocked(announce).mockClear();
  setMacForTest(false);
  mount(ShortcutsDialog, { attachTo: document.body });
});
afterEach(() => {
  setMacForTest(null);
  resetUserShortcuts();
  resetContributions();
});

const rows = () => [...document.querySelectorAll<HTMLElement>(".sc-row")];
const rowOf = (label: string) => rows().find((r) => r.querySelector(".sc-label")?.textContent === label)!;
const keycap = (label: string) => rowOf(label).querySelector<HTMLButtonElement>(".sc-key")!;
const tabs = () => [...document.querySelectorAll(".prefs-nav-btn")].map((b) => b.textContent);
const settle = () => new Promise((r) => setTimeout(r, 5));
const pad = () => document.querySelector<HTMLElement>(".key-capture-pad");
const press = (init: KeyboardEventInit, target: EventTarget = window) => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  return settle();
};
const type = (init: KeyboardEventInit) => press(init, pad()!);
async function capture(label: string) {
  keycap(label).click();
  await settle();
}
async function click(el: Element | null) {
  (el as HTMLElement).click();
  await nextTick();
}

describe("changing a key in the shortcuts dialog", () => {
  it("shows the General page alone without a plugin keymap", () => {
    expect(tabs()).toEqual(["General"]);
  });

  it("never takes a key while the key button only has focus", async () => {
    keycap("Fillet").focus();
    await press({ key: "g" }, keycap("Fillet"));
    expect([pad(), resolveShortcut("f", false, "model"), resolveShortcut("g", false, "model")]).toEqual([
      null,
      "fillet",
      null,
    ]);
  });

  it("captures the next combination in its dialog, saves it and says so", async () => {
    await capture("Fillet");
    expect(document.activeElement).toBe(pad());
    await type({ key: "Shift" });
    expect(pad()).not.toBeNull();
    await type({ key: "G" });
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
    expect(keycap("Fillet").querySelector("kbd")?.textContent).toBe("G");
    expect(rowOf("Fillet").textContent).toContain("changed");
    expect(JSON.parse(localStorage.getItem("fundacad.keymap") ?? "[]")).toHaveLength(1);
    expect([pad(), document.activeElement]).toEqual([null, keycap("Fillet")]);
    expect(keycap("Fillet").getAttribute("aria-label")).toBe("Fillet, shortcut G, change");
    expect(vi.mocked(announce).mock.calls).toEqual([["Fillet is now G", "polite"]]);
  });

  it("reads a question mark without the shift it arrives with", async () => {
    await capture("Fillet");
    await type({ key: "?", code: "Slash", shiftKey: true });
    expect(rowOf("Fillet").querySelector(".sc-problem span")?.textContent).toBe("? is taken by This sheet");
    expect(resolveShortcut("?", false, "model")).toBe("shortcut-help");
  });

  it("is cancelled by Escape, in the pad or on its buttons, without closing the dialog", async () => {
    useDialogStore().shortcuts = true;
    await capture("Fillet");
    await type({ key: "Escape" });
    expect(pad()).toBeNull();
    await capture("Fillet");
    await press({ key: "Escape" });
    expect(pad()).toBeNull();
    expect(keycap("Fillet").querySelector("kbd")?.textContent).toBe("F");
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect([useDialogStore().shortcuts, !!document.querySelector(".shortcuts-panel")]).toEqual([true, true]);
    expect(announce).not.toHaveBeenCalled();
  });

  it("shows a conflict, where cancel leaves everything and replace takes the key", async () => {
    await capture("Fillet");
    await type({ key: "e" });
    expect(rowOf("Fillet").querySelector(".sc-problem")?.textContent).toContain("E is already used by Extrude");
    expect(vi.mocked(announce).mock.calls).toEqual([["E is already used by Extrude", "assertive"]]);
    const problem = rowOf("Fillet").querySelector(".sc-problem span")!;
    const replace = rowOf("Fillet").querySelector(".sc-problem .btn-primary")!;
    expect([problem.closest("[role=alert]"), replace.getAttribute("aria-describedby")]).toEqual([null, problem.id]);
    expect(resolveShortcut("e", false, "model")).toBe("extrude");
    await click(rowOf("Fillet").querySelector(".sc-problem .btn:not(.btn-primary)"));
    expect(rowOf("Fillet").querySelector(".sc-problem")).toBeNull();

    await capture("Fillet");
    await type({ key: "e" });
    await click(rowOf("Fillet").querySelector(".sc-problem .btn-primary"));
    expect(resolveShortcut("e", false, "model")).toBe("fillet");
    expect(keycap("Extrude").textContent).toContain("Not set");
  });

  it("resets one row and, with Reset all, every changed row of the page", async () => {
    await capture("Fillet");
    await type({ key: "g" });
    await capture("Measure");
    await type({ key: "j" });
    await click(rowOf("Fillet").querySelector(".sc-reset"));
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(resolveShortcut("j", false, "model")).toBe("measure");
    await click(document.querySelector(".sc-reset-all"));
    expect(resolveShortcut("i", false, "model")).toBe("measure");
    expect(document.querySelector(".sc-reset-all")).toBeNull();
  });

  it("says a fixed key is fixed instead of capturing", () => {
    const save = rows().find((r) => r.textContent?.includes("Save / Save As"))!;
    expect(save.querySelector(".sc-fixed")).not.toBeNull();
    expect(save.querySelector(".sc-key")).toBeNull();
  });

  it("refuses a reserved key", async () => {
    await capture("Fillet");
    await type({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(rowOf("Fillet").querySelector(".sc-problem")?.textContent).toContain("taken by Undo");
    expect(vi.mocked(announce).mock.calls).toEqual([["Control Z is taken by Undo", "assertive"]]);
  });

  it("filters across the pages with the search field", async () => {
    const input = document.querySelector<HTMLInputElement>("[data-shortcut-search]")!;
    input.value = "chamfer";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    expect([...document.querySelectorAll(".sc-label")].map((l) => l.textContent)).toEqual(["Chamfer (bevel)"]);
  });

  it("clears the search on the first Escape and closes on the second", async () => {
    const input = document.querySelector<HTMLInputElement>("[data-shortcut-search]")!;
    useDialogStore().shortcuts = true;
    input.focus();
    input.value = "chamfer";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    await press({ key: "Escape" });
    expect(input.value).toBe("");
    expect(useDialogStore().shortcuts).toBe(true);
    await press({ key: "Escape" });
    expect(useDialogStore().shortcuts).toBe(false);
  });
});

describe("a plugin that contributes keys", () => {
  it("gets its own page, editable like the General one, and loses it with the plugin", async () => {
    const off = contribute("Test.Keys", {
      keymap: [{ action: "test.radial", key: "w", label: "Radial menu", context: "global" }],
    });
    await nextTick();
    expect(tabs()).toEqual(["General", "Test.Keys"]);
    expect([...document.querySelectorAll(".sc-label")].map((l) => l.textContent)).not.toContain("Radial menu");
    await click(document.querySelectorAll(".prefs-nav-btn")[1]!);
    expect(keycap("Radial menu").querySelector("kbd")?.textContent).toBe("W");
    await capture("Radial menu");
    await type({ key: "y" });
    expect(resolveShortcut("y", false, "model")).toBe("test.radial");
    off();
    await nextTick();
    expect(tabs()).toEqual(["General"]);
  });
});

describe("the shortcuts frame", () => {
  const search = () => document.querySelector<HTMLInputElement>("[data-shortcut-search]")!;

  it("opens on the search field, labelled, and holds the modal gate", async () => {
    await settle();
    const panel = document.querySelector(".shortcuts-panel")!;
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe("Keyboard shortcuts");
    expect([document.activeElement, useModalStore().depth]).toEqual([search(), 1]);
  });

  it("wraps Tab inside the dialog", async () => {
    await settle();
    const done = [...document.querySelectorAll<HTMLElement>(".shortcuts-panel .btn-primary")].at(-1)!;
    done.focus();
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    done.dispatchEvent(e);
    expect([e.defaultPrevented, document.activeElement]).toEqual([
      true,
      document.querySelector(".shortcuts-panel .modal-close"),
    ]);
  });

  it("leaves Escape to a chooser over it", async () => {
    mount(ModalHost, { attachTo: document.body });
    useDialogStore().shortcuts = true;
    const answer = choose("Which?", [{ value: "a", label: "A" }]);
    await settle();
    await press({ key: "Escape" });
    expect(await answer).toBeNull();
    expect(useDialogStore().shortcuts).toBe(true);
    await press({ key: "Escape" });
    expect(useDialogStore().shortcuts).toBe(false);
  });
});
