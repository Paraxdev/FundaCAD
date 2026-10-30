// Every check asks for the channel picked in Settings, Updates. Moving to an older line asks before it downloads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Action = { label: string; onClick: () => void };
const h = vi.hoisted(() => ({
  events: [] as string[],
  toasts: [] as { message: string; action?: Action | undefined }[],
  answers: [] as (string | null)[],
  store: new Map<string, string>(),
  found: true,
  downgrade: false,
  stable: false,
  checkFails: false,
  build: null as string | null,
  checks: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { channel: string; stableSeen: boolean }) => {
    if (cmd === "updates_supported") return true;
    if (cmd === "update_build_channel") return h.build;
    if (cmd !== "update_check") return void h.events.push(cmd);
    h.events.push(`check ${args?.channel}`);
    h.checks.push(args);
    if (h.checkFails) throw "error sending request";
    const update = { rid: 7, currentVersion: "1.1.2", version: "1.0.500", rawJson: {}, downgrade: h.downgrade };
    return { update: h.found ? update : null, stable: h.stable };
  },
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {
    version: string;
    currentVersion: string;
    constructor(meta: { rid: number; version: string; currentVersion: string }) {
      this.version = meta.version;
      this.currentVersion = meta.currentVersion;
      h.events.push(`update rid ${meta.rid}`);
    }
    async download() {
      h.events.push("download");
    }
    async install() {
      h.events.push("install");
    }
  },
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { action?: Action } = {}) => void h.toasts.push({ message, action: opts.action }),
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (title: string, options: { label: string }[], _signal?: AbortSignal, message?: string) => {
    h.events.push(`ask: ${title} [${options.map((o) => o.label).join(", ")}]${message ? ` ${message}` : ""}`);
    return h.answers.shift() ?? null;
  },
}));
vi.mock("../../src/ui/welcome", () => ({ openExternal: async (url: string) => void h.events.push(`open ${url}`) }));

const DOWNGRADE_Q =
  "ask: Beta 1.0.500 is older than this version [Install older version, Cancel] " +
  "It replaces FundaCAD 1.1.2 on this computer. Your files and settings stay.";

async function launch(settings: Record<string, string> = {}) {
  h.store = new Map(Object.entries(settings));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => h.store.get(k) ?? null,
    setItem: (k: string, v: string) => void h.store.set(k, v),
  });
  vi.resetModules();
  return {
    updates: await import("../../src/ui/updates"),
    channel: await import("../../src/ui/updateChannel"),
  };
}

beforeEach(() => {
  Object.assign(h, { events: [], toasts: [], answers: [], found: true, downgrade: false, stable: false });
  Object.assign(h, { build: null, checks: [] });
  h.checkFails = false;
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an update check", () => {
  it("asks the build's own channel by default", async () => {
    const { updates } = await launch();
    h.found = false;
    await updates.checkForUpdates(true, async () => "go");
    expect(h.events).toEqual(["check beta"]);
  });

  it("asks Stable after the switch and Beta again after switching back", async () => {
    const { updates, channel } = await launch({ "fundacad.updates.stableSeen": "yes" });
    h.found = false;
    channel.setUpdateChannel("stable");
    await updates.checkForUpdates(false, async () => "go");
    channel.setUpdateChannel("beta");
    await updates.checkForUpdates(false, async () => "go");
    expect(h.events).toEqual(["check stable", "check beta"]);
  });

  it("records a stable release it found, so Stable can be picked", async () => {
    const { updates, channel } = await launch();
    h.found = false;
    h.stable = true;
    expect(channel.stableReleaseSeen()).toBe(false);
    await updates.checkForUpdates(false, async () => "go");
    expect([channel.stableReleaseSeen(), h.store.get("fundacad.updates.stableSeen")]).toEqual([true, "yes"]);
  });

  it("tells the command once a stable release was seen, so it stops probing the stable feed", async () => {
    const { updates } = await launch();
    h.found = false;
    h.stable = true;
    await updates.checkForUpdates(false, async () => "go");
    await updates.checkForUpdates(false, async () => "go");
    expect(h.checks).toEqual([
      { channel: "beta", stableSeen: false },
      { channel: "beta", stableSeen: true },
    ]);
  });

  it("asks the channel Rust reads from this build's updater config when the frontend guessed another", async () => {
    const { updates, channel } = await launch({
      "fundacad.updates.channel": "stable",
      "fundacad.updates.stableSeen": "yes",
    });
    h.found = false;
    h.build = "development";
    await updates.checkForUpdates(true, async () => "go");
    expect([h.events, channel.buildChannel(), channel.updateChannel()]).toEqual([
      ["check development"],
      "development",
      "development",
    ]);
  });

  it("installs the update the command found, looked up by its id", async () => {
    const { updates } = await launch();
    h.answers = ["install"];
    await updates.checkForUpdates(true, async () => "go");
    expect(h.events).toEqual([
      "check beta",
      "update rid 7",
      "ask: Update 1.0.500 is available [Restart & update, Later]",
      "download",
      "install",
      "restart_for_update",
    ]);
  });
});

describe("an older version on the picked channel", () => {
  it("asks first from Help, and Cancel downloads nothing", async () => {
    const { updates } = await launch();
    h.downgrade = true;
    h.answers = ["cancel"];
    expect(await updates.checkForUpdates(true, async () => "go")).toBe(true);
    expect(h.events).toEqual(["check beta", "update rid 7", DOWNGRADE_Q]);
  });

  it("installs from Help once confirmed", async () => {
    const { updates } = await launch();
    h.downgrade = true;
    h.answers = ["install"];
    await updates.checkForUpdates(true, async () => "go");
    expect(h.events.slice(2)).toEqual([DOWNGRADE_Q, "download", "install", "restart_for_update"]);
  });

  it("asks first from the automatic check's toast, and Esc downloads nothing", async () => {
    const { updates } = await launch();
    h.downgrade = true;
    await updates.checkForUpdates(false, async () => "go");
    expect(h.toasts.map((t) => [t.message, t.action?.label])).toEqual([
      ["Beta 1.0.500 is available, older than this version.", "Install older version"],
    ]);
    h.toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(h.events.slice(2)).toEqual([DOWNGRADE_Q]));
    h.answers = ["install"];
    h.toasts[0]!.action!.onClick();
    await vi.waitFor(() =>
      expect(h.events.slice(3)).toEqual([DOWNGRADE_Q, "download", "install", "restart_for_update"]),
    );
  });
});

describe("the SourceForge link after a failed check", () => {
  it.each([
    ["beta", "https://sourceforge.net/projects/fundacad/files/beta/"],
    ["stable", "https://sourceforge.net/projects/fundacad/files/"],
  ])("follows the picked channel, %s", async (picked, url) => {
    const { updates, channel } = await launch({ "fundacad.updates.stableSeen": "yes" });
    channel.setUpdateChannel(picked as "beta" | "stable");
    h.checkFails = true;
    await updates.checkForUpdates(true, async () => "go");
    expect(h.toasts.map((t) => [t.message, t.action?.label])).toEqual([
      [
        "Could not check for updates (error sending request). Download the newest build from GitHub or SourceForge.",
        "Open SourceForge",
      ],
    ]);
    h.toasts[0]!.action!.onClick();
    await vi.waitFor(() => expect(h.events.at(-1)).toBe(`open ${url}`));
  });
});
