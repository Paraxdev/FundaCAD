import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../../src/ui/welcome", async (orig) => ({
  ...(await orig<typeof import("../../src/ui/welcome")>()),
  openExternal: async (url: string) => void opened.push(url),
}));

import { buildMenubar } from "../../src/app/menubarDef";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { allCommands } from "../../src/ui/commands";
import { ideaUrl } from "../../src/ui/reportText";
import { MANUAL_URL } from "../../src/ui/welcome";
import { useDialogStore } from "../../src/stores/dialogs";
import type { BugReportDeps } from "../../src/ui/bugReporter";
import type { Engine } from "../../src/app/engine";
import capabilitiesJson from "../../src-tauri/capabilities/default.json?raw";
import zensicalToml from "../../manual/zensical.toml?raw";

const help = () =>
  buildMenubar({ ui: { home: { open: () => {} } } } as unknown as Engine).find((m) => m.label === "Help")!;
const item = (label: string) => help().items.find((i) => i.label === label)!;

function openerScopes(): string[] {
  const caps = JSON.parse(capabilitiesJson);
  const opener = caps.permissions.find((p: { identifier?: string }) => p.identifier === "opener:allow-open-url");
  return opener.allow.map((a: { url: string }) => a.url);
}

const inScope = (url: string) => openerScopes().some((s) => url.startsWith(s.replace(/\*$/, "")));

describe("the Help menu", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    opened.length = 0;
  });

  it("lists the manual, the report, the idea form and the issue tracker", () => {
    expect(help().items.map((i) => (i.separator ? "---" : i.label))).toEqual([
      "Keyboard Shortcuts",
      "Manual",
      "---",
      "Report a Problem…",
      "Suggest an Idea",
      "Issue Tracker",
      "---",
      "Check for Updates…",
      "About FundaCAD",
    ]);
  });

  it("opens the idea form, the manual and the issues, each inside the opener's allow list", async () => {
    item("Suggest an Idea").onClick!();
    item("Manual").onClick!();
    item("Issue Tracker").onClick!();
    await Promise.resolve();
    expect(opened).toEqual([ideaUrl(), MANUAL_URL, "https://github.com/Paraxdev/fundacad/issues"]);
    expect(opened.map(inScope)).toEqual([true, true, true]);
    expect(inScope("https://paraxdev.github.io/elsewhere/")).toBe(false);
  });

  it("names the manual by the site the docs build publishes", () => {
    const site = /^site_url = "(.+)"$/m.exec(zensicalToml)![1];
    expect(MANUAL_URL).toBe(site);
  });

  it("opens the report only once the reporter is bound", () => {
    const dialogs = useDialogStore();
    item("Report a Problem…").onClick!();
    expect(dialogs.bugReport).toBe(false);
    dialogs.bindBugReporter({} as BugReportDeps);
    item("Report a Problem…").onClick!();
    expect(dialogs.bugReport).toBe(true);
  });
});

describe("the palette's Help commands", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    opened.length = 0;
  });

  it("are listed under Help", () => {
    const ids = ["manual", "report-problem", "suggest-idea"];
    expect(allCommands().filter((c) => ids.includes(c.id))).toEqual([
      { id: "manual", label: "Manual", group: "Help", context: "global" },
      { id: "report-problem", label: "Report a Problem…", group: "Help", context: "global" },
      { id: "suggest-idea", label: "Suggest an Idea", group: "Help", context: "global" },
    ]);
    expect(ids.filter((id) => !NON_REPEATABLE.has(id))).toEqual([]);
  });

  it("leave an open sketch open, so it is reported as it was", async () => {
    const finish = vi.fn();
    const e = { sketch: { active: true, finish }, lastAction: "extrude" } as unknown as Engine;
    const act = createActions(e);
    useDialogStore().bindBugReporter({} as BugReportDeps);
    act("report-problem");
    act("suggest-idea");
    act("manual");
    await Promise.resolve();
    expect([finish.mock.calls.length, useDialogStore().bugReport, opened, e.lastAction]).toEqual([
      0,
      true,
      [ideaUrl(), MANUAL_URL],
      "extrude",
    ]);
  });
});
