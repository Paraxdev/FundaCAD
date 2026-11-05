// Reset settings from Rust's start question: the backup is written before anything is cleared, plugins go off only
// with the box, and the recent files list stays.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_FORMAT,
  PLUGINS_OFF_KEY,
  runStartChoice,
  settingsSnapshot,
  startChoiceNotice,
  type StartChoice,
  type StartChoiceDeps,
} from "../../src/app/startChoice";
import { getRecentFiles } from "../../src/io/recentFiles";

const RECENT = JSON.stringify([{ path: "C:/parts/bracket.funda", openedAt: 1 }]);

function seed() {
  localStorage.clear();
  localStorage.setItem("fundacad.recentFiles", RECENT);
  localStorage.setItem("fundacad.theme", "light");
  localStorage.setItem("fundacad.experimental", JSON.stringify({ bounces: 12 }));
  localStorage.setItem("fundacad.pluginSettings.FundaCAD.Gamepad", JSON.stringify({ deadzone: 0.3 }));
}

function deps(choice: StartChoice | null, o: Partial<StartChoiceDeps> = {}) {
  const order: string[] = [];
  const backUp = vi.fn(async (text: string) => {
    order.push(`backup with ${localStorage.length} keys`);
    return `C:/Users/me/AppData/Roaming/FundaCAD/settings-backups/settings-${text.length}.json`;
  });
  const d = {
    storage: localStorage,
    take: vi.fn(async () => choice),
    backUp,
    installedPluginIds: vi.fn(async () => ["FundaCAD.Gamepad", "Acme.Gears"]),
    now: () => new Date("2026-11-05T09:00:00Z"),
    ...o,
  } satisfies StartChoiceDeps;
  const removeItem = localStorage.removeItem.bind(localStorage);
  vi.spyOn(localStorage, "removeItem").mockImplementation((k: string) => {
    order.push(`remove ${k}`);
    removeItem(k);
  });
  return { d, order, backUp };
}

beforeEach(() => {
  seed();
  window.__FUNDACAD_START_CHOICE__ = { reset: true };
});
afterEach(() => {
  delete window.__FUNDACAD_START_CHOICE__;
  vi.restoreAllMocks();
});

describe("a start without a Reset settings choice", () => {
  it("touches nothing and does not ask Rust when no hint was set", async () => {
    delete window.__FUNDACAD_START_CHOICE__;
    const { d } = deps({ reset: true, plugins: true });
    expect(await runStartChoice(d)).toBeNull();
    expect(d.take).not.toHaveBeenCalled();
    expect(localStorage.getItem("fundacad.theme")).toBe("light");
  });

  it("touches nothing when the choice was already taken, as on a reload of the page", async () => {
    const { d, backUp } = deps(null);
    expect(await runStartChoice(d)).toBeNull();
    expect([backUp.mock.calls.length, localStorage.length]).toEqual([0, 4]);
  });

  it("touches nothing outside the app, where there is no Rust to ask", async () => {
    expect(await runStartChoice(null)).toBeNull();
    expect(localStorage.length).toBe(4);
  });
});

