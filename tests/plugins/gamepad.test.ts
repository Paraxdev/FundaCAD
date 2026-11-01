// The controller's arithmetic: sticks to camera motion, buttons to rising
// edges, stored settings repaired rather than trusted. main.ts is the polling
// and the DOM around this; everything worth getting right is in here.
import { afterEach, describe, expect, it, vi } from "vitest";
import udevRules from "../../packaging/70-spacemouse.rules?raw";
import { MemoryStorage } from "./memoryStorage";
import {
  BINDABLE,
  DEFAULTS,
  isThreeDMouse,
  motionOf,
  parseConfig,
  parseKey,
  pressed,
  stick,
} from "../../plugins/FundaCAD.Gamepad/gamepad";

describe("stick", () => {
  it("ignores travel inside the deadzone", () => {
    expect(stick(0.1, -0.05, 0.15)).toEqual([0, 0]);
  });

  it("starts from zero just past the deadzone rather than jumping", () => {
    const [x] = stick(0.16, 0, 0.15);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(0.01);
  });

  it("reaches full speed at full deflection", () => {
    const [x, y] = stick(1, 0, 0.15);
    expect(x).toBeCloseTo(1);
    expect(y).toBe(0);
  });

  it("keeps a diagonal on its diagonal", () => {
    const [x, y] = stick(0.6, 0.6, 0.15);
    expect(x).toBeCloseTo(y);
  });
});

describe("motionOf", () => {
  const cfg = structuredClone(DEFAULTS);

  it("pans from the left stick and moves no cursor", () => {
    const m = motionOf([1, 0, 0, 0], [0, 0], cfg, false);
    expect(m.panX).toBeCloseTo(cfg.panSens);
    expect(m.cursorX).toBe(0);
  });

  it("moves the cursor instead of panning while the cursor is on", () => {
    const m = motionOf([1, 0, 0, 0], [0, 0], cfg, true);
    expect(m.panX).toBe(0);
    expect(m.cursorX).toBeCloseTo(cfg.cursorSpeed);
  });

  it("keeps rotating from the right stick with the cursor on", () => {
    expect(motionOf([0, 0, 1, 0], [0, 0], cfg, true).orbitAz).not.toBe(0);
  });

  it("zooms in on the right trigger and out on the left", () => {
    expect(motionOf([0, 0, 0, 0], [0, 1], cfg, false).zoom).toBeGreaterThan(0);
    expect(motionOf([0, 0, 0, 0], [1, 0], cfg, false).zoom).toBeLessThan(0);
    expect(motionOf([0, 0, 0, 0], [1, 1], cfg, false).zoom).toBe(0);
  });

  it("flips rotation when inverted", () => {
    const a = motionOf([0, 0, 1, 1], [0, 0], cfg, false);
    const b = motionOf([0, 0, 1, 1], [0, 0], { ...cfg, invertOrbitX: true, invertOrbitY: true }, false);
    expect(b.orbitAz).toBeCloseTo(-a.orbitAz);
    expect(b.orbitPol).toBeCloseTo(-a.orbitPol);
  });

  it("is still at rest with a pad at rest", () => {
    const m = motionOf([0.02, -0.03, 0.01, 0], [0.05, 0], cfg, false);
    expect(Object.values(m).every((v) => v === 0)).toBe(true);
  });
});

describe("pressed", () => {
  it("reports only buttons that went down this frame", () => {
    expect(pressed([false, true, false], [true, true, false])).toEqual([0]);
    expect(pressed([true], [true])).toEqual([]);
    expect(pressed([], [false, false, true])).toEqual([2]);
  });
});

describe("parseKey", () => {
  it("reads a plain key and a chord", () => {
    expect(parseKey("key:Enter")).toEqual({ key: "Enter", ctrl: false, shift: false });
    expect(parseKey("key:Ctrl+K")).toEqual({ key: "k", ctrl: true, shift: false });
  });

  it("is null for a command id", () => {
    expect(parseKey("undo")).toBeNull();
  });
});

describe("parseConfig", () => {
  it("is the defaults with nothing stored, or garbage stored", () => {
    expect(parseConfig(null)).toEqual(DEFAULTS);
    expect(parseConfig("{not json")).toEqual(DEFAULTS);
    expect(parseConfig("42")).toEqual(DEFAULTS);
  });

  it("keeps a stored binding and every binding it did not name", () => {
    const cfg = parseConfig(JSON.stringify({ buttons: { 2: "fillet" } }));
    expect(cfg.buttons[2]).toBe("fillet");
    for (const i of BINDABLE) if (i !== 2) expect(cfg.buttons[i]).toBe(DEFAULTS.buttons[i]);
  });

  it("clamps a sensitivity it cannot use", () => {
    const cfg = parseConfig(JSON.stringify({ deadzone: 5, panSens: "fast", orbitSens: -1 }));
    expect(cfg.deadzone).toBe(0.9);
    expect(cfg.panSens).toBe(DEFAULTS.panSens);
    expect(cfg.orbitSens).toBe(0);
  });

  it("binds every bindable button by default and never a trigger", () => {
    for (const i of BINDABLE) expect(DEFAULTS.buttons[i]).toBeTruthy();
    expect(BINDABLE).not.toContain(6);
    expect(BINDABLE).not.toContain(7);
  });
});

