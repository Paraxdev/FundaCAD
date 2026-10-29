// A Move drag let go of but not entered is what the user sees, so every save writes it first, as Enter would.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { DocumentStore } from "../../src/document/store";
import { MoveTool } from "../../src/features/moveTool";
import { DatumPoseTool } from "../../src/features/datumPoseTool";
import { ZERO_POSE } from "../../src/document/datumPose";
import type { Feature } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import type { Viewport } from "../../src/viewport/viewport";
import { box, stubBackend } from "../document/storeKit";

const host = vi.hoisted(() => ({ saved: [] as string[], pick: "D:/parts/as.funda" as string | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "container_save") host.saved.push(String(args.documentJson));
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async () => {}, save: async () => host.pick }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));
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
  const idle = { active: false, pending: false, dragging: false, onHeldChange: () => () => {}, confirmHeld() {} };
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

/** A saved document with one body selected, so Move is up over it the way a body selection raises it. */
function selectBody() {
  store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  store.addFeature(box("plate", 10));
  store.markSaved("D:/parts/a.funda");
  const scene = new THREE.Scene();
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
  host.pick = "D:/parts/as.funda";
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

  it("with nothing held closes without asking and leaves the title clean", async () => {
    expect(await closeWindow("cancel")).toBe(false);
    expect(win.asked).toEqual([]);
    inBrowser();
    flushFrame();
    expect(tabCloseStopped()).toBe(false);
    expect(unsavedMark()).toEqual({ window: false, titlebar: false });
  });
});

describe("a new datum plane let go of but not entered", () => {
  it("is in the file Ctrl+S writes, added the way Enter adds it", async () => {
    const vp = fakeViewport(new THREE.Scene());
    const datum = new DatumPoseTool(vp);
    Object.assign(datum, { hit: () => "offset" });
    // Stands in for placeNewDatum in featureStarters, which adds the plane when the tool hands it the pose.
    datum.start({ src: "XY", pose: { ...ZERO_POSE }, ghost: true }, (pose) => {
      if (pose)
        store.addFeature({ id: store.nextId(), type: "datumPlane", plane: "XY", offset: pose.offset } as Feature);
    });
    engine.tools = idleTools({ move: tool, datumPose: datum });
    flushFrame();
    pointer(vp.domElement, "pointerdown", 40);
    pointer(vp.domElement, "pointermove", 50);
    pointer(vp.domElement, "pointermove", 60);
    pointer(vp.domElement, "pointerup", 60);
    expect(datum.pending).toBe(true);
    key();
    await vi.waitFor(() => expect(host.saved).toHaveLength(1));
    expect(lastSaved().features.filter((f) => f.type === "datumPlane")).toEqual([
      expect.objectContaining({ plane: "XY", offset: 20 }),
    ]);
    expect(datum.active).toBe(false);
    expect(store.dirty).toBe(false);
  });
});
