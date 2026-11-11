// The carry on coordinator on a fake store and viewport: it waits for the build of the step that just finished, finds
// the picked face or edge again on the result and starts Press/Pull or Fillet on it, or drops the carry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCarryOn, type CarryEngine } from "../../src/app/carryOn";
import type { CarryHost, CarryTarget } from "../../src/features/carryOn";
import type { RebuildState } from "../../src/document/store";
import { t } from "../../src/i18n";

const said = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../src/ui/announce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/announce")>()),
  announce: (...args: unknown[]) => void said.push(args),
}));

const FACE: CarryTarget = { kind: "face", point: [12.5, -3.25, 7.75] };
const EDGE: CarryTarget = { kind: "edge", point: [4.5, 9.25, -2] };
const OLD = { bodies: [] } as unknown as NonNullable<RebuildState["result"]>;
const NEW = { bodies: [{ id: "body1" }] } as unknown as NonNullable<RebuildState["result"]>;
const PREVIEW = [{ id: "pv", type: "press-pull" }] as unknown as NonNullable<RebuildState["previewBuilt"]>;

function state(over: Partial<RebuildState> = {}): RebuildState {
  return {
    building: false,
    result: OLD,
    errorFeatureId: null,
    errorMessage: null,
    progress: null,
    phase: null,
    meshed: null,
    meshTotal: null,
    streamed: null,
    streamTotal: null,
    ...over,
  };
}

