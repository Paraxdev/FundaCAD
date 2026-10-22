import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h as render, type Component } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useDialogStore } from "../../../src/stores/dialogs";
import { clearLog, logEntries, logError, logInfo, logWarning } from "../../../src/ui/logStore";
import { issueUrl, recentErrors } from "../../../src/ui/reportText";
import type { BugReportDeps } from "../../../src/ui/bugReporter";
import BugReportDialog from "../../../src/components/overlays/BugReportDialog.vue";

const SYSTEM = "linux x86_64 · Ubuntu 24.04.1 LTS · AppImage";
const TAIL = "[log] FundaCAD 1.0.7 started\n[engine] ready\n[frames] 2 dropped";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) =>
    cmd === "system_info" ? { system: SYSTEM, webview: "WebKitGTK 2.46.3" } : cmd === "log_tail" ? TAIL : null,
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.7" }));

const h = vi.hoisted(() => ({
  order: [] as string[],
  opened: [] as string[],
  openFails: false,
  saves: [] as [string, string][],
  saveAnswer: null as string | null,
  toasts: [] as { message: string; opts: { kind?: string; action?: { label: string; onClick: () => void } } }[],
}));

vi.mock("../../../src/ui/welcome", async (orig) => ({
  ...(await orig<typeof import("../../../src/ui/welcome")>()),
  openExternal: async (url: string) => {
    h.order.push("open");
    if (h.openFails) throw new Error("no browser");
    h.opened.push(url);
  },
}));
vi.mock("../../../src/io/files", async (orig) => ({
  ...(await orig<typeof import("../../../src/io/files")>()),
  saveRenderedImage: async (url: string, name: string) => {
    h.saves.push([url, name]);
    return h.saveAnswer;
  },
}));
vi.mock("../../../src/ui/toast", async (orig) => ({
  ...(await orig<typeof import("../../../src/ui/toast")>()),
  toast: (message: string, opts = {}) => {
    h.toasts.push({ message, opts });
    return 1;
  },
}));

enableAutoUnmount(afterEach);

const SMALL_DOC = `{"features":[{"id":"f7","type":"fillet","radius":2.5}]}`;
// 61,440 characters, over the 55,000 a report can hold, and exactly 60 KB.
const BIG_DOC = `{"pad":"${"x".repeat(61_440 - 10)}"}`;
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const clipboard = { writes: [] as string[], refuse: false };
const renderStill = vi.fn((..._args: unknown[]) => PICTURE);

function deps(doc: string): BugReportDeps {
  return {
    store: { toJSON: () => doc },
    geometry: { connected: true },
    viewport: { sceneStats: () => ["3 bodies, 1,284 faces"], renderStill },
    sketch: { snapshotFeature: () => null },
  } as unknown as BugReportDeps;
}

// Mirrors App.vue, so a closed dialog unmounts and the next open is a new one.
function host(dialog: Component, store: () => ReturnType<typeof useDialogStore>) {
  mount(
    defineComponent({
      setup: () => () => (store().bugReport && store().bugDeps ? render(dialog) : null),
    }),
    { attachTo: document.body },
  );
}

async function open(doc = SMALL_DOC): Promise<void> {
  const dialogs = useDialogStore();
  dialogs.bindBugReporter(deps(doc));
  dialogs.bugReport = true;
  await flushPromises();
}

async function type(text: string) {
  const desc = $<HTMLTextAreaElement>(".bug-desc")!;
  desc.value = text;
  desc.dispatchEvent(new Event("input"));
  await flushPromises();
}

