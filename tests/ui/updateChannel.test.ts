// Settings, Updates, Channel: Stable and Beta are one product and switch where this install updates from, Development
// is FundaCAD Dev and only ever installs beside it. Stable stays out of reach until a check has found one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  store.clear();
});

async function load(release: string) {
  vi.resetModules();
  vi.stubEnv("VITE_FUNDACAD_RELEASE", release);
  return import("../../src/ui/updateChannel");
}

describe("the channel of a build", () => {
  it("is beta, development, or stable for a version tag", async () => {
    const m = await load("beta");
    expect(["beta", "development", "v1.1.0"].map(m.channelOfTag)).toEqual(["beta", "development", "stable"]);
  });

  it.each([
    ["beta", "beta"],
    ["development", "development"],
    ["v1.1.0", "stable"],
  ])("is the default channel of a %s build", async (release, channel) => {
    const m = await load(release);
    expect([m.BUILD_CHANNEL, m.updateChannel()]).toEqual([channel, channel]);
  });
});

describe("picking a channel", () => {
  it("switches between Stable and Beta and installs the other product beside", async () => {
    const { channelAction } = await load("beta");
    expect(channelAction("beta", "stable")).toBe("switch");
    expect(channelAction("stable", "beta")).toBe("switch");
    expect(channelAction("beta", "beta")).toBe("switch");
    expect(channelAction("development", "development")).toBe("switch");
    expect(channelAction("beta", "development")).toBe("beside");
    expect(channelAction("stable", "development")).toBe("beside");
    expect(channelAction("development", "beta")).toBe("beside");
    expect(channelAction("development", "stable")).toBe("beside");
  });

  it("names the product a beside install brings and its release page", async () => {
    const m = await load("beta");
    expect(m.besideTitle("development")).toBe("Install FundaCAD Dev beside this app");
    expect(m.besideTitle("beta")).toBe("Install FundaCAD beside this app");
    expect(m.releasePageUrl("development")).toBe("https://github.com/Paraxdev/fundacad/releases/tag/development");
    expect(m.releasePageUrl("beta")).toBe("https://github.com/Paraxdev/fundacad/releases/tag/beta");
    expect(m.releasePageUrl("stable")).toBe("https://github.com/Paraxdev/fundacad/releases/latest");
  });

  it("stores Stable and back to Beta and tells the listeners", async () => {
    const m = await load("beta");
    m.recordStableSeen(true);
    const heard = vi.fn();
    m.onUpdateChannelChange(heard);
    expect(m.setUpdateChannel("stable")).toBe(true);
    expect([m.updateChannel(), store.get("fundacad.updates.channel")]).toEqual(["stable", "stable"]);
    expect((await load("beta")).updateChannel()).toBe("stable");
    const again = await load("beta");
    expect(again.setUpdateChannel("beta")).toBe(true);
    expect([again.updateChannel(), store.get("fundacad.updates.channel")]).toEqual(["beta", "beta"]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("never stores the other product", async () => {
    const m = await load("beta");
    const heard = vi.fn();
    m.onUpdateChannelChange(heard);
    expect(m.setUpdateChannel("development")).toBe(false);
    expect([m.updateChannel(), store.has("fundacad.updates.channel"), heard.mock.calls.length]).toEqual([
      "beta",
      false,
      0,
    ]);
    const dev = await load("development");
    expect(dev.setUpdateChannel("beta")).toBe(false);
    expect(dev.updateChannel()).toBe("development");
  });

  it("ignores a stored channel of the other product", async () => {
    store.set("fundacad.updates.channel", "beta");
    expect((await load("development")).updateChannel()).toBe("development");
    store.set("fundacad.updates.channel", "development");
    expect((await load("beta")).updateChannel()).toBe("beta");
  });
});

describe("a stable release", () => {
  it("is not seen in a beta build until a check finds one, and then stays seen", async () => {
    const m = await load("beta");
    const heard = vi.fn();
    m.onUpdateChannelChange(heard);
    expect(m.stableReleaseSeen()).toBe(false);
    m.recordStableSeen(false);
    expect([m.stableReleaseSeen(), heard.mock.calls.length]).toEqual([false, 0]);
    m.recordStableSeen(true);
    expect([m.stableReleaseSeen(), heard.mock.calls.length]).toEqual([true, 1]);
    m.recordStableSeen(false);
    expect((await load("beta")).stableReleaseSeen()).toBe(true);
  });

  it("is seen by a stable build", async () => {
    expect((await load("v1.1.0")).stableReleaseSeen()).toBe(true);
  });

  it("must be seen before a stored Stable is used", async () => {
    store.set("fundacad.updates.channel", "stable");
    expect((await load("beta")).updateChannel()).toBe("beta");
  });
});

describe("the channel options", () => {
  it("keep Stable disabled with a reason until one is seen", async () => {
    const { channelOptions } = await load("beta");
    expect(channelOptions("beta", false)).toEqual([
      { value: "stable", label: "Stable", hint: "No stable release yet", disabled: true },
      { value: "beta", label: "Beta" },
      { value: "development", label: "Development", hint: "Installs FundaCAD Dev beside this app" },
    ]);
    expect(channelOptions("beta", true)[0]).toEqual({ value: "stable", label: "Stable" });
  });

  it("offer FundaCAD beside a development build", async () => {
    const { channelOptions } = await load("development");
    expect(channelOptions("development", true)).toEqual([
      { value: "stable", label: "Stable", hint: "Installs FundaCAD beside this app" },
      { value: "beta", label: "Beta", hint: "Installs FundaCAD beside this app" },
      { value: "development", label: "Development" },
    ]);
  });
});
