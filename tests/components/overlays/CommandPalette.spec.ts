// The command palette: its search field holds focus from open to close, the arrows walk the list, Enter runs the
// active row, and Escape closes only the palette and gives focus back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import CommandPalette from "../../../src/components/overlays/CommandPalette.vue";
import Dialog from "../../../src/components/ui/Dialog.vue";
import { useCommandPaletteStore } from "../../../src/stores/commandPalette";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const later = () => new Promise((r) => setTimeout(r, 5));
const input = () => $(".cmdk-input input") as HTMLInputElement;

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
  afterEach(() => window.removeEventListener("keydown", listen));

  it("puts the caret in the search field on open, named and placeheld as before", async () => {
    await openPalette();
    expect(document.activeElement).toBe(input());
    expect([input().getAttribute("aria-label"), input().placeholder]).toEqual(["Search commands", "Search commands…"]);
    expect($(".cmdk-card")!.getAttribute("aria-modal")).toBe("true");
  });

  it("walks the list on the arrows, clamped at both ends, with focus left in the field", async () => {
    await openPalette();
    const rows = () => $$(".cmdk-item");
    const at = () => rows().findIndex((r) => r.classList.contains("active"));
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
    const first = $(".cmdk-item.active .cmdk-label")!.textContent!;
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
});
