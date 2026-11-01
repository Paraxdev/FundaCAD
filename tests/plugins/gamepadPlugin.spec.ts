// What main.ts reads from the webview's pad list, driven frame by frame with a fake list and a fake rig.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activate } from "../../plugins/FundaCAD.Gamepad/main";
import { padState } from "../../plugins/FundaCAD.Gamepad/state";
import { breadcrumbs } from "../../src/diagnostics/breadcrumbs";
import { resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";

const SPACEMOUSE = "3DCONNEXION SpaceMouse Compact";
const XBOX = "Microsoft X-Box 360 pad";

const pad = (id: string, axes: number[], mapping = "standard") =>
  ({ id, mapping, connected: true, axes, buttons: [] }) as unknown as Gamepad;

describe("the Gamepad plugin beside a 3D mouse", () => {
  let frames: FrameRequestCallback[] = [];
  let stop = () => {};
  const rig = {
    panScreen: vi.fn(),
    zoomBy: vi.fn(),
    orbitBy: vi.fn(),
    orbitLocked: () => false,
  };

  const run = async (pads: (Gamepad | null)[]) => {
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });
    stop = await activate({ viewport: { rig }, handleAction: vi.fn() } as unknown as Engine);
  };
  const stepFrame = () => {
    const due = frames;
    frames = [];
    for (const f of due) f(performance.now());
  };
  const connect = (gamepad: Gamepad) => window.dispatchEvent(Object.assign(new Event("gamepadconnected"), { gamepad }));

  beforeEach(() => {
    frames = [];
    vi.clearAllMocks();
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    stop();
    stop = () => {};
    Reflect.deleteProperty(navigator, "getGamepads");
    vi.unstubAllGlobals();
    resetContributions();
  });

  it("does not fly the view from a 3D mouse listed as a standard pad", async () => {
    await run([pad(SPACEMOUSE, [1, 0, 1, 0])]);
    stepFrame();
    expect(padState.name).toBeNull();
    expect(rig.panScreen).not.toHaveBeenCalled();
    expect(rig.orbitBy).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
  });

  it("does not settle for a 3D mouse without the standard mapping either", async () => {
    await run([pad(SPACEMOUSE, [1, 0, 1, 0], "")]);
    stepFrame();
    expect(padState.name).toBeNull();
    expect(rig.panScreen).not.toHaveBeenCalled();
  });

  it("reads a real controller listed after the 3D mouse", async () => {
    await run([pad(SPACEMOUSE, [1, 0, 0, 0]), pad(XBOX, [0, 0, 1, 0])]);
    stepFrame();
    expect(padState.name).toBe(XBOX);
    expect(rig.panScreen).not.toHaveBeenCalled();
    expect(rig.orbitBy).toHaveBeenCalled();
  });

  it("reads a real controller without the standard mapping over a standard 3D mouse", async () => {
    await run([pad(XBOX, [0, 0, 1, 0], ""), pad(SPACEMOUSE, [1, 0, 0, 0])]);
    stepFrame();
    expect(padState.name).toBe(XBOX);
    expect(rig.panScreen).not.toHaveBeenCalled();
  });

  it("logs a connecting 3D mouse as ignored, not as connected", async () => {
    await run([]);
    connect(pad("3Dconnexion SpaceMouse Wireless", [0, 0, 0, 0]));
    const facts = breadcrumbs();
    expect(facts).toContain("[gamepad] ignoring a 3D mouse: 3Dconnexion SpaceMouse Wireless");
    expect(facts.some((f) => f.startsWith("[gamepad] connected: 3Dconnexion"))).toBe(false);
  });

  it("still logs a real controller as connected", async () => {
    await run([]);
    connect(pad(XBOX, [0, 0, 0, 0]));
    expect(breadcrumbs()).toContain(`[gamepad] connected: ${XBOX} (standard)`);
  });

  it("polls again when a real controller arrives after a lone 3D mouse stopped the loop", async () => {
    const pads = [pad(SPACEMOUSE, [1, 0, 1, 0])];
    await run(pads);
    stepFrame();
    expect(frames).toEqual([]);

    pads.push(pad(XBOX, [0, 0, 1, 0]));
    connect(pads[1]!);
    expect(frames).toHaveLength(1);
    stepFrame();
    expect(padState.name).toBe(XBOX);
    expect(rig.panScreen).not.toHaveBeenCalled();
    expect(rig.orbitBy).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
  });

  it("stops when a real controller leaves a 3D mouse behind and polls again when it returns", async () => {
    const xbox = pad(XBOX, [0, 0, 1, 0]);
    const pads = [pad(SPACEMOUSE, [1, 0, 0, 0]), xbox];
    await run(pads);
    stepFrame();
    expect(padState.name).toBe(XBOX);
    expect(frames).toHaveLength(1);

    pads.pop();
    stepFrame();
    expect(padState.name).toBeNull();
    expect(frames).toEqual([]);

    pads.push(xbox);
    connect(xbox);
    stepFrame();
    expect(padState.name).toBe(XBOX);
    expect(frames).toHaveLength(1);
    expect(rig.panScreen).not.toHaveBeenCalled();
  });

  it("stays stopped when the 3D mouse is the one that connects", async () => {
    const mouse = pad(SPACEMOUSE, [1, 0, 1, 0]);
    await run([mouse]);
    stepFrame();
    connect(mouse);
    expect(frames).toEqual([]);
    expect(padState.name).toBeNull();
  });
});