describe("isThreeDMouse", () => {
  it.each([
    "3DCONNEXION SpaceMouse Compact",
    "3Dconnexion Universal Receiver",
    "SpaceMouse Pro Wireless",
    "SpaceNavigator",
    "Space Navigator for Notebooks",
    "SpacePilot Pro",
    "SpaceExplorer",
    "3Dconnexion SpaceMouse Compact (Vendor: 256f Product: c635)",
    "Unknown device (Vendor: 256f Product: c635)",
    "Unknown device (Vendor: 046d Product: c626)",
    "256f-c635-Unknown device",
    "046d-c626-Unknown device",
    "46d-c626-Unknown device",
    "Unknown (STANDARD GAMEPAD Vendor: 256F Product: C635)",
    "Spaceball 5000",
    "SpaceTraveler",
    "Space Traveller 3D Mouse",
    "Logitech CADman",
    "3Dconnexion CADMan",
    "LOGITECH CAD Man",
    "Logitech NuLOOQ Navigator",
    "nuLOOQ",
    "Space-Mouse Compact",
    "3D-connexion Receiver",
    "Unknown device (Vendor: 0x256f Product: 0xc635)",
    "Unknown device (Vendor: 0x046d Product: 0xc626)",
  ])("knows %s", (id) => {
    expect(isThreeDMouse(id)).toBe(true);
  });

  it.each([
    "Microsoft X-Box 360 pad",
    "Xbox 360 Controller (XInput STANDARD GAMEPAD)",
    "Logitech Gamepad F310",
    "Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)",
    "046d-c21d-Logitech Gamepad F310",
    "Logitech Dual Action (STANDARD GAMEPAD Vendor: 046d Product: c216)",
    "046d-c216-Logitech Dual Action",
    "Logitech Extreme 3D Pro (Vendor: 046d Product: c215)",
    "Valve Software Steam Deck Controller",
    "Logitech Extreme 3D",
    "046d-c215-Logitech Extreme 3D Pro",
    "VKBsim Space Gunfighter",
    "Hyperspace Pilot Joystick",
    "Backspace Mouse Pad",
    "Cadmania Pad",
    "Madcadman Controller",
    "Pad (Vendor: 0x256e Product: 0xc635)",
    "Logitech Cordless RumblePad 2 (Vendor: 0x046d Product: 0xc219)",
  ])("leaves %s alone", (id) => {
    expect(isThreeDMouse(id)).toBe(false);
  });

  it("knows every Logitech product the udev rule grants", () => {
    const products = [...udevRules.matchAll(/idVendor}=="046d", ATTRS{idProduct}=="([0-9a-f]{4})"/g)].map((m) => m[1]);
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) expect(isThreeDMouse(`Unknown (Vendor: 046d Product: ${p})`), p).toBe(true);
  });
});

describe("its settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const start = async (store: MemoryStorage) => {
    vi.stubGlobal("localStorage", store);
    vi.resetModules();
    return import("../../plugins/FundaCAD.Gamepad/gamepad");
  };

  it("adopts the old key once and reads every later change from the app's store", async () => {
    const store = new MemoryStorage();
    store.setItem(
      "fundacad.gamepad.config",
      JSON.stringify({ deadzone: 0.3, invertOrbitY: true, buttons: { 0: "fit" } }),
    );
    const m = await start(store);
    expect(m.getGamepadConfig()).toMatchObject({ deadzone: 0.3, invertOrbitY: true });
    expect(m.getGamepadConfig().buttons[0]).toBe("fit");
    expect(m.getGamepadConfig().buttons[1]).toBe("key:Escape");

    m.settings.set("deadzone", 0.2);
    expect(m.getGamepadConfig().deadzone).toBe(0.2);
    m.setGamepadConfig({ buttons: { 2: "redo" } });
    expect(m.getGamepadConfig().buttons[0]).toBe("fit");
    expect(m.getGamepadConfig().buttons[2]).toBe("redo");

    store.setItem("fundacad.gamepad.config", JSON.stringify({ deadzone: 0.5 }));
    const again = await start(store);
    expect(again.getGamepadConfig().deadzone).toBe(0.2);
    again.resetGamepadConfig();
    expect(again.getGamepadConfig().deadzone).toBe(0.15);
  });
});
