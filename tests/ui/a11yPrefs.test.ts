// The Accessibility settings: defaults, stored values from this build and the one before it, and the OS reduce
// motion preference followed live while the app runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeQuery {
  matches: boolean;
  private fns = new Set<() => void>();
  constructor(matches: boolean) {
    this.matches = matches;
  }
  addEventListener(_type: "change", fn: () => void) {
    this.fns.add(fn);
  }
  flip(matches: boolean) {
    this.matches = matches;
    for (const fn of this.fns) fn();
  }
}

class OldQuery {
  matches = false;
  private fns = new Set<() => void>();
  addListener(fn: () => void) {
    this.fns.add(fn);
  }
  flip(matches: boolean) {
    this.matches = matches;
    for (const fn of this.fns) fn();
  }
}

let stored: Map<string, string>;
let query: FakeQuery | OldQuery;

function boot(entries: Record<string, string> = {}, os: FakeQuery | OldQuery = new FakeQuery(false)) {
  stored = new Map(Object.entries(entries));
  query = os;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  vi.stubGlobal("matchMedia", (q: string) => {
    expect(q).toBe("(prefers-reduced-motion: reduce)");
    return query;
  });
}

async function load() {
  vi.resetModules();
  const prefs = await import("../../src/ui/a11yPrefs");
  const motion = await import("../../src/ui/motion");
  const dwell = await import("../../src/ui/interactionPrefs");
  return { ...prefs, ...motion, ...dwell };
}

beforeEach(() => boot());
afterEach(() => vi.unstubAllGlobals());

describe("defaults", () => {
  it("follow the system and speak at the normal level when nothing is stored", async () => {
    const m = await load();
    expect(m.a11yPrefs()).toEqual({
      animations: "system",
      verbosity: "normal",
      singleKeys: true,
      contrast: "system",
      solidPanels: false,
    });
    expect(m.getVerbosity()).toBe("normal");
    expect(m.singleKeysOn()).toBe(true);
    expect(m.motionOn()).toBe(true);
  });

  it("turn animations off when the OS reduces motion", async () => {
    boot({}, new FakeQuery(true));
    const m = await load();
    expect(m.systemReducesMotion()).toBe(true);
    expect(m.motionOn()).toBe(false);
  });

  it("survive a webview without matchMedia", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const m = await load();
    expect(m.systemReducesMotion()).toBe(false);
    expect(m.motionOn()).toBe(true);
  });
});

describe("stored values", () => {
  it("read the on and off the previous build wrote, over the OS", async () => {
    boot({ "fundacad.animations": "on" }, new FakeQuery(true));
    let m = await load();
    expect(m.a11yPrefs().animations).toBe("on");
    expect(m.motionOn()).toBe(true);
    boot({ "fundacad.animations": "off" });
    m = await load();
    expect(m.motionOn()).toBe(false);
  });

  it("fall back to the default for a value they do not know", async () => {
    boot({ "fundacad.animations": "sideways", "fundacad.a11y.verbosity": "shout", "fundacad.a11y.singleKeys": "no" });
    const m = await load();
    expect(m.a11yPrefs()).toEqual(m.DEFAULT_A11Y);
  });

  it("are written on a change, refuse a bad value and tell listeners once", async () => {
    const m = await load();
    let calls = 0;
    m.onA11yPrefsChange(() => calls++);
    m.setA11yPref("verbosity", "errors");
    m.setA11yPref("verbosity", "errors");
    m.setA11yPref("verbosity", "loud" as never);
    expect(calls).toBe(1);
    expect(m.getVerbosity()).toBe("errors");
    expect(stored.get("fundacad.a11y.verbosity")).toBe("errors");
  });

  it("store Single key shortcuts as on or off and read it back", async () => {
    let m = await load();
    m.setA11yPref("singleKeys", false);
    expect(m.singleKeysOn()).toBe(false);
    expect(stored.get("fundacad.a11y.singleKeys")).toBe("off");
    m.setA11yPref("singleKeys", "maybe" as never);
    expect(m.singleKeysOn()).toBe(false);
    boot({ "fundacad.a11y.singleKeys": "off" });
    m = await load();
    expect(m.a11yPrefs().singleKeys).toBe(false);
    m.setA11yPref("singleKeys", true);
    expect(stored.get("fundacad.a11y.singleKeys")).toBe("on");
  });

  it("read Solid panels as true or false and refuse anything else", async () => {
    boot({ "fundacad.a11y.solidPanels": "true" });
    let m = await load();
    expect(m.a11yPrefs().solidPanels).toBe(true);
    boot({ "fundacad.a11y.solidPanels": "yes" });
    m = await load();
    expect(m.a11yPrefs().solidPanels).toBe(false);
    m.setA11yPref("solidPanels", true);
    expect(stored.get("fundacad.a11y.solidPanels")).toBe("true");
    m.setA11yPref("solidPanels", false);
    expect(stored.get("fundacad.a11y.solidPanels")).toBe("false");
    expect(m.a11yPrefs().solidPanels).toBe(false);
  });

  it("still change for this run when the store refuses the write", async () => {
    const m = await load();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    m.setA11yPref("animations", "off");
    expect(m.motionOn()).toBe(false);
  });

  it("pin animations through setMotion, leaving Follow system", async () => {
    const m = await load();
    m.setMotion(true);
    expect(m.a11yPrefs().animations).toBe("on");
    expect(stored.get("fundacad.animations")).toBe("on");
  });
});

