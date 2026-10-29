// A Move drag let go of but not entered is what the user sees, so every save writes it first, as Enter would.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { DocumentStore } from "../../src/document/store";
import { MoveTool } from "../../src/features/moveTool";
import { bodyMoveTarget } from "../../src/features/moveTarget";
import { DatumPoseTool } from "../../src/features/datumPoseTool";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import type { Engine } from "../../src/app/engine";
import type { Viewport } from "../../src/viewport/viewport";
import { box, stubBackend } from "../document/storeKit";

const host = vi.hoisted(() => ({
  saved: [] as string[],
  recovery: [] as string[],
  pick: "D:/parts/as.funda" as string | null,
  dialogs: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "container_save") host.saved.push(String(args.documentJson));
    if (cmd === "recovery_write") host.recovery.push(String(args.json));
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: async () => {},
  save: async () => {
    host.dialogs++;
    return host.pick;
  },
}));
const said = vi.hoisted(() => [] as string[]);
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string) => {
    said.push(message);
    return null;
  },
  dismissToast: () => {},
}));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));
const win = vi.hoisted(() => ({ asked: [] as string[], pick: "cancel" }));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => {
    win.asked.push(question);
    return win.pick;
  },
}));

const { installKeyboard } = await import("../../src/app/keyboard");
const { buildMenubar } = await import("../../src/app/menubarDef");
const { createActions } = await import("../../src/app/actions");
const { installUnsavedGuard, closeRequestHandler } = await import("../../src/app/unsavedGuard");
const { installTitlebar } = await import("../../src/app/titlebar");
const { useUiStore } = await import("../../src/stores/ui");
const { installAutosave } = await import("../../src/io/recovery");

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

/** Anything not given answers as a no-op, for the many calls made only for looks. */
function lenient<T>(own: Record<string, unknown>): T {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as unknown as T;
}

/** Every tool not given is closed and holds nothing. */
function idleTools(own: Record<string, unknown>): Engine["tools"] {
  const idle = { active: false, pending: false, onHeldChange: () => () => {}, confirmHeld() {} };
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : idle) }) as unknown as Engine["tools"];
}

/** The ray at y runs along +X at z = y over a body 10 across, so a press at 40 takes the Z arrow and a drag to 60
 *  lifts the body 20. */
function fakeViewport(scene: THREE.Scene) {
  const ray = (y: number) => new THREE.Raycaster(new THREE.Vector3(-200, 0, y), new THREE.Vector3(1, 0, 0));
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -500, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    addToScene: (o: THREE.Object3D) => scene.add(o),
    removeFromScene: (o: THREE.Object3D) => scene.remove(o),
    pixelWorldSize: () => 1,
    rayFrom: (_x: number, y: number) => ray(y),
    probe: <T>(_x: number, y: number, test: (rc: THREE.Raycaster) => T) => test(ray(y)) || null,
    projectToScreen: () => ({ x: 0, y: 0 }),
    snapStep: () => 0.5,
    modelDiagonal: () => 100,
    overlayOn: () => true,
    watchOverlays: () => () => {},
    bodiesCentroid: () => new THREE.Vector3(),
    bodiesBox: () => new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5)),
  });
}

function pointer(canvas: HTMLElement, type: string, y: number) {
  canvas.dispatchEvent(new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true, cancelable: true }));
}

const engine = {} as Record<string, unknown>;
const live = lenient<Engine>(engine);
let tool: MoveTool;
let store: DocumentStore;
let canvas: HTMLElement;
let scene: THREE.Scene;

/** A saved document with one body selected, so Move is up over it the way a body selection raises it. */
function selectBody() {
  store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  store.addFeature(box("plate", 10));
  store.markSaved("D:/parts/a.funda");
  scene = new THREE.Scene();
  const vp = fakeViewport(scene);
  canvas = vp.domElement;
  tool = new MoveTool(vp, store);
  tool.start(["body1"], () => {});
  tool.markAmbient();
  flushFrame();
  scene.updateMatrixWorld(true);
  Object.assign(engine, {
    store,
    viewport: vp,
    sketch: { active: false },
    tools: idleTools({ move: tool }),
  });
}

function dragAndLetGo() {
  pointer(canvas, "pointerdown", 40);
  pointer(canvas, "pointermove", 60);
  pointer(canvas, "pointerup", 60);
}

const lastSaved = () => JSON.parse(host.saved[host.saved.length - 1]!) as { features: Record<string, unknown>[] };
const moves = () => lastSaved().features.filter((f) => f.type === "move");
const fileItem = (label: string) =>
  buildMenubar(live)
    .find((m) => m.label === "File")!
    .items.find((i) => i.label === label)!;
const key = (shift = false) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, shiftKey: shift, bubbles: true }));

