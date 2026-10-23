import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ShortcutsDialog from "../../../src/components/overlays/ShortcutsDialog.vue";
import { contribute, resetContributions, setGrantLookup } from "../../../src/plugins/contrib";
import { resetUserShortcuts, resolveShortcut } from "../../../src/input/shortcuts";

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  setGrantLookup(() => ["input.remap"]);
  mount(ShortcutsDialog, { attachTo: document.body });
});
afterEach(() => {
  resetUserShortcuts();
  resetContributions();
});

const rows = () => [...document.querySelectorAll<HTMLElement>(".sc-row")];
const rowOf = (label: string) => rows().find((r) => r.querySelector(".sc-label")?.textContent === label)!;
const keycap = (label: string) => rowOf(label).querySelector<HTMLButtonElement>(".sc-key")!;
const tabs = () => [...document.querySelectorAll(".prefs-nav-btn")].map((b) => b.textContent);
const press = (init: KeyboardEventInit) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  return nextTick();
};
async function capture(label: string) {
  keycap(label).click();
  await nextTick();
}
async function click(el: Element | null) {
  (el as HTMLElement).click();
  await nextTick();
}

describe("changing a key in the shortcuts dialog", () => {
  it("shows the General page alone without a plugin keymap", () => {
    expect(tabs()).toEqual(["General"]);
  });

  it("captures the next combination and saves it", async () => {
    await capture("Fillet");
    expect(keycap("Fillet").textContent).toContain("Press keys");
    await press({ key: "Shift" });
    expect(keycap("Fillet").textContent).toContain("Press keys");
    await press({ key: "G" });
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
    expect(keycap("Fillet").querySelector("kbd")?.textContent).toBe("G");
    expect(rowOf("Fillet").textContent).toContain("changed");
    expect(JSON.parse(localStorage.getItem("fundacad.keymap") ?? "[]")).toHaveLength(1);
  });

  it("is cancelled by Escape without closing the dialog", async () => {
    await capture("Fillet");
    await press({ key: "Escape" });
    expect(keycap("Fillet").querySelector("kbd")?.textContent).toBe("F");
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(document.querySelector(".shortcuts-panel")).not.toBeNull();
  });

  it("shows a conflict, where cancel leaves everything and replace takes the key", async () => {
    await capture("Fillet");
    await press({ key: "e" });
    expect(rowOf("Fillet").querySelector(".sc-problem")?.textContent).toContain("E is already Extrude");
    expect(resolveShortcut("e", false, "model")).toBe("extrude");
    await click(rowOf("Fillet").querySelector(".sc-problem .btn:not(.btn-primary)"));
    expect(rowOf("Fillet").querySelector(".sc-problem")).toBeNull();

    await capture("Fillet");
    await press({ key: "e" });
    await click(rowOf("Fillet").querySelector(".sc-problem .btn-primary"));
    expect(resolveShortcut("e", false, "model")).toBe("fillet");
    expect(keycap("Extrude").textContent).toContain("Not set");
  });

  it("resets one row and, with Reset all, every changed row of the page", async () => {
    await capture("Fillet");
    await press({ key: "g" });
    await capture("Measure");
    await press({ key: "j" });
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
    await press({ key: "z", ctrlKey: true });
    expect(rowOf("Fillet").querySelector(".sc-problem")?.textContent).toContain("taken by Undo");
  });

  it("filters across the pages with the search field", async () => {
    const input = document.querySelector<HTMLInputElement>("[data-shortcut-search]")!;
    input.value = "chamfer";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    expect([...document.querySelectorAll(".sc-label")].map((l) => l.textContent)).toEqual(["Chamfer (bevel)"]);
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
    await press({ key: "y" });
    expect(resolveShortcut("y", false, "model")).toBe("test.radial");
    off();
    await nextTick();
    expect(tabs()).toEqual(["General"]);
  });
});
