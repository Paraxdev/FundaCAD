import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: 0, fail: false, supported: true, store: new Map<string, string>() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => h.supported }));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => {
    h.calls++;
    if (h.fail) throw new Error("offline");
    return null;
  },
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => {} }));
vi.mock("../../src/ui/choice", () => ({ choose: async () => null }));

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 1);

async function launch(settings: Record<string, string> = {}) {
  h.store = new Map(Object.entries(settings));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => h.store.get(k) ?? null,
    setItem: (k: string, v: string) => void h.store.set(k, v),
  });
  vi.resetModules();
  vi.stubEnv("DEV", false);
  const updates = await import("../../src/ui/updates");
  const prefs = await import("../../src/ui/updatePrefs");
  updates.scheduleStartupUpdateCheck(async () => "go");
  await vi.advanceTimersByTimeAsync(0);
  return { updates, prefs };
}

/** How many checks ran within `ms` of fake time. */
async function checksWithin(ms: number): Promise<number> {
  const before = h.calls;
  await vi.advanceTimersByTimeAsync(ms);
  return h.calls - before;
}

const last = (ago: number) => ({ "fundacad.updates.lastCheck": String(T0 - ago) });

beforeEach(() => {
  Object.assign(h, { calls: 0, fail: false, supported: true });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("automatic update checks", () => {
  it("make none at launch and none later when switched off", async () => {
    await launch({ "fundacad.updates.auto": "off", "fundacad.updates.period": "launch" });
    expect([await checksWithin(30 * DAY), vi.getTimerCount()]).toEqual([0, 0]);
  });

  it("run 8 s after every launch with the period Every launch, and once per session", async () => {
    await launch({ "fundacad.updates.period": "launch", ...last(60_000) });
    expect([await checksWithin(7999), await checksWithin(1), await checksWithin(30 * DAY)]).toEqual([0, 1, 0]);
  });

  it("run at the first launch ever, 8 s in", async () => {
    await launch();
    expect([await checksWithin(7999), await checksWithin(1)]).toEqual([0, 1]);
  });

  it.each([
    ["daily", 3 * HOUR, 0],
    ["daily", 25 * HOUR, 1],
    ["daily", DAY, 1],
    ["weekly", 6 * DAY, 0],
    ["weekly", 8 * DAY, 1],
    ["weekly", 7 * DAY, 1],
  ])("at launch, %s with the last check %i ms ago ran %i checks in the first 8 s", async (period, ago, ran) => {
    await launch({ "fundacad.updates.period": period!, ...last(ago!) });
    expect(await checksWithin(8000)).toBe(ran);
  });

  it.each([
    ["daily", DAY],
    ["weekly", 7 * DAY],
  ])("wait until exactly the %s period has passed, not a millisecond less", async (period, span) => {
    await launch({ "fundacad.updates.period": period, ...last(span - 20_000) });
    expect([await checksWithin(19_999), await checksWithin(1)]).toEqual([0, 1]);
  });

  it("check again when an open session crosses the period, once", async () => {
    await launch({ ...last(3 * HOUR) });
    expect(await checksWithin(21 * HOUR - 1)).toBe(0);
    expect(await checksWithin(1)).toBe(1);
    expect(await checksWithin(DAY - 1)).toBe(0);
    expect(await checksWithin(1)).toBe(1);
  });

  it("record the time of a check that reached the feed", async () => {
    const { prefs } = await launch();
    await checksWithin(8000);
    expect([prefs.lastUpdateCheck(), h.store.get("fundacad.updates.lastCheck")]).toEqual([
      T0 + 8000,
      String(T0 + 8000),
    ]);
  });

  it("record nothing for a failed check and try again one period later", async () => {
    h.fail = true;
    const { prefs } = await launch({ ...last(2 * DAY) });
    expect(await checksWithin(8000)).toBe(1);
    expect([prefs.lastUpdateCheck(), h.store.get("fundacad.updates.lastCheck")]).toEqual([
      T0 - 2 * DAY,
      String(T0 - 2 * DAY),
    ]);
    expect(await checksWithin(DAY - 1)).toBe(0);
    h.fail = false;
    expect(await checksWithin(1)).toBe(1);
    expect(prefs.lastUpdateCheck()).toBe(T0 + 8000 + DAY);
  });

  it("retry at the next launch after a failure", async () => {
    h.fail = true;
    await launch({ ...last(2 * DAY) });
    await checksWithin(8000);
    h.fail = false;
    await launch({ ...last(2 * DAY) });
    expect(await checksWithin(8000)).toBe(1);
  });

  it("cancel the pending timer when switched off, and plan again when switched on", async () => {
    const { prefs } = await launch({ ...last(3 * HOUR) });
    expect(vi.getTimerCount()).toBe(1);
    prefs.setAutoUpdateCheck(false);
    expect([vi.getTimerCount(), await checksWithin(30 * DAY)]).toEqual([0, 0]);
    prefs.setAutoUpdateCheck(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(await checksWithin(8000)).toBe(1);
  });

  it("reschedule when the period changes", async () => {
    const { prefs } = await launch({ ...last(3 * HOUR) });
    prefs.setUpdatePeriod("weekly");
    expect(await checksWithin(6 * DAY)).toBe(0);
    expect(await checksWithin(DAY)).toBe(1);
  });

  it("leave the Help check running when switched off", async () => {
    const { updates } = await launch({ "fundacad.updates.auto": "off" });
    expect([await updates.checkForUpdates(true, async () => "go"), h.calls]).toEqual([true, 1]);
  });

  it("are not planned where the install cannot update itself", async () => {
    h.supported = false;
    await launch();
    expect([vi.getTimerCount(), await checksWithin(30 * DAY)]).toEqual([0, 0]);
  });
});

describe("the update settings", () => {
  it("default to on and daily, and are stored when changed", async () => {
    const { prefs } = await launch();
    expect([prefs.autoUpdateCheck(), prefs.updatePeriod()]).toEqual([true, "daily"]);
    prefs.setAutoUpdateCheck(false);
    prefs.setUpdatePeriod("weekly");
    expect([...h.store.entries()]).toEqual([
      ["fundacad.updates.auto", "off"],
      ["fundacad.updates.period", "weekly"],
    ]);
  });
});
