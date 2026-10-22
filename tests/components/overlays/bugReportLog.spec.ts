// The bug report carries the end of the app's log, read through the native
// `log_tail` when the dialog opens, and leaves it out when unticked, outside
// the app, or when the app has no log to give.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useDialogStore } from "../../../src/stores/dialogs";
import type { BugReportDeps } from "../../../src/ui/bugReporter";
import BugReportDialog from "../../../src/components/overlays/BugReportDialog.vue";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) =>
    cmd === "system_info"
      ? { system: "linux x86_64 · Ubuntu 24.04.1 LTS · AppImage", webview: "WebKitGTK 2.46.3" }
      : invoke(cmd),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.7" }));
const plugins = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock("../../../src/plugins", async (orig) => ({
  ...(await orig<typeof import("../../../src/plugins")>()),
  installedIds: () => plugins.ids,
}));

enableAutoUnmount(afterEach);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const copied: string[] = [];

const TAIL_A = [
  "[log] FundaCAD 1.0.7 started, logs to C:\\Users\\[REDACTED]\\AppData\\Local\\dev.fundacad.app\\logs\\fundacad.log",
  "[engine] ready on WebGPU stand in",
  "x".repeat(1500),
].join("\n");
const TAIL_B = "[engine] a second run\n[frames] 3 dropped";

function fakeBugDeps(): BugReportDeps {
  return {
    store: { toJSON: () => `{"features":[{"id":"f7"}]}` },
    geometry: { connected: true },
    viewport: { sceneStats: () => ["1 body"] },
    sketch: { snapshotFeature: () => null },
  } as unknown as BugReportDeps;
}

async function open(): Promise<void> {
  const dialogs = useDialogStore();
  dialogs.bindBugReporter(fakeBugDeps());
  dialogs.bugReport = true;
  mount(BugReportDialog, { attachTo: document.body });
  await flushPromises();
}

function tick(sel: string, on: boolean) {
  const box = $<HTMLInputElement>(sel)!;
  box.checked = on;
  box.dispatchEvent(new Event("change"));
}

async function copy(): Promise<string[]> {
  const desc = $<HTMLTextAreaElement>(".bug-desc")!;
  desc.value = "the bracket drew twice";
  desc.dispatchEvent(new Event("input"));
  $(".bug-send")!.dispatchEvent(new Event("click", { bubbles: true }));
  await flushPromises();
  return copied.at(-1)!.split("\n\n");
}

const preview = () => $(".bug-preview pre")!.textContent!;

describe("the bug report's app log", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    copied.length = 0;
    invoke.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete window.__FUNDACAD_SAFE_MODE__;
    plugins.ids = new Set();
  });

  it("attaches the tail in the app, before the document, and drops it when unticked", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(TAIL_A);
    await open();
    expect(invoke.mock.calls).toEqual([["log_tail"]]);
    expect($<HTMLInputElement>(".bug-log")!.checked).toBe(true);
    expect(preview()).toContain(`app log (the end, user names hidden):\n${TAIL_A}`);

    tick(".bug-doc", true);
    const ticked = await copy();
    expect(ticked.at(-2)!.split("\n").slice(1).join("\n")).toEqual(TAIL_A);
    expect(ticked.at(-2)).toMatch(/^app log/);
    expect(ticked.at(-1)).toEqual(`document:\n{"features":[{"id":"f7"}]}`);
    expect(ticked[0]!.split("\n").slice(0, 4)).toEqual([
      "FundaCAD problem report (format 2)",
      "version: 1.0.7 · channel beta",
      "system: linux x86_64 · Ubuntu 24.04.1 LTS · AppImage",
      "webview: WebKitGTK 2.46.3",
    ]);

    tick(".bug-log", false);
    const unticked = await copy();
    expect(unticked).toEqual([...ticked.slice(0, -2), ticked.at(-1)]);
  });

  it("carries only the log read when the dialog opened the second time", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(TAIL_A);
    await open();
    const first = await copy();
    document.body.innerHTML = "";
    invoke.mockResolvedValue(TAIL_B);
    await open();
    const second = await copy();
    expect(first.at(-1)!.split("\n").slice(1).join("\n")).toEqual(TAIL_A);
    expect(second.at(-1)!.split("\n").slice(1).join("\n")).toEqual(TAIL_B);
    expect(copied.at(-1)).not.toContain("WebGPU stand in");
  });

  it.each([
    ["in a browser", false, () => invoke.mockResolvedValue(TAIL_A)],
    ["when the app has no log yet", true, () => invoke.mockResolvedValue(null)],
    ["when the app cannot read it", true, () => invoke.mockRejectedValue(new Error("no log dir"))],
  ])("offers no log %s", async (_, inApp, answer) => {
    if (inApp) (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    answer();
    await open();
    expect(invoke.mock.calls).toEqual(inApp ? [["log_tail"]] : []);
    expect($(".bug-log")).toBeNull();
    expect(preview()).not.toContain("app log");
    const sections = await copy();
    expect(sections.at(-1)!.startsWith("render pipeline:")).toBe(true);
  });

  it("names safe mode and the running plugins, or says off and none", async () => {
    const header = async () => (await copy())[0]!.split("\n").slice(-2);
    await open();
    expect(await header()).toEqual(["safe mode: off", "plugins: none"]);
    document.body.innerHTML = "";

    window.__FUNDACAD_SAFE_MODE__ = { reason: "failedStarts", failedStarts: 3 };
    plugins.ids = new Set(["screws", "printing-toolkit"]);
    await open();
    expect(await header()).toEqual([
      "safe mode: on, the last 3 starts did not finish",
      "plugins: printing-toolkit, screws",
    ]);
  });
});
