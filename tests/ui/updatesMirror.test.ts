import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Action = { label: string; onClick: () => void };
const h = vi.hoisted(() => ({
  toasts: [] as { message: string; kind?: string | undefined; action?: Action | undefined }[],
  opened: [] as string[],
  checkFails: false,
  downloadFails: false,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => true }));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => {
    if (h.checkFails) throw new Error("offline");
    return {
      version: "1.0.413",
      download: async () => {
        if (h.downloadFails) throw new Error("reset");
      },
      install: async () => {},
    };
  },
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { kind?: string; action?: Action } = {}) =>
    void h.toasts.push({ message, kind: opts.kind, action: opts.action }),
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => "install" }));
vi.mock("../../src/ui/welcome", () => ({ openExternal: async (url: string) => void h.opened.push(url) }));

import { sourceforgeUrl } from "../../src/app/channel";
import { checkForUpdates } from "../../src/ui/updates";

const MIRROR = "GitHub could not be reached. Download the newest build from SourceForge instead.";

beforeEach(() => {
  Object.assign(h, { toasts: [], opened: [], checkFails: false, downloadFails: false });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the SourceForge mirror folder", () => {
  it.each([
    ["beta", "https://sourceforge.net/projects/fundacad/files/beta/"],
    ["development", "https://sourceforge.net/projects/fundacad/files/development/"],
    ["stable", "https://sourceforge.net/projects/fundacad/files/"],
    ["nightly", "https://sourceforge.net/projects/fundacad/files/"],
  ])("for the %s channel is %s", (tag, url) => {
    expect(sourceforgeUrl(tag)).toBe(url);
  });
});

describe("a failed update", () => {
  it("from Help's check offers the mirror and opens it", async () => {
    h.checkFails = true;
    await checkForUpdates(true, async () => "go");
    expect(h.toasts.map((t) => [t.message, t.kind, t.action?.label])).toEqual([
      [`${MIRROR} (offline)`, "error", "Open SourceForge"],
    ]);
    h.toasts[0]!.action!.onClick();
    expect(h.opened).toEqual([sourceforgeUrl()]);
  });

  it("from a download offers the mirror and opens it", async () => {
    h.downloadFails = true;
    await checkForUpdates(true, async () => "go");
    expect(h.toasts.map((t) => [t.message, t.kind, t.action?.label])).toEqual([
      ["Downloading the update…", undefined, undefined],
      [`${MIRROR} (reset)`, "error", "Open SourceForge"],
    ]);
    h.toasts[1]!.action!.onClick();
    expect(h.opened).toEqual([sourceforgeUrl()]);
  });

  it("from the automatic check shows nothing", async () => {
    h.checkFails = true;
    expect([await checkForUpdates(false, async () => "go"), h.toasts]).toEqual([false, []]);
  });
});
