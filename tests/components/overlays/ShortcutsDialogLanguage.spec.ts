// The Keyboard Shortcuts window's own text follows the chosen language, live.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ShortcutsDialog from "../../../src/components/overlays/ShortcutsDialog.vue";
import ModalHost from "../../../src/components/overlays/ModalHost.vue";
import { setLanguage } from "../../../src/i18n";
import en from "../../../src/i18n/locales/en.json";
import de from "../../../src/i18n/locales/de.json";
import { contribute, resetContributions, setGrantLookup } from "../../../src/plugins/contrib";
import { useToastStore } from "../../../src/stores/toasts";
import { ALT_REFUSAL, refusalLabel, resetUserShortcuts, shortcutHudGroups } from "../../../src/input/shortcuts";
import { setMacForTest } from "../../../src/input/platform";

vi.mock(import("../../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

enableAutoUnmount(afterEach);

type Key = keyof typeof de & keyof typeof en;
const fill = (text: string, args: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, k: string) => args[k]!);
const line = (k: Key, args: Record<string, string> = {}) => fill(de[k], args);
const english = (k: Key, args: Record<string, string> = {}) => fill(en[k], args);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const settle = () => new Promise((r) => setTimeout(r, 5));
const rowOf = (label: string) => $$(".sc-row").find((r) => r.querySelector(".sc-label")?.textContent === label)!;
const keycap = (label: string) => rowOf(label).querySelector<HTMLButtonElement>(".sc-key")!;
const pad = () => $(".key-capture-pad");
async function type(init: KeyboardEventInit) {
  pad()!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  await settle();
}
async function capture(label: string) {
  keycap(label).click();
  await settle();
}
async function click(el: Element | null) {
  (el as HTMLElement).click();
  await nextTick();
}
const text = () => $(".shortcuts-panel")!.textContent ?? "";
const search = () => $("[data-shortcut-search]") as HTMLInputElement;

beforeEach(async () => {
  setActivePinia(createPinia());
  setGrantLookup(() => ["input.remap"]);
  setMacForTest(false);
  document.body.replaceChildren();
  mount(ShortcutsDialog, { attachTo: document.body });
  await setLanguage("de");
  await nextTick();
});
afterEach(async () => {
  setMacForTest(null);
  resetUserShortcuts();
  resetContributions();
  await setLanguage("system");
});

describe("the shortcuts window chrome in German", () => {
  it("reads the title, page, search, buttons and badges from the German lines", async () => {
    expect($(".shortcuts-panel")?.getAttribute("aria-label") ?? $(".shortcuts-panel h2")?.textContent).toContain(
      line("shortcuts.title"),
    );
    expect($$(".prefs-nav-btn").map((b) => b.textContent)).toEqual([line("shortcuts.page.general")]);
    expect($(".prefs-nav")?.getAttribute("aria-label")).toBe(line("shortcuts.pages"));
    expect(search().placeholder).toBe(line("shortcuts.search"));
    expect(text()).toContain(line("shortcuts.done"));
    expect($(".sc-fixed")?.textContent).toBe(line("shortcuts.fixed"));
    expect($(".sc-fixed")?.getAttribute("title")).toBe(line("shortcuts.fixedTip"));
    for (const k of ["shortcuts.done", "shortcuts.fixed", "shortcuts.page.general"] as const) {
      expect(text()).not.toContain(english(k));
    }

    await capture(line("tool.fillet"));
    await type({ key: "j" });
    expect(rowOf(line("tool.fillet")).querySelector(".sc-changed")?.textContent).toBe(line("shortcuts.changed"));
    expect(rowOf(line("tool.fillet")).querySelector(".sc-reset")?.textContent).toBe(line("shortcuts.reset"));
    expect(rowOf(line("tool.fillet")).querySelector(".sc-reset")?.getAttribute("title")).toBe(
      line("shortcuts.resetTip"),
    );
    expect($(".sc-reset-all")?.textContent).toBe(line("shortcuts.resetAll"));
  });

  it("says nothing matches in German, and follows a switch with the window open, both ways", async () => {
    search().value = "zzqx";
    search().dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect($(".pref-hint")?.textContent).toBe(line("shortcuts.empty"));

    await setLanguage("en");
    await nextTick();
    expect($(".pref-hint")?.textContent).toBe(english("shortcuts.empty"));
    expect(text()).toContain(english("shortcuts.done"));
    expect(search().placeholder).toBe(english("shortcuts.search"));

    await setLanguage("de");
    await nextTick();
    expect($(".pref-hint")?.textContent).toBe(line("shortcuts.empty"));
    expect(text()).toContain(line("shortcuts.done"));
    expect(text()).not.toContain(english("shortcuts.done"));
  });

  it("writes the conflict line with the keys and the action, Replace and Cancel in German", async () => {
    await capture(line("tool.fillet"));
    await type({ key: "e" });
    const problem = rowOf(line("tool.fillet")).querySelector(".sc-problem")!;
    expect(problem.querySelector("span")?.textContent).toBe(
      line("shortcuts.problem.used", { keys: "E", action: line("tool.extrude") }),
    );
    expect([...problem.querySelectorAll(".btn")].map((b) => b.textContent)).toEqual([
      line("shortcuts.replace"),
      line("shortcuts.cancel"),
    ]);
  });

  it("writes the taken line for a key the app handles first, with no Replace", async () => {
    await capture(line("tool.fillet"));
    await type({ key: "z", ctrlKey: true, shiftKey: true });
    const row = rowOf(line("tool.fillet"));
    expect(row.querySelector(".sc-problem span")?.textContent).toBe(
      line("shortcuts.problem.taken", { keys: "Ctrl+Shift+Z", action: "Redo" }),
    );
    expect(row.querySelector(".sc-problem .btn-primary")).toBeNull();
  });

  it("refuses Alt in German, and any other refusal shows as given", async () => {
    await capture(line("tool.fillet"));
    await type({ key: "k", altKey: true });
    expect(rowOf(line("tool.fillet")).querySelector(".sc-problem span")?.textContent).toBe(
      line("shortcuts.problem.alt"),
    );
    expect(refusalLabel(ALT_REFUSAL)).toBe(line("shortcuts.problem.alt"));
    expect(refusalLabel("Some other refusal")).toBe("Some other refusal");
    await setLanguage("en");
    expect(refusalLabel(ALT_REFUSAL)).toBe(ALT_REFUSAL);
  });

  async function openReset() {
    mount(ModalHost, { attachTo: document.body });
    await click($(".sc-reset-all"));
    await settle();
  }

  it("asks and tells in German before and after Reset all on General", async () => {
    await capture(line("tool.measure"));
    await type({ key: "j" });
    await openReset();
    const box = $(".ui-confirm")!.textContent!;
    expect(box).toContain(line("shortcuts.resetPage.title"));
    expect(box).toContain(line("shortcuts.resetPage.body"));
    expect($$(".ui-confirm-choice")[1]!.textContent).toBe(line("shortcuts.reset"));
    $$(".ui-confirm-choice")[1]!.click();
    await settle();
    expect(useToastStore().items.map((t) => t.message)).toEqual([line("shortcuts.resetPage.done")]);
  });

  it("names a plugin page in its confirm and toast", async () => {
    const off = contribute("Test.Keys", {
      keymap: [{ action: "test.radial", key: "w", label: "Radial menu", context: "global" }],
    });
    await nextTick();
    await click($$(".prefs-nav-btn")[1]!);
    await capture("Radial menu");
    await type({ key: "y" });
    await openReset();
    expect($(".ui-confirm")!.textContent).toContain(line("shortcuts.resetPage.titleNamed", { name: "Test.Keys" }));
    $$(".ui-confirm-choice")[1]!.click();
    await settle();
    expect(useToastStore().items.map((t) => t.message)).toEqual([
      line("shortcuts.resetPage.doneNamed", { name: "Test.Keys" }),
    ]);
    off();
  });

  it("lists rows by their German names and finds them by German word, English name or key", async () => {
    const names = () => $$(".sc-row .sc-label").map((l) => l.textContent);
    const find = async (q: string) => {
      search().value = q;
      search().dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
      return names();
    };
    expect(names()).toContain(line("tool.fillet"));
    expect(names()).not.toContain(english("tool.fillet"));

    const fillets = [line("tool.fillet"), line("shortcuts.action.sketchFillet")];
    expect(await find("fillet")).toEqual(fillets);
    expect(await find("verrundung")).toEqual(fillets);
    expect(await find("Press/Pull")).toEqual([
      line("tool.pressPull"),
      line("shortcuts.action.finishWith", { tool: line("tool.pressPull") }),
    ]);
    expect(await find("zzqx")).toEqual([]);
    expect($(".pref-hint")?.textContent).toBe(line("shortcuts.empty"));

    await setLanguage("en");
    await nextTick();
    expect(await find("fillet")).toEqual([english("tool.fillet"), english("shortcuts.action.sketchFillet")]);
  });

  it("gives the wide class by group id", () => {
    const card = (title: string) => $$(".pref-card").find((c) => c.querySelector(".pref-title")?.textContent === title);
    expect(shortcutHudGroups().map((g) => g.id)).toEqual(["model", "sketch", "global", "mouse", "focus", "always"]);
    expect(
      [card("Mouse"), card("Always"), card(line("shortcuts.group.model")), card(line("tool.sketch"))].map((c) =>
        c?.classList.contains("wide"),
      ),
    ).toEqual([true, true, false, false]);
  });
});