class FakeStore {
  state = state();
  features = [{ id: "f7" }];
  private listeners = new Set<(s: RebuildState) => void>();
  get document() {
    return { features: this.features };
  }
  onSessionBuild(fn: (s: RebuildState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => void this.listeners.delete(fn);
  }
  emit(over: Partial<RebuildState>) {
    this.state = state(over);
    for (const fn of [...this.listeners]) fn(this.state);
  }
  get watching() {
    return this.listeners.size;
  }
}

function rig(o: { face?: number | null; edge?: object | null } = {}) {
  const store = new FakeStore();
  const canvas = document.createElement("canvas");
  const calls: string[] = [];
  const status: string[] = [];
  const busy = { owns: false, any: false };
  const edge = o.edge === undefined ? { id: "edge-9" } : o.edge;
  const e = {
    store,
    viewport: {
      domElement: canvas,
      faceIdNear: vi.fn(() => (o.face === undefined ? 14 : o.face)),
      edgeLineByMid: vi.fn(() => edge),
      applyPicks: vi.fn((refs: unknown) => void calls.push(`picks ${JSON.stringify(refs)}`)),
    },
    starters: {
      startPressPullOn: vi.fn((id: string | null) => void calls.push(`pressPull ${id}`)),
      startFilletOn: vi.fn((id: string | null) => void calls.push(`fillet ${id}`)),
    },
    tools: { extrude: { carry: null as CarryHost | null }, pressPull: { carry: null as CarryHost | null } },
    toolBusy: () => busy.any || busy.owns,
    toolOwnsScreen: () => busy.owns,
    dropBodyGizmo: vi.fn(() => void calls.push("dropGizmo")),
    setStatus: vi.fn((text: string) => void status.push(text)),
    sketch: { active: false, enter: vi.fn() },
  };
  installCarryOn(e as unknown as CarryEngine);
  return { e, store, canvas, calls, status, busy, host: e.tools.extrude.carry! };
}

// The commit's build: it starts, then lands with the step in the result.
const built = (store: FakeStore, over: Partial<RebuildState> = {}) => {
  store.emit({ building: true });
  store.emit({ result: NEW, ...over });
};

beforeEach(() => {
  vi.useFakeTimers();
  said.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("installCarryOn", () => {
  it("gives both tools the same host", () => {
    const r = rig();
    expect(r.e.tools.pressPull.carry).toBe(r.host);
    expect(r.host).not.toBeNull();
  });
});

describe("after a step was added", () => {
  it("waits for the commit's build, ignoring the replayed model from before it", () => {
    const r = rig();
    r.host.after({ kind: "added", id: "f7" }, FACE);
    expect(r.calls).toEqual([]);
    r.store.emit({ building: true });
    expect(r.calls).toEqual([]);
    r.store.emit({ building: false, result: NEW });
    expect(r.calls).toEqual(['picks [{"kind":"face","faceId":14}]', "pressPull f7"]);
  });

  it("finds the face at the target point and starts Press/Pull resting on the step", () => {
    const r = rig({ face: 31 });
    r.host.after({ kind: "added", id: "f7" }, FACE);
    built(r.store);
    expect(r.e.viewport.faceIdNear).toHaveBeenCalledWith(FACE.point);
    expect(r.calls).toEqual(['picks [{"kind":"face","faceId":31}]', "pressPull f7"]);
    expect(r.e.viewport.applyPicks).toHaveBeenCalledWith([{ kind: "face", faceId: 31 }], { additive: false });
    expect(r.e.starters.startFilletOn).not.toHaveBeenCalled();
  });

  it("finds the edge strictly at its midpoint and starts Fillet resting on the step", () => {
    const r = rig();
    r.host.after({ kind: "added", id: "f7" }, EDGE);
    built(r.store);
    expect(r.e.viewport.edgeLineByMid).toHaveBeenCalledWith(EDGE.point);
    expect(r.calls).toEqual(['picks [{"kind":"edge","edge":{"id":"edge-9"}}]', "fillet f7"]);
    expect(r.e.starters.startPressPullOn).not.toHaveBeenCalled();
  });

  it("acts once, a later build starts nothing more and the build listener is gone", () => {
    const r = rig();
    r.host.after({ kind: "added", id: "f7" }, FACE);
    built(r.store);
    built(r.store);
    expect(r.calls.filter((c) => c.startsWith("pressPull"))).toEqual(["pressPull f7"]);
    expect(r.store.watching).toBe(0);
  });

  it("says the face or the edge is not on the result and starts nothing", () => {
    const face = rig({ face: null });
    face.host.after({ kind: "added", id: "f7" }, FACE);
    built(face.store);
    expect(face.calls).toEqual([]);
    expect(face.status).toHaveLength(1);
    expect(face.status[0]).toContain("face");
    expect(said.at(-1)?.[0]).toBe(face.status[0]);

    const edge = rig({ edge: null });
    edge.host.after({ kind: "added", id: "f7" }, EDGE);
    built(edge.store);
    expect(edge.calls).toEqual([]);
    expect(edge.status[0]).toContain("edge");
  });

  it("drops the carry when the feature errored, and when it is gone from the document", () => {
    const errored = rig();
    errored.host.after({ kind: "added", id: "f7" }, FACE);
    built(errored.store, { errorFeatureId: "f7" });
    expect(errored.calls).toEqual([]);

    const other = rig();
    other.host.after({ kind: "added", id: "f7" }, FACE);
    built(other.store, { errorFeatureId: "f3" });
    expect(other.calls).toHaveLength(2);

    const gone = rig();
    gone.store.features = [{ id: "f2" }];
    gone.host.after({ kind: "added", id: "f7" }, FACE);
    built(gone.store);
    expect(gone.calls).toEqual([]);
  });

  it("drops the carry when another tool holds the screen, and stands down only the ambient body gizmo", () => {
    const tool = rig();
    tool.busy.owns = true;
    tool.host.after({ kind: "added", id: "f7" }, FACE);
    built(tool.store);
    expect(tool.calls).toEqual([]);

    const gizmo = rig();
    gizmo.busy.any = true;
    gizmo.host.after({ kind: "added", id: "f7" }, EDGE);
    built(gizmo.store);
    expect(gizmo.calls).toEqual(["dropGizmo", 'picks [{"kind":"edge","edge":{"id":"edge-9"}}]', "fillet f7"]);
  });
});

describe("after a step that added nothing", () => {
  it("acts at once when no preview is on screen, with nothing to rest on", () => {
    const r = rig();
    r.host.after({ kind: "nothing" }, FACE);
    expect(r.calls).toEqual(['picks [{"kind":"face","faceId":14}]', "pressPull null"]);
    expect(r.store.watching).toBe(0);
  });

  it("says the note a step that added nothing left, and still carries on", () => {
    const quiet = rig();
    quiet.host.after({ kind: "nothing" }, FACE);
    expect(quiet.status).toEqual([]);
    const noted = rig();
    noted.host.after({ kind: "nothing", note: "Depth is 0, nothing made" }, FACE);
    expect(noted.status).toEqual(["Depth is 0, nothing made"]);
    expect(noted.calls).toEqual(['picks [{"kind":"face","faceId":14}]', "pressPull null"]);
  });

  it("waits while the preview is still on screen, then acts once it is gone", () => {
    const r = rig();
    r.store.state = state({ previewBuilt: PREVIEW });
    r.host.after({ kind: "nothing" }, EDGE);
    expect(r.calls).toEqual([]);
    r.store.emit({ building: true, previewBuilt: PREVIEW });
    r.store.emit({ previewBuilt: PREVIEW });
    expect(r.calls).toEqual([]);
    r.store.emit({ result: NEW });
    expect(r.calls).toEqual(['picks [{"kind":"edge","edge":{"id":"edge-9"}}]', "fillet null"]);
  });
});

describe("what drops a carry", () => {
  it("a pointerdown on the canvas drops it, one sent before the arming tick does not", () => {
    const early = rig();
    early.host.after({ kind: "added", id: "f7" }, FACE);
    early.canvas.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(1);
    built(early.store);
    expect(early.calls).toHaveLength(2);

    const late = rig();
    late.host.after({ kind: "added", id: "f7" }, FACE);
    vi.advanceTimersByTime(1);
    late.canvas.dispatchEvent(new Event("pointerdown"));
    built(late.store);
    expect(late.calls).toEqual([]);
    expect(late.store.watching).toBe(0);
  });

  it("a key drops it, a modifier does not", () => {
    const r = rig();
    r.host.after({ kind: "added", id: "f7" }, FACE);
    vi.advanceTimersByTime(1);
    for (const key of ["Shift", "Control", "Alt", "Meta"]) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    expect(r.store.watching).toBe(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" }));
    built(r.store);
    expect(r.calls).toEqual([]);
    expect(r.store.watching).toBe(0);
  });

  it("a carry drops at 10 s and not a moment before, and leaves no listener behind", () => {
    const held = rig();
    held.host.after({ kind: "added", id: "f7" }, FACE);
    vi.advanceTimersByTime(9_999);
    built(held.store);
    expect(held.calls).toHaveLength(2);
    expect(held.status).toEqual([]);

    const over = rig();
    const removed = vi.spyOn(over.canvas, "removeEventListener");
    over.host.after({ kind: "added", id: "f7" }, FACE);
    vi.advanceTimersByTime(10_000);
    expect(over.store.watching).toBe(0);
    expect(removed).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    built(over.store);
    expect(over.calls).toEqual([]);
    expect(over.status).toEqual([t("carry.slow")]);
  });

  it("a second carry replaces the first, and each acts on its own target", () => {
    const r = rig();
    r.host.after({ kind: "added", id: "f7" }, FACE);
    r.host.after({ kind: "added", id: "f8" }, EDGE);
    expect(r.store.watching).toBe(1);
    r.store.features = [{ id: "f7" }, { id: "f8" }];
    built(r.store);
    expect(r.calls).toEqual(['picks [{"kind":"edge","edge":{"id":"edge-9"}}]', "fillet f8"]);

    r.host.after({ kind: "added", id: "f9" }, FACE);
    r.store.features.push({ id: "f9" });
    built(r.store);
    expect(r.calls.slice(2)).toEqual(['picks [{"kind":"face","faceId":14}]', "pressPull f9"]);
  });

  it("a step finished by a press that is still down starts the next tool only once the press ends", () => {
    const r = rig();
    window.dispatchEvent(new Event("pointerdown"));
    r.host.after({ kind: "added", id: "f7" }, FACE);
    built(r.store);
    expect(r.calls).toEqual([]);
    expect(r.store.watching).toBe(0);
    window.dispatchEvent(new Event("pointerup"));
    expect(r.calls).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(r.calls).toEqual(['picks [{"kind":"face","faceId":14}]', "pressPull f7"]);
  });

  it("a press that added nothing lands after a pointercancel, a press already over lands at once", () => {
    const held = rig();
    window.dispatchEvent(new Event("pointerdown"));
    held.host.after({ kind: "nothing" }, EDGE);
    expect(held.calls).toEqual([]);
    window.dispatchEvent(new Event("pointercancel"));
    vi.advanceTimersByTime(0);
    expect(held.calls).toEqual(['picks [{"kind":"edge","edge":{"id":"edge-9"}}]', "fillet null"]);

    const over = rig();
    over.host.after({ kind: "nothing" }, EDGE);
    expect(over.calls).toEqual(['picks [{"kind":"edge","edge":{"id":"edge-9"}}]', "fillet null"]);
  });

  it("a second carry during the press replaces the waiting one", () => {
    const r = rig();
    window.dispatchEvent(new Event("pointerdown"));
    r.host.after({ kind: "nothing" }, EDGE);
    r.host.after({ kind: "added", id: "f7" }, FACE);
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(0);
    expect(r.calls).toEqual([]);
    built(r.store);
    expect(r.calls).toEqual(['picks [{"kind":"face","faceId":14}]', "pressPull f7"]);
  });
});