beforeAll(() => {
  setActivePinia(createPinia());
  installKeyboard(live);
});
beforeEach(() => {
  host.saved = [];
  host.recovery = [];
  said.length = 0;
  host.pick = "D:/parts/as.funda";
  host.dialogs = 0;
  win.asked = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  selectBody();
});
afterEach(() => {
  if (tool.active) tool.cancel();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("a Move drag let go of but not entered", () => {
  it("is held, not yet in the document", () => {
    dragAndLetGo();
    expect(tool.pending).toBe(true);
    expect(store.document.features.map((f) => f.type)).toEqual(["box"]);
  });

  const paths: [string, () => void][] = [
    ["Ctrl+S", () => key()],
    ["Ctrl+Shift+S", () => key(true)],
    ["File, Save", () => fileItem("Save").onClick!()],
    ["File, Save As", () => fileItem("Save As…").onClick!()],
    ["the palette's Save", () => createActions(live)("save")],
    ["the palette's Save As", () => createActions(live)("saveas")],
  ];
  it.each(paths)("is written by %s, and the file holds the moved body", async (_name, save) => {
    dragAndLetGo();
    save();
    await vi.waitFor(() => expect(host.saved).toHaveLength(1));
    expect(moves()).toHaveLength(1);
    expect(moves()[0]).toMatchObject({ bodies: ["body1"], dx: 0, dy: 0, dz: 20 });
    expect(tool.pending).toBe(false);
    expect(store.dirty).toBe(false);
  });

  const cancelled: [string, () => void][] = [
    ["Save As", () => key(true)],
    ["Save on a document with no path", () => (store.markOpenedWithoutPath("a.funda"), key())],
  ];
  it.each(cancelled)("stays held when %s's dialog is cancelled, so Escape still cancels it", async (_name, save) => {
    host.pick = null;
    dragAndLetGo();
    save();
    await vi.waitFor(() => expect(host.dialogs).toBe(1));
    await settle();
    const held = { pending: tool.pending, features: store.document.features.map((f) => f.type), dirty: store.dirty };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect({
      held,
      saved: host.saved.length,
      said: [...said],
      after: tool.pending,
      features: store.document.features.length,
    }).toEqual({
      held: { pending: true, features: ["box"], dirty: false },
      saved: 0,
      said: [],
      after: false,
      features: 1,
    });
  });

  it("is left alone by a save made while the handle is still under the hand", async () => {
    pointer(canvas, "pointerdown", 40);
    pointer(canvas, "pointermove", 60);
    key();
    await settle();
    expect(moves()).toEqual([]);
    pointer(canvas, "pointerup", 60);
    expect(tool.pending).toBe(true);
  });
});

describe("an idle autosave and a held Move drag", () => {
  it("leaves the drag held past the quiet period, so Escape still cancels it and no copy is written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      installAutosave(store);
      dragAndLetGo();
      flushFrame();
      await vi.advanceTimersByTimeAsync(31_000);
      await settle();
      const held = { pending: tool.pending, recovery: host.recovery.length };
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect({ held, features: store.document.features.map((f) => f.type), dirty: store.dirty }).toEqual({
        held: { pending: true, recovery: 0 },
        features: ["box"],
        dirty: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("with nothing held", () => {
  it("Ctrl+S saves the document as it was and leaves the gizmo up", async () => {
    key();
    await settle();
    expect(host.saved).toHaveLength(1);
    expect(lastSaved().features.map((f) => f.type)).toEqual(["box"]);
    expect(tool.active).toBe(true);
  });
});

describe("a held Move drag and closing the window", () => {
  const unsavedMark = () => ({ window: document.title.startsWith("a.funda*"), titlebar: useUiStore().dirty });
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  // The desktop guard reaches the window through a dynamic import, so its title and close are checked in the browser.
  const inBrowser = () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    installUnsavedGuard(live);
    installTitlebar(live);
  };
  const tabCloseStopped = () => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  async function closeWindow(pick: string) {
    win.pick = pick;
    let prevented = false;
    await closeRequestHandler(live)({ preventDefault: () => (prevented = true) });
    return prevented;
  }

  it("marks the title unsaved while held, and Escape after let go cancels the drag and clears the mark", () => {
    inBrowser();
    dragAndLetGo();
    flushFrame();
    expect(unsavedMark()).toEqual({ window: true, titlebar: true });
    escape();
    expect(tool.pending).toBe(false);
    expect(store.document.features.map((f) => f.type)).toEqual(["box"]);
    expect(unsavedMark()).toEqual({ window: false, titlebar: false });
  });

  it("stops a browser tab closing while held", () => {
    inBrowser();
    dragAndLetGo();
    expect(tabCloseStopped()).toBe(true);
  });

  it("asks before the window closes, and Cancel keeps the window and the held drag", async () => {
    dragAndLetGo();
    expect(await closeWindow("cancel")).toBe(true);
    expect(win.asked).toEqual(["Save changes to a.funda before closing?"]);
    expect(tool.pending).toBe(true);
  });

  it("asks before the window closes, and Save writes the moved body", async () => {
    dragAndLetGo();
    expect(await closeWindow("save")).toBe(false);
    expect(moves()[0]).toMatchObject({ bodies: ["body1"], dz: 20 });
    expect(store.dirty).toBe(false);
  });

  it("keeps the window and the held drag when Save's dialog is cancelled on a document with no path", async () => {
    store.markOpenedWithoutPath("a.funda");
    host.pick = null;
    dragAndLetGo();
    const prevented = await closeWindow("save");
    expect({
      prevented,
      dialogs: host.dialogs,
      saved: host.saved.length,
      held: tool.pending,
      dirty: store.dirty,
    }).toEqual({
      prevented: true,
      dialogs: 1,
      saved: 0,
      held: true,
      dirty: false,
    });
  });

  it("keeps the window open after Save when the held drag could not be entered, and says so", async () => {
    // Stands in for a tool whose commit the kernel refused, so the drag stays held.
    const refused = { active: true, pending: true, onHeldChange: () => () => {}, confirmHeld() {} };
    engine.tools = idleTools({ move: tool, pressPull: refused });
    const prevented = await closeWindow("save");
    expect({ prevented, said: [...said], saved: host.saved.length, held: refused.pending }).toEqual({
      prevented: true,
      said: ["The held drag could not be entered, so the save left it out"],
      saved: 1,
      held: true,
    });
  });

  it("on an open sketch's gizmo is not unsaved work, so the title stays clean, close does not ask, Save leaves it", async () => {
    const intoSketch: unknown[] = [];
    // Stands in for sketchEntityTarget, whose commit writes into the open sketch and not the store.
    tool.startTarget(
      {
        ...bodyMoveTarget(engine.viewport as Viewport, store, ["body1"]),
        inSketch: true,
        commit: (r) => (intoSketch.push(r), { id: null, rebuild: false }),
        reopen: () => null,
      },
      () => {},
    );
    flushFrame();
    scene.updateMatrixWorld(true);
    dragAndLetGo();
    flushFrame();
    const prevented = await closeWindow("cancel");
    key();
    await vi.waitFor(() => expect(host.saved).toHaveLength(1));
    inBrowser();
    flushFrame();
    expect({
      prevented,
      asked: win.asked,
      saved: lastSaved().features.map((f) => f.type),
      intoSketch: intoSketch.length,
      held: tool.pending,
      mark: unsavedMark(),
      said: [...said],
    }).toEqual({
      prevented: false,
      asked: [],
      saved: ["box"],
      intoSketch: 0,
      held: true,
      mark: { window: false, titlebar: false },
      said: [],
    });
  });

  it("with nothing held closes without asking and leaves the title clean", async () => {
    expect(await closeWindow("cancel")).toBe(false);
    expect(win.asked).toEqual([]);
    inBrowser();
    flushFrame();
    expect(tabCloseStopped()).toBe(false);
    expect(unsavedMark()).toEqual({ window: false, titlebar: false });
  });
});

describe("a new Offset Plane let go of but not entered", () => {
  /** Offset Plane from a selected face, through the real starter, so its follow-up is the real sketch.enter. */
  function offsetPlaneHeld() {
    tool.cancel();
    const vp = fakeViewport(new THREE.Scene());
    const datum = new DatumPoseTool(vp);
    Object.assign(datum, { hit: () => "offset" });
    const entered: string[] = [];
    const deps = {
      store,
      toolBusy: () => false,
      datumPose: datum,
      sketch: { enter: (_def: unknown, _store: unknown, _tool: unknown, id: string) => entered.push(id) },
      viewport: {
        selectedFaceSketchPlane: () => ({ plane: "XY", anchor: { selector: { kind: "face", index: 3 } } }),
        clearSelection() {},
      },
    } as unknown as FeatureStartersDeps;
    createFeatureStarters(deps).offsetPlane();
    engine.tools = idleTools({ move: tool, datumPose: datum });
    flushFrame();
    pointer(vp.domElement, "pointerdown", 40);
    pointer(vp.domElement, "pointermove", 50);
    pointer(vp.domElement, "pointermove", 60);
    pointer(vp.domElement, "pointerup", 60);
    return { datum, entered };
  }
  const planes = (features: { type?: unknown }[]) => features.filter((f) => f.type === "datumPlane");

  it("is in the file Ctrl+S writes, added without entering a sketch on it", async () => {
    const { datum, entered } = offsetPlaneHeld();
    expect(datum.pending).toBe(true);
    key();
    await vi.waitFor(() => expect(host.saved).toHaveLength(1));
    expect({
      file: planes(lastSaved().features),
      entered,
      open: datum.active,
      dirty: store.dirty,
    }).toEqual({
      file: [expect.objectContaining({ plane: "XY", offset: 20, face: { kind: "face", index: 3 } })],
      entered: [],
      open: false,
      dirty: false,
    });
  });

  it("is added by Enter, which still opens a sketch on the new plane", () => {
    const { entered } = offsetPlaneHeld();
    const box = [...document.querySelectorAll<HTMLElement>(".dim-input")].find((b) => b.style.display !== "none")!;
    box.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const added = planes(store.document.features).map((f) => (f as { id: string }).id);
    expect({ added: added.length, entered }).toEqual({ added: 1, entered: added });
  });
});
