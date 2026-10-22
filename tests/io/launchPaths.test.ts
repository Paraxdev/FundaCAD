import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  queue: [] as string[],
  opened: [] as string[],
  outcome: "ok" as string,
  homeClosed: 0,
  toasts: [] as string[],
  listener: null as null | (() => void),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd !== "take_launch_paths") throw new Error(cmd);
    const out = m.queue;
    m.queue = [];
    return out;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, cb: () => void) => {
    m.listener = cb;
    return () => {};
  },
}));
vi.mock("../../src/app/documentActions", () => ({
  openPathGuarded: async (_e: unknown, path: string) => {
    m.opened.push(path);
    return m.outcome;
  },
}));
vi.mock("../../src/ui/home", () => ({
  closeHome: () => {
    m.homeClosed++;
  },
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (t: string) => {
    m.toasts.push(t);
  },
}));

import { drainLaunchPaths, installLaunchPaths } from "../../src/io/launchPaths";

const e = {} as Parameters<typeof drainLaunchPaths>[0];
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  m.queue = [];
  m.opened = [];
  m.outcome = "ok";
  m.homeClosed = 0;
  m.toasts = [];
  m.listener = null;
});

describe("documents FundaCAD is launched with", () => {
  it("opens the first one and closes Home", async () => {
    m.queue = ["/a.funda", "/b.funda"];
    await drainLaunchPaths(e);
    expect(m.opened).toEqual(["/a.funda"]);
    expect(m.homeClosed).toBe(1);
    expect(m.toasts.join()).toMatch(/one document at a time/);
  });

  it("does nothing with none", async () => {
    await drainLaunchPaths(e);
    expect(m.opened).toEqual([]);
    expect(m.homeClosed).toBe(0);
  });

  it("keeps Home open when the open was cancelled", async () => {
    m.queue = ["/a.funda"];
    m.outcome = "cancelled";
    await drainLaunchPaths(e);
    expect(m.homeClosed).toBe(0);
  });

  it("waits for the recovery prompt, then opens each later launch's document", async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      let answer!: () => void;
      const recovery = new Promise<void>((r) => {
        answer = r;
      });
      m.queue = ["/first.funda"];
      installLaunchPaths(e, recovery);
      await settle();
      expect(m.opened).toEqual([]);
      answer();
      await settle();
      await settle();
      expect(m.opened).toEqual(["/first.funda"]);
      m.queue = ["/second.fundab"];
      m.listener?.();
      await settle();
      expect(m.opened).toEqual(["/first.funda", "/second.fundab"]);
    } finally {
      delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