describe("the OS preference while the app runs", () => {
  it("switches animations under Follow system and tells motion listeners", async () => {
    const os = new FakeQuery(false);
    boot({}, os);
    const m = await load();
    let calls = 0;
    m.onMotionChange(() => calls++);
    os.flip(true);
    expect(m.motionOn()).toBe(false);
    os.flip(false);
    expect(m.motionOn()).toBe(true);
    expect(calls).toBe(2);
  });

  it("is ignored once the user picked On or Off", async () => {
    const os = new FakeQuery(false);
    boot({ "fundacad.animations": "on" }, os);
    const m = await load();
    let calls = 0;
    m.onMotionChange(() => calls++);
    os.flip(true);
    expect(m.motionOn()).toBe(true);
    expect(calls).toBe(0);
  });

  it("is heard through addListener on an older WebKit", async () => {
    const os = new OldQuery();
    boot({}, os);
    const m = await load();
    os.flip(true);
    expect(m.motionOn()).toBe(false);
  });
});

describe("reset and the screen reader preset", () => {
  it("reset drops every stored choice, Hover delay included, and follows the OS again", async () => {
    const os = new FakeQuery(true);
    boot(
      {
        "fundacad.animations": "on",
        "fundacad.a11y.verbosity": "off",
        "fundacad.a11y.singleKeys": "off",
        "fundacad.a11y.solidPanels": "true",
      },
      os,
    );
    const m = await load();
    m.setHoverDwellMs(1500);
    m.resetA11yPrefs();
    expect(m.a11yPrefs()).toEqual(m.DEFAULT_A11Y);
    expect(m.singleKeysOn()).toBe(true);
    expect(m.getHoverDwellMs()).toBe(m.DEFAULT_DWELL_MS);
    expect(stored.has("fundacad.animations")).toBe(false);
    expect(stored.has("fundacad.a11y.verbosity")).toBe(false);
    expect(stored.has("fundacad.a11y.singleKeys")).toBe(false);
    expect(stored.has("fundacad.a11y.solidPanels")).toBe(false);
    expect(m.motionOn()).toBe(false);
  });

  it("the preset sets Announcements to Verbose, Single key shortcuts off and Solid panels on, stores them and leaves the rest", async () => {
    boot({ "fundacad.animations": "off" });
    const m = await load();
    let calls = 0;
    m.onA11yPrefsChange(() => calls++);
    m.applyScreenReaderPreset();
    expect(m.a11yPrefs()).toEqual({
      animations: "off",
      verbosity: "verbose",
      singleKeys: false,
      contrast: "system",
      solidPanels: true,
    });
    expect(stored.get("fundacad.a11y.verbosity")).toBe("verbose");
    expect(stored.get("fundacad.a11y.singleKeys")).toBe("off");
    expect(stored.get("fundacad.a11y.solidPanels")).toBe("true");
    expect(calls).toBe(1);
  });
});
