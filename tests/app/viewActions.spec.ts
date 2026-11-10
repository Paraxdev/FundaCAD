// The seven views turn the camera and leave an open sketch open, from a key, the palette or a menu alike, and a camera
// step speaks where the model is seen from once the view has settled.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { createActions } from "../../src/app/actions";
import { NON_REPEATABLE } from "../../src/app/actionTables";
import { CAMERA_SPEECH_DELAY } from "../../src/app/cameraSpeech";
import { allCommands } from "../../src/ui/commands";
import { keyHint, SHORTCUTS } from "../../src/input/shortcuts";
import { setLanguage } from "../../src/i18n";
import { popModal, pushModal } from "../../src/ui/choice";
import { announce } from "../../src/ui/announce";
import { useGeometryBrowserStore } from "../../src/stores/geometryBrowser";
import type { Engine } from "../../src/app/engine";

vi.mock(import("../../src/ui/announce"), async (orig) => ({ ...(await orig()), announce: vi.fn() }));

const VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso"] as const;

function engine() {
  let flying = 0;
  let version = 0;
  const look = new THREE.Vector3(0, 1, 0);
  const e = {
    sketch: { active: true, finish: vi.fn() },
    lastAction: "extrude",
    toolBusy: () => true,
    viewport: {
      setStandardView: vi.fn(),
      stepView: vi.fn(),
      resetCamera: vi.fn(),
      viewDirection: () => look.clone(),
      rig: { isOrtho: () => true, isFlying: () => flying-- > 0, poseVersion: () => version },
    },
  };
  const move = () => version++;
  return { e, act: createActions(e as unknown as Engine), fly: (checks: number) => (flying = checks), move, look };
}

const said = () => vi.mocked(announce).mock.calls.map((c) => [c[0], c[2]]);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("the view actions", () => {
  it("turn the camera and leave an open sketch open, the last command and a lit Geometry row too", () => {
    const { e, act } = engine();
    const setLit = vi.spyOn(useGeometryBrowserStore(), "setLit");
    for (const v of VIEWS) act(v);
    expect(setLit).not.toHaveBeenCalled();
    expect(e.viewport.setStandardView.mock.calls).toEqual(VIEWS.map((v) => [v]));
    expect(e.sketch.finish).not.toHaveBeenCalled();
    expect(e.lastAction).toBe("extrude");
    expect(VIEWS.filter((v) => !NON_REPEATABLE.has(v))).toEqual([]);
  });

  it("work while a tool is at work, but not under a choice that waits for an answer", () => {
    const { e, act } = engine();
    pushModal();
    try {
      act("front");
    } finally {
      popModal();
    }
    act("back");
    expect(e.viewport.setStandardView.mock.calls).toEqual([["back"]]);
  });

  it("are all in the palette with their Ctrl key", () => {
    const rows = allCommands().filter((c) => (VIEWS as readonly string[]).includes(c.id));
    expect(rows.map((c) => [c.id, c.label, c.key])).toEqual([
      ["front", "Front View", "Ctrl+1"],
      ["back", "Back View", "Ctrl+2"],
      ["left", "Left View", "Ctrl+3"],
      ["right", "Right View", "Ctrl+4"],
      ["top", "Top View", "Ctrl+5"],
      ["bottom", "Bottom View", "Ctrl+6"],
      ["iso", "Isometric View", "Ctrl+7"],
    ]);
    expect(keyHint("front")).toBe("Ctrl+1");
  });

  it("are named in the language chosen after start, in the palette and the shortcut table", async () => {
    await setLanguage("de");
    try {
      expect(allCommands().find((c) => c.id === "back")?.label).toBe("Rückansicht");
      expect(SHORTCUTS.find((s) => s.action === "iso")?.label).toBe("Isometrische Ansicht");
    } finally {
      await setLanguage("system");
    }
  });
});

describe("camera speech", () => {
  it("says the view once it has settled, after a flight, and once for a burst of steps", () => {
    const { act, fly, look } = engine();
    fly(2);
    act("front");
    look.set(0, 1, 0);
    vi.advanceTimersByTime(CAMERA_SPEECH_DELAY * 2);
    expect(said()).toEqual([]);
    vi.advanceTimersByTime(CAMERA_SPEECH_DELAY);
    expect(said()).toEqual([["Front view, orthographic", { key: "camera" }]]);

    vi.mocked(announce).mockClear();
    for (let i = 0; i < 4; i++) {
      act("view-step-right");
      vi.advanceTimersByTime(CAMERA_SPEECH_DELAY / 2);
    }
    look.set(-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0);
    vi.advanceTimersByTime(CAMERA_SPEECH_DELAY);
    expect(said()).toEqual([["Front, 30° toward right, orthographic", { key: "camera" }]]);
  });

  it("waits out a turn the rig does not call a flight, as the classic rig's own transition to a view", () => {
    const { act, move, look } = engine();
    act("back");
    look.set(0.7, 0.7, 0);
    for (let i = 0; i < 3; i++) {
      move();
      vi.advanceTimersByTime(CAMERA_SPEECH_DELAY);
    }
    expect(said()).toEqual([]);
    look.set(0, -1, 0);
    move();
    vi.advanceTimersByTime(CAMERA_SPEECH_DELAY);
    expect(said()).toEqual([]);
    vi.advanceTimersByTime(CAMERA_SPEECH_DELAY);
    expect(said()).toEqual([["Back view, orthographic", { key: "camera" }]]);
  });

  it("speaks after Reset camera too", () => {
    const { e, act } = engine();
    act("reset-camera");
    vi.advanceTimersByTime(CAMERA_SPEECH_DELAY);
    expect(e.viewport.resetCamera).toHaveBeenCalledOnce();
    expect(said()).toEqual([["Front view, orthographic", { key: "camera" }]]);
  });
});
