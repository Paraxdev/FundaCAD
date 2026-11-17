// Export, Parameters, the problem report, the console, the notices and the open notice follow the chosen language,
// live, while the log lines and the report's own text stay as they were written.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ExportDialog from "../../../src/components/overlays/ExportDialog.vue";
import ParamsDialog from "../../../src/components/overlays/ParamsDialog.vue";
import BugReportDialog from "../../../src/components/overlays/BugReportDialog.vue";
import ConsolePanel from "../../../src/components/overlays/ConsolePanel.vue";
import ToastStack from "../../../src/components/overlays/ToastStack.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { setLanguage, t } from "../../../src/i18n";
import en from "../../../src/i18n/locales/en.json";
import de from "../../../src/i18n/locales/de.json";
import ja from "../../../src/i18n/locales/ja.json";
import { useExportDialogStore } from "../../../src/stores/exportDialog";
import { useDialogStore } from "../../../src/stores/dialogs";
import { usePanelsStore } from "../../../src/stores/panels";
import { useToastStore } from "../../../src/stores/toasts";
import { clearLog, log, openConsole, setConsoleOpen } from "../../../src/ui/logStore";
import { openNotices } from "../../../src/document/openNotice";
import { SEE_CONSOLE, seeConsole, sketchConflictText } from "../../../src/ui/plainError";
import type { BugReportDeps } from "../../../src/ui/bugReporter";
import type { CadDocument, Feature } from "../../../src/types";
import { englishLeft } from "../../i18n/englishLeft";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.7" }));

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const settle = () => new Promise((r) => setTimeout(r, 5));
const titleOf = (panel: HTMLElement) =>
  document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent?.trim();

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.replaceChildren();
});
afterEach(async () => {
  await setLanguage("system");
});

describe("the Export dialog", () => {
  const Host = defineComponent({
    setup() {
      const store = useExportDialogStore();
      return () => (store.request ? h(ExportDialog) : null);
    },
  });

  it("reads in German and then Japanese, its pickers' lists too", async () => {
    localStorage.removeItem("fundacad.exportSettings");
    mount(Host, { attachTo: document.body });
    void useExportDialogStore().open({
      bodies: [
        { id: "body1", name: "Bracket" },
        { id: "body2", name: "Lid" },
      ],
      format: "stl",
    });
    await settle();
    const shown = (testid: string) => $(`[data-testid=${testid}] .select-value`)!.textContent!.trim();
    expect(shown("export-refinement")).toBe(en["export.refinement.medium"]);

    await setLanguage("de");
    await nextTick();
    expect(titleOf($("[role=dialog]")!)).toBe(de["export.title"]);
    expect($("[data-testid=export-confirm]")!.textContent!.trim()).toBe(de["export.confirm"]);
    expect(shown("export-refinement")).toBe(de["export.refinement.medium"]);
    expect(shown("export-scope")).toBe(de["export.scope.all"]);

    await setLanguage("ja");
    await nextTick();
    expect(titleOf($("[role=dialog]")!)).toBe(ja["export.title"]);
    expect(shown("export-refinement")).toBe(ja["export.refinement.medium"]);
    expect(shown("export-scope")).toBe(ja["export.scope.all"]);
    expect(shown("export-format")).toBe("STL (*.stl)");
  });
});

describe("the Parameters panel", () => {
  function engine() {
    const doc = {
      parameters: {},
      features: [],
      paramDefs: { w: { expr: "40", value: 40, unit: "mm" } },
    } as unknown as CadDocument;
    const store = { document: doc, paramIssues: {} };
    return { store, bridge: { docVersion: ref(0), buildVersion: ref(0), editPreviewVersion: ref(0) } };
  }

  it("names its sections, columns, fields and hint in German and Japanese", async () => {
    mount(ParamsDialog, {
      global: { provide: { [ENGINE as symbol]: engine() as unknown as Engine } },
      attachTo: document.body,
    });
    usePanelsStore().params = true;
    await flushPromises();
    const panel = () => $(".params-dialog")!;
    const labels = () => $$(".params-dialog input").map((i) => i.getAttribute("aria-label"));

    await setLanguage("de");
    await nextTick();
    expect(panel().textContent).toContain(de["params.user"]);
    expect(panel().textContent).toContain(de["params.column.expression"]);
    expect($(".params-dialog .measure-hint")!.textContent!.trim()).toBe(de["params.hint"]);
    expect(labels()).toContain(de["params.nameOf"].replace("{name}", "w"));
    expect($$(".params-dialog input").map((i) => i.getAttribute("placeholder"))).toContain(
      de["params.new.expressionPlaceholder"],
    );

    await setLanguage("ja");
    await nextTick();
    expect(panel().textContent).toContain(ja["params.user"]);
    expect(panel().textContent).toContain(ja["params.add"]);
    expect(labels()).toContain(ja["params.commentOn"].replace("{name}", "w"));
    expect(englishLeft(panel().textContent!, en["params.hint"], ["semicolon"])).toEqual([]);
  });
});

