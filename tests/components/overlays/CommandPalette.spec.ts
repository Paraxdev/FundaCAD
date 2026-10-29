// The command palette: its search field holds focus from open to close, the arrows walk the list, Enter runs the
// active row, and Escape closes only the palette and gives focus back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import CommandPalette from "../../../src/components/overlays/CommandPalette.vue";
import Dialog from "../../../src/components/ui/Dialog.vue";
import { useCommandPaletteStore } from "../../../src/stores/commandPalette";
import { attachAnnouncer } from "../../../src/ui/announce";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const later = () => new Promise((r) => setTimeout(r, 5));
const input = () => $(".cmdk-input input") as HTMLInputElement;
const options = () => $$('[role="listbox"] [role="option"]');
const activeOption = () => document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
const nameOf = (o: HTMLElement) => o.textContent!.replace(/\s+/g, " ").trim();

function type(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

// Plain objects stand in for the live regions; every sentence set on the polite one is kept.
function liveRegions() {
  const lines: string[] = [];
  const polite = {
    get textContent() {
      return lines.at(-1) ?? "";
    },
    set textContent(v: string | null) {
      if (v) lines.push(v.trim());
    },
  };
  const detach = attachAnnouncer({ polite, assertive: { textContent: "" } });
  return { lines, detach };
}

function key(k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

let heard: string[] = [];
const listen = (e: KeyboardEvent) => heard.push(e.key);

async function openPalette() {
  useCommandPaletteStore().toggle("model");
  await nextTick();
  await later();
}

describe("CommandPalette", () => {
  let opener: HTMLButtonElement;
  let ran: string[];
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    heard = [];
    ran = [];
    window.addEventListener("keydown", listen);
    mount(CommandPalette, { attachTo: document.body });
    useCommandPaletteStore().bind((id) => ran.push(id));
  });
  afterEach(() => {
    window.removeEventListener("keydown", listen);
    vi.useRealTimers();
    setMacForTest(null);
  });

  it("puts the caret in the search field on open, named and placeheld as before", async () => {
    await openPalette();
    expect(document.activeElement).toBe(input());
    expect([input().getAttribute("aria-label"), input().placeholder]).toEqual(["Search commands", "Search commands…"]);
    expect($(".cmdk-card")!.getAttribute("aria-modal")).toBe("true");
  });

  it("walks the list on the arrows, clamped at both ends, with focus left in the field", async () => {
    await openPalette();
    const rows = () => $$(".cmdk-item");
    const at = () => rows().findIndex((r) => r.classList.contains("is-active"));
    expect(rows().length).toBeGreaterThan(2);
    expect(at()).toBe(0);
    key("ArrowDown");
    key("ArrowDown");
    await nextTick();
    expect(at()).toBe(2);
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    await nextTick();
    expect(at()).toBe(0);
    expect(document.activeElement).toBe(input());
  });

  it("filters as it is typed and runs the active row on Enter", async () => {
    await openPalette();
    input().value = "fillet";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const first = $(".cmdk-item.is-active .cmdk-label")!.textContent!;
    expect(first.toLowerCase()).toContain("fillet");
    key("Enter");
    expect(ran).toHaveLength(1);
    expect(useCommandPaletteStore().open).toBe(false);
  });

  it("keeps Tab on the field", async () => {
    await openPalette();
    const e = key("Tab");
    expect([e.defaultPrevented, document.activeElement]).toEqual([true, input()]);
  });

  it("closes on Escape without the key reaching the app, and gives focus back", async () => {
    await openPalette();
    key("Escape");
    await nextTick();
    await later();
    expect([$(".cmdk-card"), heard, document.activeElement]).toEqual([null, [], opener]);
  });

  it("makes the page behind inert while open, and live again before focus goes back", async () => {
    await openPalette();
    expect([!!opener.closest("[inert]"), $(".cmdk-backdrop")!.closest("[inert]")]).toEqual([true, null]);
    key("Escape");
    await nextTick();
    await later();
    expect([$$("[inert]"), document.activeElement]).toEqual([[], opener]);
  });

  it("hands focus to the main landmark when its opener is gone", async () => {
    const main = document.createElement("main");
    document.body.append(main);
    await openPalette();
    opener.remove();
    key("Escape");
    await nextTick();
    await later();
    expect([document.activeElement, $$("[inert]")]).toEqual([main, []]);
  });

  it("over a dialog, Escape closes only the palette", async () => {
    const under = mount(Dialog, { props: { title: "Export" }, attachTo: document.body });
    await later();
    await openPalette();
    key("Escape");
    await nextTick();
    await later();
    expect([$(".cmdk-card"), under.emitted("close")]).toEqual([null, undefined]);
  });

  it("is a combobox over a listbox of options with ids, the first one active", async () => {
    await openPalette();
    const list = document.getElementById(input().getAttribute("aria-controls") ?? "")!;
    expect([input().getAttribute("role"), input().getAttribute("aria-expanded")]).toEqual(["combobox", "true"]);
    expect([list.getAttribute("role"), list.getAttribute("aria-label")]).toEqual(["listbox", "Search commands"]);
    expect(options().every((o, i) => o.id === `${list.id}-${i}` && o.classList.contains("cmdk-item"))).toBe(true);
    expect([activeOption(), activeOption()!.getAttribute("aria-selected")]).toEqual([options()[0], "true"]);
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("names each option by its label, group and shortcut, and gives the shortcut as aria-keyshortcuts", async () => {
    setMacForTest(false);
    await openPalette();
    type("save as");
    await nextTick();
    const o = activeOption()!;
    expect(nameOf(o)).toBe("Save As…, File, Ctrl+Shift+S");
    expect(o.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+S");
    expect([
      o.querySelector(".cmdk-label"),
      o.querySelector(".cmdk-group"),
      o.querySelector(".cmdk-key"),
    ]).not.toContain(null);
  });

  it("writes the shortcut with Meta on macOS and lists both keys of a two key command", async () => {
    setMacForTest(true);
    await openPalette();
    type("save as");
    await nextTick();
    expect(activeOption()!.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+S");
    type("fit view");
    await nextTick();
    expect(activeOption()!.getAttribute("aria-keyshortcuts")).toBe("Home F6");
  });

  it("moves aria-activedescendant and aria-selected on the arrows, focus left in the field", async () => {
    await openPalette();
    key("ArrowDown");
    await nextTick();
    expect([activeOption(), document.activeElement]).toEqual([options()[1], input()]);
    expect(
      options()
        .map((o) => o.getAttribute("aria-selected"))
        .slice(0, 2),
    ).toEqual(["false", "true"]);
  });

  it("speaks the result count and the first match once, 300 ms after a burst of typing stops", async () => {
    await openPalette();
    const { lines, detach } = liveRegions();
    vi.useFakeTimers();
    for (const q of ["f", "fi", "fil"]) {
      type(q);
      await nextTick();
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(150);
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(400);
    const n = options().length;
    expect(n).toBeGreaterThan(1);
    expect(lines).toEqual([`${n} commands. ${nameOf(options()[0]!)}`]);
    detach();
  });

  it("says one command with its name, and no matching command with the list closed", async () => {
    setMacForTest(false);
    await openPalette();
    const { lines, detach } = liveRegions();
    vi.useFakeTimers();
    type("save as");
    await nextTick();
    vi.advanceTimersByTime(500);
    type("zzqq");
    await nextTick();
    vi.advanceTimersByTime(500);
    expect(lines).toEqual(["1 command. Save As, File, Ctrl+Shift+S", "No matching command"]);
    expect([input().getAttribute("aria-expanded"), input().getAttribute("aria-activedescendant")]).toEqual([
      "false",
      null,
    ]);
    expect($(".cmdk-empty")!.textContent).toBe("No matching command");
    detach();
  });

  it("says nothing on open, and drops a count still waiting when it closes", async () => {
    const { lines, detach } = liveRegions();
    await openPalette();
    vi.useFakeTimers();
    vi.advanceTimersByTime(500);
    type("fil");
    await nextTick();
    key("Escape");
    await nextTick();
    vi.advanceTimersByTime(500);
    expect(lines).toEqual([]);
    detach();
  });

  it("runs a row on click", async () => {
    await openPalette();
    type("save as");
    await nextTick();
    activeOption()!.click();
    expect(ran).toEqual(["saveas"]);
  });
});
