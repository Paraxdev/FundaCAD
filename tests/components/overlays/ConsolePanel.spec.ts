// The console's controls on the base set: the level filters are pressed toggles, the icon buttons are named by
// their tip, and the panel is not modal, so it leaves Escape to whatever is underneath.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import ConsolePanel from "../../../src/components/overlays/ConsolePanel.vue";
import { clearLog, consoleOpen, log, setConsoleOpen } from "../../../src/ui/logStore";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

describe("ConsolePanel", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    clearLog();
    log("error", "Fillet failed", { source: "kernel", detail: "at fillet" });
    log("info", "Saved");
    setConsoleOpen(true);
    mount(ConsolePanel, { attachTo: document.body });
    await nextTick();
  });
  afterEach(() => setConsoleOpen(false));

  it("filters by level with pressed toggles", async () => {
    const filters = $$(".logcon-filter");
    expect(filters.map((f) => [f.textContent!.replace(/\s+/g, " ").trim(), f.getAttribute("aria-pressed")])).toEqual([
      ["error 1", "true"],
      ["warning 0", "true"],
      ["info 1", "false"],
    ]);
    expect($$(".logcon-row").length).toBe(1);
    filters[2]!.click();
    await nextTick();
    expect([filters[2]!.getAttribute("aria-pressed"), $$(".logcon-row").length]).toEqual(["true", 2]);
  });

  it("names every icon button by its tip, title and aria-label alike", () => {
    const named = $$(".logcon .icon-btn").map((b) => [b.getAttribute("title"), b.getAttribute("aria-label")]);
    expect(named).toEqual([
      ["Copy everything shown", "Copy everything shown"],
      ["Clear", "Clear"],
      ["Close", "Close"],
      ["Copy this entry", "Copy this entry"],
    ]);
  });

  it("opens a row's detail on more and closes on Close", async () => {
    $(".logcon-more")!.click();
    await nextTick();
    expect([$(".logcon-detail")!.textContent, $(".logcon-more")!.textContent!.trim()]).toEqual(["at fillet", "less"]);
    $('.logcon [title="Close"]')!.click();
    await nextTick();
    expect([consoleOpen(), $(".logcon")]).toEqual([false, null]);
  });

  it("is not modal and lets Escape through", () => {
    expect($(".logcon")!.getAttribute("aria-modal")).toBeNull();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    $(".logcon-filter")!.dispatchEvent(e);
    expect([e.defaultPrevented, consoleOpen()]).toEqual([false, true]);
  });
});
