// The console's controls on the base set: the level filters are pressed toggles, the icon buttons are named by
// their tip, and the panel is not modal, so it leaves Escape to whatever is underneath.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import ConsolePanel from "../../../src/components/overlays/ConsolePanel.vue";
import { clearLog, consoleOpen, log, openConsole, setConsoleOpen, toggleConsole } from "../../../src/ui/logStore";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

describe("ConsolePanel", () => {
  let current: ReturnType<typeof mount>;
  beforeEach(async () => {
    document.body.innerHTML = "";
    clearLog();
    log("error", "Fillet failed", { source: "kernel", detail: "at fillet" });
    log("info", "Saved");
    setConsoleOpen(true);
    current = mount(ConsolePanel, { attachTo: document.body });
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

  describe("as a region", () => {
    const remount = async (opener?: HTMLElement) => {
      current.unmount();
      setConsoleOpen(false);
      document.body.innerHTML = "";
      if (opener) document.body.appendChild(opener);
      opener?.focus();
      current = mount(ConsolePanel, { attachTo: document.body });
      await nextTick();
    };

    it("is a region named by an h2 heading that can take focus", () => {
      const region = $(".logcon")!;
      const h = $("#logcon-heading")!;
      expect([
        region.getAttribute("role"),
        region.getAttribute("aria-labelledby"),
        h.tagName,
        h.getAttribute("tabindex"),
        h.textContent,
      ]).toEqual(["region", "logcon-heading", "H2", "-1", "Console"]);
    });

    it("holds its rows in a log that does not speak on its own", () => {
      const b = $(".logcon-body")!;
      expect([b.getAttribute("role"), b.getAttribute("aria-live"), b.getAttribute("aria-label")]).toEqual([
        "log",
        "off",
        "Console messages",
      ]);
    });

    it("starts each row with its severity word", async () => {
      clearLog();
      log("warning", "Slow rebuild", { source: "engine" });
      log("error", "Fillet failed");
      log("info", "Saved 3 files");
      for (const f of $$(".logcon-filter")) if (f.getAttribute("aria-pressed") === "false") f.click();
      await nextTick();
      const sr = $$(".logcon-row").map((r) => [
        r.querySelector(".sr-only")!.textContent,
        r.querySelector(".logcon-msg")!.textContent,
      ]);
      expect(sr).toEqual([
        ["Warning:", "Slow rebuild"],
        ["Error:", "Fillet failed"],
        ["Info:", "Saved 3 files"],
      ]);
    });

    it("moves focus to the heading when opened with focus, from a button", async () => {
      const btn = document.createElement("button");
      await remount(btn);
      openConsole({ focus: true });
      await nextTick();
      await nextTick();
      expect(document.activeElement).toBe($("#logcon-heading"));
    });

    it("leaves focus in a text field when opened without focus", async () => {
      const input = document.createElement("input");
      await remount(input);
      openConsole({ focus: false });
      await nextTick();
      await nextTick();
      expect(document.activeElement).toBe(input);
      expect($(".logcon")).not.toBeNull();
    });

    it("does not pull focus again on a later change once the request was used", async () => {
      const btn = document.createElement("button");
      await remount(btn);
      openConsole({ focus: true });
      await nextTick();
      await nextTick();
      btn.focus();
      log("error", "Another failure");
      await nextTick();
      await nextTick();
      expect(document.activeElement).toBe(btn);
    });

    it("hands focus back to the opener on Close", async () => {
      const btn = document.createElement("button");
      await remount(btn);
      openConsole({ focus: true });
      await nextTick();
      await nextTick();
      $('.logcon [title="Close"]')!.click();
      await nextTick();
      await nextTick();
      expect([consoleOpen(), document.activeElement]).toEqual([false, btn]);
    });

    it("hands focus back when the chord toggle closes it", async () => {
      const btn = document.createElement("button");
      await remount(btn);
      toggleConsole({ focus: true });
      await nextTick();
      await nextTick();
      toggleConsole({ focus: true });
      await nextTick();
      await nextTick();
      expect(document.activeElement).toBe(btn);
    });

    it("does nothing on close when the opener left the page", async () => {
      const btn = document.createElement("button");
      await remount(btn);
      openConsole({ focus: true });
      await nextTick();
      await nextTick();
      btn.remove();
      $('.logcon [title="Close"]')!.click();
      await nextTick();
      await nextTick();
      expect(document.activeElement).toBe(document.body);
    });

    it("keeps focus where the user moved it before closing", async () => {
      const btn = document.createElement("button");
      const other = document.createElement("button");
      await remount(btn);
      document.body.appendChild(other);
      openConsole({ focus: true });
      await nextTick();
      await nextTick();
      other.focus();
      setConsoleOpen(false);
      await nextTick();
      await nextTick();
      expect(document.activeElement).toBe(other);
    });
  });
});
