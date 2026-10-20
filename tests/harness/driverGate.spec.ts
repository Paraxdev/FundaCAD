import { describe, expect, it } from "vitest";
import { createBridge, createMethods, harnessWanted, HARNESS_API, installHarness, startScreen, type HarnessHost } from "../../src/harness/driver";
import { HarnessError } from "../../src/harness/locate";

const host = {} as HarnessHost;

function fakeWindow(search: string) {
  return { location: { search }, document } as unknown as Window & { __harness?: { api: number } };
}

describe("harness gate", () => {
  it("installs only with ?harness=1 in a dev build", () => {
    expect(harnessWanted("?harness=1", true)).toBe(true);
    expect(harnessWanted("?harness=1", false)).toBe(false);
    expect(harnessWanted("?token=x", true)).toBe(false);
    expect(harnessWanted("?harness=yes", true)).toBe(false);
  });

  it("publishes the bridge with its api number", () => {
    const off = fakeWindow("?token=t");
    expect(installHarness(host, off)).toBe(false);
    expect(off.__harness).toBeUndefined();
    const on = fakeWindow("?token=t&harness=1");
    expect(installHarness(host, on)).toBe(true);
    expect(on.__harness!.api).toBe(HARNESS_API);
  });
});

describe("bridge", () => {
  const bridge = createBridge({
    echo: (a) => a.x,
    later: async () => 5,
    refuse: () => { throw new HarnessError("nope", "NotFound", ["a"]); },
    crash: () => { throw new TypeError("boom"); },
  });

  it("wraps values and errors as plain JSON", async () => {
    expect(await bridge.call("echo", { x: 3 })).toEqual({ ok: true, value: 3 });
    expect(await bridge.call("later")).toEqual({ ok: true, value: 5 });
    expect(await bridge.call("refuse")).toEqual({ ok: false, error: { kind: "NotFound", message: "nope", candidates: ["a"] } });
    expect(await bridge.call("crash")).toEqual({ ok: false, error: { kind: "Internal", message: "boom", candidates: [] } });
    expect((await bridge.call("missing")).ok).toBe(false);
  });
});

describe("startScreen", () => {
  it("tells Home from the older welcome modal", () => {
    document.body.innerHTML = `<div class="home" role="dialog"><button class="modal-close"></button></div>`;
    expect(startScreen()).toBe("home");
    document.body.innerHTML = `<div class="modal-overlay"><div class="modal-panel welcome-panel"></div></div>`;
    expect(startScreen()).toBe("welcome");
    document.body.innerHTML = "";
    expect(startScreen()).toBe("none");
  });
});

describe("screen", () => {
  it("names the regions when asked for one that does not exist", () => {
    const m = createMethods(host, document);
    expect(() => m.screen!({ region: "foo" })).toThrow(/regions are titlebar, menu, toolrail/);
  });
});