describe("the problem report", () => {
  const BIG_DOC = `{"pad":"${"x".repeat(61_440 - 10)}"}`;

  it("asks in German and Japanese, keeps the report's own notes English", async () => {
    const dialogs = useDialogStore();
    dialogs.bugDeps = {
      store: { toJSON: () => BIG_DOC },
      geometry: { connected: true },
      viewport: { sceneStats: () => ["3 bodies"], renderStill: () => "" },
      sketch: { snapshotFeature: () => null },
    } as unknown as BugReportDeps;
    dialogs.bugReport = true;
    await setLanguage("de");
    mount(BugReportDialog, { attachTo: document.body });
    await flushPromises();

    expect(titleOf($("[role=dialog]")!)).toBe(de["bugReport.title"]);
    expect($(".bug-doc-big")!.textContent!.trim()).toBe(de["bugReport.tooBig"].replace("{size}", "60 KB"));
    expect($(".bug-github")!.textContent!.trim()).toBe(de["bugReport.github"]);
    expect($(".bug-preview pre")!.textContent).toContain("FundaCAD problem report");

    await setLanguage("ja");
    await nextTick();
    expect(titleOf($("[role=dialog]")!)).toBe(ja["bugReport.title"]);
    expect($(".bug-cancel")!.textContent!.trim()).toBe(ja["common.cancel"]);
  });
});

describe("the console", () => {
  beforeEach(() => {
    clearLog();
    log("error", "Fillet failed", { source: "kernel", detail: "at fillet" });
    openConsole();
  });
  afterEach(() => {
    setConsoleOpen(false);
    clearLog();
  });

  it("translates its own chrome and leaves each log line as written", async () => {
    mount(ConsolePanel, { attachTo: document.body });
    await nextTick();
    await setLanguage("de");
    await nextTick();
    expect($(".logcon-title")!.textContent).toBe(de["console.title"]);
    expect($(".logcon-filter.is-error")!.textContent!.trim()).toBe(`${t("console.level", { level: "error" })} 1`);
    expect($(".logcon-more")!.textContent!.trim()).toBe(de["console.more"]);
    expect($(".logcon-body")!.getAttribute("aria-label")).toBe(de["console.messages"]);
    expect($(".logcon-msg")!.textContent).toBe("Fillet failed");

    await setLanguage("ja");
    await nextTick();
    expect($(".logcon-filter.is-error")!.textContent!.trim()).toBe("エラー 1");
    expect($(".logcon-row .sr-only")!.textContent).toBe(t("console.severity", { level: "error" }));
    expect($(".logcon-copy")!.getAttribute("aria-label")).toBe(ja["console.copyEntry"]);
  });
});

describe("the notices", () => {
  it("label their region and dismiss button in the chosen language", async () => {
    mount(ToastStack, { attachTo: document.body });
    useToastStore().push("Saved", "info", undefined, 60000);
    await setLanguage("de");
    await nextTick();
    expect($(".toast-stack")!.getAttribute("aria-label")).toBe(de["toast.region"]);
    expect($(".toast .icon-btn")!.getAttribute("aria-label")).toBe(de["toast.dismiss"]);
    await setLanguage("ja");
    await nextTick();
    expect($(".toast-stack")!.getAttribute("aria-label")).toBe(ja["toast.region"]);
    expect($(".toast .icon-btn")!.getAttribute("aria-label")).toBe(ja["toast.dismiss"]);
    expect($(".toast-msg")!.textContent).toBe("Saved");
  });
});

describe("the notice when a file opens", () => {
  const doc = (n: number) => ({
    features: Array.from(
      { length: n },
      (_, i) => ({ id: `z${i}`, type: `zz${i}`, name: `n${i}` }) as unknown as Feature,
    ),
  });

  it("joins the names and counts the rest in Japanese", async () => {
    await setLanguage("ja");
    const [notice] = openNotices(doc(5), 1);
    expect(notice!.message).toContain("n0、n1、n2 ほか 2 件");
    expect(notice!.message).toContain("5 個のフィーチャ");
    expect(notice!.detail).toContain("zz0 (1): z0");
  });

  it("names one feature in German", async () => {
    await setLanguage("de");
    const [notice] = openNotices(doc(1), 1);
    expect(notice!.message).toMatch(/^1 Feature braucht ein Plug-in, das hier nicht läuft: n0\./);
  });
});

describe("the lines from plainError", () => {
  it("say the console line in the chosen language, and in English for an English sentence", async () => {
    await setLanguage("de");
    expect(seeConsole()).toBe(de["console.seeDetails"]);
    expect(SEE_CONSOLE).toBe(en["console.seeDetails"]);
  });

  it("say a sketch conflict in Japanese, with and without the sketch", async () => {
    await setLanguage("ja");
    const features = [{ id: "s1", type: "sketch" }] as unknown as Feature[];
    expect(sketchConflictText("s1", features)).not.toMatch(/[A-Za-z]{4,}/);
    expect(sketchConflictText("gone", features)).not.toMatch(/[A-Za-z]{4,}/);
    expect(sketchConflictText("s1", features)).not.toBe(sketchConflictText("gone", features));
  });
});