describe("Reset settings", () => {
  it("writes the backup of every setting before it clears one", async () => {
    const { d, order, backUp } = deps({ reset: true, plugins: false });
    const out = await runStartChoice(d);
    expect(order[0]).toBe("backup with 4 keys");
    expect(order.slice(1).sort()).toEqual([
      "remove fundacad.experimental",
      "remove fundacad.pluginSettings.FundaCAD.Gamepad",
      "remove fundacad.theme",
    ]);
    const saved = JSON.parse(backUp.mock.calls[0]![0]);
    expect(saved).toEqual({
      format: BACKUP_FORMAT,
      version: 1,
      savedAt: "2026-11-05T09:00:00.000Z",
      localStorage: {
        "fundacad.recentFiles": RECENT,
        "fundacad.theme": "light",
        "fundacad.experimental": '{"bounces":12}',
        "fundacad.pluginSettings.FundaCAD.Gamepad": '{"deadzone":0.3}',
      },
    });
    expect(out).toEqual({ kind: "reset", backup: expect.stringContaining("settings-backups"), plugins: "kept" });
  });

  it("clears the settings and keeps the recent files list", async () => {
    const { d } = deps({ reset: true, plugins: false });
    await runStartChoice(d);
    expect(Object.keys(settingsSnapshot(localStorage))).toEqual(["fundacad.recentFiles"]);
    expect(getRecentFiles()).toEqual([{ path: "C:/parts/bracket.funda", openedAt: 1 }]);
  });

  it("keeps an older name of the recent files list too", async () => {
    localStorage.removeItem("fundacad.recentFiles");
    localStorage.setItem("neocad.recentFiles", RECENT);
    const { d } = deps({ reset: true, plugins: false });
    await runStartChoice(d);
    expect(getRecentFiles().map((r) => r.path)).toEqual(["C:/parts/bracket.funda"]);
  });

  it("clears nothing when the backup could not be written, and says why", async () => {
    const { d, order } = deps(
      { reset: true, plugins: true },
      { backUp: vi.fn(async () => Promise.reject(new Error("disk full"))) },
    );
    const out = await runStartChoice(d);
    expect(out).toEqual({ kind: "backupFailed", error: "disk full" });
    expect([order, localStorage.length, localStorage.getItem(PLUGINS_OFF_KEY)]).toEqual([[], 4, null]);
    expect(startChoiceNotice(out!)).toEqual({
      text: "Settings were not reset, because their backup could not be written: disk full",
      kind: "warning",
    });
  });
});

describe("Also turn off plugins", () => {
  it("is not asked about and changes no plugin without the box", async () => {
    localStorage.setItem(PLUGINS_OFF_KEY, JSON.stringify(["Acme.Gears"]));
    const { d } = deps({ reset: true, plugins: false });
    await runStartChoice(d);
    expect(d.installedPluginIds).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PLUGINS_OFF_KEY)!)).toEqual(["Acme.Gears"]);
  });

  it("switches every installed plugin off with the box, and uninstalls none", async () => {
    localStorage.setItem(PLUGINS_OFF_KEY, JSON.stringify(["Old.Off"]));
    const { d } = deps({ reset: true, plugins: true });
    const out = await runStartChoice(d);
    expect(JSON.parse(localStorage.getItem(PLUGINS_OFF_KEY)!)).toEqual(["Acme.Gears", "FundaCAD.Gamepad", "Old.Off"]);
    expect(out).toMatchObject({ kind: "reset", plugins: "off" });
    vi.resetModules();
    const registry = await import("../../src/plugins/registry");
    expect(["FundaCAD.Gamepad", "Acme.Gears"].map(registry.pluginEnabled)).toEqual([false, false]);
  });

  it("still resets when the plugin list cannot be read, and says the plugins are still on", async () => {
    const { d } = deps(
      { reset: true, plugins: true },
      { installedPluginIds: vi.fn(async () => Promise.reject(new Error("no plugins root"))) },
    );
    const out = await runStartChoice(d);
    expect(out).toMatchObject({ kind: "reset", plugins: { failed: "no plugins root" } });
    expect(localStorage.getItem("fundacad.theme")).toBeNull();
    expect(startChoiceNotice(out!)).toMatchObject({
      text: expect.stringMatching(/^Settings were reset, but plugins could not be turned off: no plugins root\./),
      kind: "warning",
    });
  });
});

describe("the notice after a reset", () => {
  it("says where the old settings are, and where plugins come back on", () => {
    const backup = "C:/b/settings.json";
    expect(startChoiceNotice({ kind: "reset", backup, plugins: "kept" })).toEqual({
      text: "Settings were reset. The old settings are saved in C:/b/settings.json.",
      kind: "info",
    });
    expect(startChoiceNotice({ kind: "reset", backup, plugins: "off" }).text).toBe(
      "Settings were reset and plugins turned off. The old settings are saved in C:/b/settings.json. Turn plugins back on in Preferences, Plugins.",
    );
  });
});