function click(sel: string) {
  $(sel)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function tick(sel: string, on: boolean) {
  const box = $<HTMLInputElement>(sel)!;
  box.checked = on;
  box.dispatchEvent(new Event("change"));
  await flushPromises();
}

const shown = () => $(".bug-report-card") !== null;
const preview = () => $(".bug-preview pre")!.textContent!;
const DESCRIPTION = "The fillet on the slanted rim vanished\nafter I undid the shell";
const ISSUE = issueUrl({ description: DESCRIPTION, version: "1.0.7", system: SYSTEM });

describe("Report a problem", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    Object.assign(h, { order: [], opened: [], openFails: false, saves: [], saveAnswer: null, toasts: [] });
    Object.assign(clipboard, { writes: [], refuse: false });
    renderStill.mockClear();
    clearLog();
    host(BugReportDialog, useDialogStore);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          h.order.push("clipboard");
          if (clipboard.refuse) return Promise.reject(new Error("NotAllowedError"));
          clipboard.writes.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("is titled Report a problem and sends nothing without a description", async () => {
    await open();
    expect($("#bug-report-title")!.textContent).toBe("Report a problem");
    for (const empty of ["", "  \n "]) {
      await type(empty);
      $<HTMLButtonElement>(".bug-shot")!.focus();
      click(".bug-github");
      await flushPromises();
      expect(document.activeElement).toBe($(".bug-desc"));
    }
    expect([h.order, h.toasts, shown()]).toEqual([[], [], true]);

    await type("x");
    click(".bug-github");
    await flushPromises();
    expect([h.order, shown()]).toEqual([["clipboard", "open"], false]);
  });

  it("copies the whole report before anything else, then opens the prefilled issue", async () => {
    await open();
    await type(DESCRIPTION);
    const expected = preview();
    click(".bug-github");
    // Synchronous with the click: WebKit refuses the clipboard once user activation has passed.
    expect([h.order, clipboard.writes]).toEqual([["clipboard"], [expected]]);
    await flushPromises();

    expect(h.order).toEqual(["clipboard", "open"]);
    expect(h.opened).toEqual([ISSUE]);
    expect([renderStill.mock.calls.length, h.saves]).toEqual([0, []]);
    expect(h.toasts.map((t) => [t.message, t.opts.kind, t.opts.action?.label])).toEqual([
      ["Report copied. Paste it into the Report box on GitHub.", "info", "Copy Again"],
    ]);
    expect(shown()).toBe(false);
  });

  it("copies only, with Copy report, and never renders or saves", async () => {
    await open();
    await type(DESCRIPTION);
    const expected = preview();
    click(".bug-send");
    await flushPromises();
    expect([h.order, clipboard.writes, h.opened, h.saves]).toEqual([["clipboard"], [expected], [], []]);
    expect(renderStill).not.toHaveBeenCalled();
    expect(h.toasts.map((t) => t.message)).toEqual(["Report copied."]);
    expect(shown()).toBe(false);
  });

  it("keeps the dialog and opens no browser when the clipboard is refused", async () => {
    clipboard.refuse = true;
    await open();
    await type(DESCRIPTION);
    click(".bug-github");
    await flushPromises();
    expect([h.order, h.opened, shown()]).toEqual([["clipboard"], [], true]);
    expect(h.toasts.map((t) => t.opts.kind)).toEqual(["error"]);
    expect(h.toasts[0]!.message).toContain("Could not reach the clipboard");
  });

  it("closes with the browser notice when the clipboard worked but the browser would not open", async () => {
    h.openFails = true;
    await open();
    await type(DESCRIPTION);
    click(".bug-github");
    await flushPromises();
    expect([h.order, clipboard.writes.length, shown()]).toEqual([["clipboard", "open"], 1, false]);
    expect(h.toasts.map((t) => [t.opts.kind, t.opts.action?.label])).toEqual([["warning", "Copy Again"]]);
    expect(h.toasts[0]!.message).toContain("Could not open the browser");
    expect(h.toasts[0]!.message).toContain("github.com/Paraxdev/fundacad/issues");
  });

  it("renders and saves a picture only on Save Picture, and the GitHub notice names the saved file", async () => {
    h.saveAnswer = "/home/alice/Desktop/rim-problem.png";
    await open();
    expect(renderStill).not.toHaveBeenCalled();
    click(".bug-shot");
    await flushPromises();
    expect(renderStill.mock.calls).toEqual([[1, { edges: true, realtime: true }]]);
    expect(h.saves).toEqual([[PICTURE, "fundacad-report.png"]]);
    expect($<HTMLImageElement>(".bug-shot-saved img")!.getAttribute("src")).toBe(PICTURE);
    expect($(".bug-shot-saved")!.textContent).toContain("Saved as rim-problem.png");
    expect([h.order, shown()]).toEqual([[], true]);

    await type(DESCRIPTION);
    click(".bug-github");
    await flushPromises();
    expect(h.toasts.map((t) => t.message)).toEqual([
      "Report copied. Paste it into the Report box on GitHub. Drag rim-problem.png into the issue too.",
    ]);
  });

  it("changes nothing when the picture save is cancelled", async () => {
    await open();
    click(".bug-shot");
    await flushPromises();
    expect(renderStill).toHaveBeenCalledOnce();
    expect(h.saves.map((s) => s[1])).toEqual(["fundacad-report.png"]);
    expect([$(".bug-shot-saved"), h.order, h.toasts, shown()]).toEqual([null, [], [], true]);
  });

  it("puts the same report back with Copy Again after the clipboard was overwritten", async () => {
    await open();
    await type(DESCRIPTION);
    const first = preview();
    click(".bug-github");
    await flushPromises();
    const fromToast = h.toasts[0]!.opts.action!;
    clipboard.writes.push("482913");

    await open();
    expect($(".bug-again")!.textContent).toMatch(/^Last report, \d{1,2}.\d{2}/);
    click(".bug-again-copy");
    await flushPromises();
    expect(clipboard.writes.slice(-2)).toEqual(["482913", first]);

    clipboard.writes.push("a code from GitHub");
    fromToast.onClick();
    await flushPromises();
    expect(clipboard.writes.at(-1)).toBe(first);
  });

  it("disables the document box for a document too big for an issue", async () => {
    await open(BIG_DOC);
    expect($<HTMLInputElement>(".bug-doc")!.disabled).toBe(true);
    expect($(".bug-doc-big")!.textContent).toContain("(60 KB)");
    expect(preview()).not.toContain("document:");
  });

  it("adds a small document only when ticked, shown in the preview as its size", async () => {
    await open();
    expect([$<HTMLInputElement>(".bug-doc")!.disabled, $(".bug-doc-big")]).toEqual([false, null]);
    await type(DESCRIPTION);
    expect(preview()).not.toContain("document:");

    await tick(".bug-doc", true);
    expect(preview().endsWith(`document:\n(the current document, ${SMALL_DOC.length} bytes)`)).toBe(true);
    const shownText = preview();
    click(".bug-send");
    await flushPromises();
    expect(clipboard.writes).toEqual([
      shownText.replace(`(the current document, ${SMALL_DOC.length} bytes)`, SMALL_DOC),
    ]);
  });

  it("previews the whole report, the log and the recent errors in full", async () => {
    logError("Fillet f7 failed", { source: "rebuild", detail: "BRep_API: command not done\nradius 2.5 on edge 14" });
    logWarning("Slow rebuild, 812 ms");
    logInfo("Saved");
    await open();
    await type(DESCRIPTION);
    const text = preview();
    const errors = recentErrors(logEntries());
    expect(errors).toHaveLength(1);
    expect(text).toContain(`recent errors:\n${errors[0]}`);
    expect(text).toContain("radius 2.5 on edge 14");
    expect(text).toContain(`app log (the end, user names hidden):\n${TAIL}`);
    expect(text).not.toContain("Slow rebuild");
    click(".bug-send");
    await flushPromises();
    expect(clipboard.writes).toEqual([text]);
  });

  it("keeps no last report in a new session", async () => {
    await open();
    await type(DESCRIPTION);
    click(".bug-send");
    await flushPromises();
    await open();
    expect($(".bug-again")).not.toBeNull();

    vi.resetModules();
    const fresh = await import("../../../src/ui/bugReporter");
    expect(fresh.lastReport()).toBeNull();
    const { default: FreshDialog } = await import("../../../src/components/overlays/BugReportDialog.vue");
    const { useDialogStore: freshDialogs } = await import("../../../src/stores/dialogs");
    useDialogStore().bugReport = false;
    await flushPromises();
    setActivePinia(createPinia());
    host(FreshDialog, freshDialogs);
    freshDialogs().bindBugReporter(deps(SMALL_DOC));
    freshDialogs().bugReport = true;
    await flushPromises();
    expect([$(".bug-report-card") !== null, $(".bug-again")]).toEqual([true, null]);
  });
});
