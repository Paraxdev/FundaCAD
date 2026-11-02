// The Geometry list's controller on a real DocumentStore: what it asks the engine, what it keeps, and what the next
// document never sees.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createGeometryBrowser, type GeometryBrowserHost } from "../../src/app/geometryBrowser";
import { DocumentStore } from "../../src/document/store";
import { SessionEnded } from "../../src/document/session";
import type { GeometryBackend } from "../../src/geometry/client";
import { GEOMETRY_PAGE_SIZE, useGeometryBrowserStore } from "../../src/stores/geometryBrowser";
import type { CadDocument, RebuildResult, TopologyFace, TopologyReply } from "../../src/types";
import type { EdgeRef } from "../../src/viewport/edgeLines";

vi.mock("../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));

type Bodies = NonNullable<RebuildResult["bodies"]>;
type BodySpec = Partial<Bodies[number]> & { id: string };

function result(specs: BodySpec[]): RebuildResult {
  let start = 0;
  const bodies = specs.map((s) => {
    const body = { name: s.id.toUpperCase(), faceStart: start, faceCount: 3, ...s };
    start = body.faceStart + body.faceCount;
    return body;
  });
  return {
    mesh: { positions: [113.5, -41.25, 37], indices: [0], faceIds: [0] },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    bodies,
  };
}
const DOC = {
  parameters: {},
  features: [{ id: "f1", type: "box", name: "Base block", length: 40, width: 30, height: 20 }],
} as unknown as CadDocument;

function plane(i: number, area = 24 + i): TopologyFace {
  return { i, surface: "plane", area, normal: [0, 0, 1], size: [40 + i, 6], centroid: [113.5 + i, -41.25, 37] };
}
function topology(body: string, faces = 3, edgeFaces?: number[][]): TopologyReply {
  return {
    body,
    faceCount: faces,
    faces: Array.from({ length: faces }, (_, i) => plane(i)),
    ...(edgeFaces ? { edgeFaces } : {}),
  };
}

interface Ask {
  body: string;
  id: string;
  doc: CadDocument;
  answer(r: TopologyReply | null): void;
  fail(err: unknown): void;
}

function edge(body: string, slot: number, wires: number): EdgeRef {
  return {
    id: `${body}:${slot}`,
    body,
    slot,
    smooth: false,
    points: [
      [10 + slot, -4, 2],
      [10 + slot, 16, 7],
    ],
    draw: { refs: { length: wires } },
  } as unknown as EdgeRef;
}

function rig(
  first: RebuildResult = result([
    { id: "body1", etag: "e1" },
    { id: "body2", etag: "e2" },
  ]),
) {
  const asks: Ask[] = [];
  const cancel = vi.fn(async () => true);
  const state = { result: first };
  const geometry = {
    softCancel: true,
    cancel,
    async rebuild() {
      return { ok: true as const, result: state.result };
    },
    topology(doc: CadDocument, body: string, _o: unknown, onStarted?: (id: string) => void) {
      const id = `req${asks.length + 1}`;
      onStarted?.(id);
      return new Promise<TopologyReply | null>((answer, fail) => asks.push({ body, id, doc, answer, fail }));
    },
    async init() {},
    onStatus: () => () => {},
    onProgress: () => () => {},
  } as unknown as GeometryBackend;
  const store = new DocumentStore(geometry, DOC);

  const selection = { faces: [] as number[], edges: [] as EdgeRef[], bodies: [] as string[] };
  const wires = new Map<string, EdgeRef[]>();
  const viewport = {
    applyPicks: vi.fn(),
    hoverPick: vi.fn(),
    faceTriangles: () => [],
    bodyEdgeRefs: vi.fn((id: string) => wires.get(id) ?? []),
    faceIdToBodyId: (faceId: number) =>
      store.buildState.result?.bodies?.find((b) => faceId >= b.faceStart && faceId < b.faceStart + b.faceCount)?.id ??
      null,
    getSelectedBodies: () => selection.bodies,
    getSelectedFaceIds: () => selection.faces,
    selectedEdgeLines: () => selection.edges,
    selectionBodyIds(): string[] {
      const owners = selection.faces.map((f) => viewport.faceIdToBodyId(f)!);
      return [...new Set([...selection.bodies, ...owners, ...selection.edges.map((x) => x.body!)])];
    },
    policy: "auto" as "auto" | "faces" | "bodies",
    picksSuspended: false,
    modelUnsettled: false,
  };
  const host = {
    store,
    geometry,
    viewport,
    sketch: { active: false },
    toolBusy: vi.fn(() => false),
    toolOwnsScreen: vi.fn(() => false),
    dropBodyGizmo: vi.fn(),
    handleAction: vi.fn(),
  };
  const browser = createGeometryBrowser(host as unknown as GeometryBrowserHost);
  store.onBuild((s) => browser.buildChanged(s));
  const list = useGeometryBrowserStore();
  const build = async (next?: RebuildResult) => {
    if (next) state.result = next;
    await store.rebuildNow();
    await settle();
  };
  return { asks, cancel, state, store, selection, wires, viewport, host, browser, list, build };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const land = async (a: Ask, r: TopologyReply | null) => {
  a.answer(r);
  await settle();
};
const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key);

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("fetching", () => {
  it("asks nothing until the list is wanted, whatever builds land", async () => {
    const r = rig();
    await r.build();
    await r.build(result([{ id: "body1", etag: "e9" }]));
    expect(r.asks).toEqual([]);
    expect(r.viewport.bodyEdgeRefs).not.toHaveBeenCalled();
    expect(r.list.bodyId).toBe("body1");
  });

  it("shows the active body's rows once the reply lands, loading till then", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    expect(r.asks.map((a) => a.body)).toEqual(["body1"]);
    expect(r.list.state).toBe("loading");
    await land(r.asks[0]!, topology("body1"));
    expect(r.list.state).toBe("ready");
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
    expect(r.list.rows[0]!.facts).toMatchObject({ body: "BODY1", number: 1 });
  });

  it("names a face's owner by its step in History", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", faceOwners: ["f1", "nobody", null] }]));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    expect(r.list.rows.map((x) => (x.facts as { owner?: string | null }).owner)).toEqual(["Base block", null, null]);
  });

  it("makes no second request for a body already being asked", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.show(true);
    r.browser.step(1);
    expect(r.asks).toHaveLength(1);
  });

  it("reports the engine's cap", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, { ...topology("body1"), truncated: { faces: 1234 } });
    expect(r.list.truncated).toBe(1234);
    r.browser.setBody("body2");
    expect(r.list.truncated).toBeNull();
    await land(r.asks[1]!, topology("body2"));
    expect(r.list.truncated).toBeNull();
  });
});

describe("the cache", () => {
  it("keeps two bodies apart, each answered from its own reply", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));
    r.browser.setBody("body2");
    expect(r.list.rows).toEqual([]);
    await land(r.asks[1]!, topology("body2", 2));
    expect(keys(r.list.rows)).toEqual(["f:body2:0", "f:body2:1"]);

    r.browser.setBody("body1");
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
    r.browser.setBody("body2");
    expect(keys(r.list.rows)).toEqual(["f:body2:0", "f:body2:1"]);
    expect(r.asks).toHaveLength(2);
    expect(r.list.state).toBe("ready");
  });

  it("asks again when the etag changes, and undoing back finds the old reply", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));
    await r.build(
      result([
        { id: "body1", etag: "e1b" },
        { id: "body2", etag: "e2" },
      ]),
    );
    expect(r.asks).toHaveLength(2);
    await land(r.asks[1]!, topology("body1", 1));
    expect(keys(r.list.rows)).toEqual(["f:body1:0"]);
    await r.build(
      result([
        { id: "body1", etag: "e1" },
        { id: "body2", etag: "e2" },
      ]),
    );
    expect(r.asks).toHaveLength(2);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
  });

  it("does not ask again when only faceStart moves, and picks at the new number", async () => {
    const r = rig(result([{ id: "body2", etag: "e2" }]));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body2"));
    const row = r.list.rows[1]!;
    await r.build(
      result([
        { id: "other", etag: "x", faceCount: 7 },
        { id: "body2", etag: "e2" },
      ]),
    );
    expect(r.asks).toHaveLength(1);
    expect(r.list.bodyId).toBe("body2");
    expect(r.list.rows[1]!.key).toBe(row.key);
    expect(r.browser.pickRows([r.list.rows[1]!], { additive: false })).toBeNull();
    expect(r.viewport.applyPicks).toHaveBeenLastCalledWith([{ kind: "face", faceId: 8 }], { additive: false });
  });

  it("takes a new body name and owner from the build without asking again", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", name: "Old" }]));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    await r.build(result([{ id: "body1", etag: "e1", name: "Renamed" }]));
    expect(r.asks).toHaveLength(1);
    expect(r.list.rows[0]!.facts).toMatchObject({ body: "Renamed" });
  });

  it("holds at most four replies, dropping the one used longest ago", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const r = rig(result(ids.map((id) => ({ id, etag: `t${id}` }))));
    await r.build();
    r.browser.show(true);
    for (const id of ids.slice(0, 4)) {
      r.browser.setBody(id);
      await land(r.asks.at(-1)!, topology(id));
    }
    expect(r.asks.filter((a) => a.body === "a")).toHaveLength(1);
    // Touching a keeps it, so b is the oldest when e arrives.
    r.browser.setBody("a");
    r.browser.setBody("e");
    await land(r.asks.at(-1)!, topology("e"));
    const before = r.asks.length;

    for (const id of ["a", "c", "d", "e"]) r.browser.setBody(id);
    expect(r.asks).toHaveLength(before);
    r.browser.setBody("b");
    expect(r.asks).toHaveLength(before + 1);
    expect(r.asks.at(-1)!.body).toBe("b");
  });

  it("keeps exactly four: the fourth reply does not push out the first", async () => {
    const ids = ["a", "b", "c", "d"];
    const r = rig(result(ids.map((id) => ({ id, etag: `t${id}` }))));
    await r.build();
    r.browser.show(true);
    for (const id of ids) {
      r.browser.setBody(id);
      await land(r.asks.at(-1)!, topology(id));
    }
    const before = r.asks.length;
    for (const id of ids) r.browser.setBody(id);
    expect(r.asks).toHaveLength(before);
  });

  it("does not reuse a reply for a body with no etag across builds", async () => {
    const r = rig(result([{ id: "body1" }]));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));
    r.browser.show(true);
    expect(r.asks).toHaveLength(1);
    await r.build(result([{ id: "body1" }]));
    expect(r.asks).toHaveLength(2);
  });
});

describe("previews and streams", () => {
  it("does not ask for a preview build, the rows stay, the settled build catches up", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));

    r.state.result = result([
      { id: "body1", etag: "preview" },
      { id: "body2", etag: "e2" },
    ]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    expect(r.store.buildState.previewBuilt).toBeTruthy();
    expect(r.asks).toHaveLength(1);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
    r.browser.show(true);
    r.browser.step(1);
    expect(r.asks).toHaveLength(1);

    // A commit drops the preview and adds the feature in one go.
    r.state.result = result([
      { id: "body1", etag: "committed" },
      { id: "body2", etag: "e2" },
    ]);
    r.store.setPreview(null);
    r.store.addFeature({ id: "c1", type: "box", length: 2, width: 2, height: 2 } as never);
    await r.store.rebuildNow();
    await settle();
    expect(r.asks).toHaveLength(2);
    expect(r.asks[1]!.doc.features.map((f) => f.id)).toEqual(["f1", "c1"]);
  });

  it("does not ask while a build is running", async () => {
    const r = rig();
    await r.build();
    let finish!: (v: unknown) => void;
    (r.store as unknown as { geometry: { rebuild(): unknown } }).geometry.rebuild = () =>
      new Promise((res) => {
        finish = res;
      });
    const building = r.store.rebuildNow();
    await settle();
    expect(r.store.buildState.building).toBe(true);
    r.browser.show(true);
    r.browser.step(1);
    expect(r.asks).toEqual([]);
    finish({ ok: true, result: result([{ id: "body1", etag: "e5" }]) });
    await building;
    await settle();
    expect(r.asks.map((a) => a.body)).toEqual(["body1"]);
  });

  it("leaves the selection's keys alone during a preview", async () => {
    const r = rig();
    await r.build();
    r.selection.faces = [1];
    r.browser.selectionChanged();
    expect(r.list.selected).toEqual(["f:body1:1"]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    r.selection.faces = [2];
    r.browser.selectionChanged();
    expect(r.list.selected).toEqual(["f:body1:1"]);
  });
});

describe("leaving a preview", () => {
  it("finds the model it left in the cache, with no request", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));
    r.state.result = result([{ id: "body1", etag: "preview" }]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    r.store.setPreview(null);
    await settle();
    expect(r.store.buildState.previewBuilt).toBeFalsy();
    expect(r.asks).toHaveLength(1);
    expect(r.list.state).toBe("ready");
    expect(r.list.bodies.map((b) => b.id)).toEqual(["body1", "body2"]);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
  });
});

describe("stale replies and cancel", () => {
  it("drops an old body's late reply, however it lands", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    expect(r.cancel).toHaveBeenCalledExactlyOnceWith("req1", { soft: true });
    await land(r.asks[1]!, topology("body2", 2));
    await land(r.asks[0]!, topology("body1", 3));
    expect(keys(r.list.rows)).toEqual(["f:body2:0", "f:body2:1"]);
    expect(r.list.state).toBe("ready");
  });

  it("does not turn the cancelled ask's null into an error", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    await land(r.asks[0]!, null);
    expect(r.list.state).toBe("loading");
    expect(r.list.error).toBeNull();
  });

  it("does not cache a superseded reply", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    await land(r.asks[0]!, topology("body1"));
    r.browser.setBody("body1");
    expect(r.asks.map((a) => a.body)).toEqual(["body1", "body2", "body1"]);
  });

  it("drops a reply whose body's etag moved on under a preview, and asks again once it ends", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.state.result = result([
      { id: "body1", etag: "preview" },
      { id: "body2", etag: "e2" },
    ]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    expect(r.asks).toHaveLength(1);
    await land(r.asks[0]!, topology("body1", 3));
    expect(r.list.rows).toEqual([]);
    expect(r.asks).toHaveLength(1);

    r.store.setPreview(null);
    await settle();
    expect(r.asks).toHaveLength(2);
    await land(r.asks[1]!, topology("body1", 2));
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1"]);
  });

  it("drops a reply whose etag moved on with the tab closed, and asks nothing more", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.show(false);
    await r.build(
      result([
        { id: "body1", etag: "newer" },
        { id: "body2", etag: "e2" },
      ]),
    );
    await land(r.asks[0]!, topology("body1", 3));
    expect(r.list.rows).toEqual([]);
    expect(r.asks).toHaveLength(1);
    r.browser.show(true);
    expect(r.asks).toHaveLength(2);
  });

  it("drops an ask when the selection moves the body with the tab closed", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.show(false);
    r.selection.faces = [4];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    expect(r.cancel).toHaveBeenCalledExactlyOnceWith("req1", { soft: true });
    await land(r.asks[0]!, topology("body1", 3));
    expect(r.list.rows).toEqual([]);
    expect(r.list.state).toBe("idle");
    expect(r.asks).toHaveLength(1);
  });

  it("cancels an ask superseded before the engine gave it an id", async () => {
    const r = rig();
    const started: ((id: string) => void)[] = [];
    const g = r.host.geometry as unknown as {
      topology(d: unknown, b: string, o: unknown, s: (id: string) => void): unknown;
    };
    g.topology = (_d, _b, _o, onStarted) => {
      started.push(onStarted);
      return new Promise(() => {});
    };
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    expect(r.cancel).not.toHaveBeenCalled();
    await settle();
    started[0]!("early");
    expect(r.cancel).toHaveBeenCalledExactlyOnceWith("early", { soft: true });
    started[1]!("current");
    expect(r.cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows a cancel that fails", async () => {
    const r = rig();
    r.cancel.mockRejectedValueOnce(new Error("session over"));
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    await settle();
    expect(r.list.state).toBe("loading");
  });

  it("keeps a reply whose etag has not moved although the result is a new object", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.show(false);
    await r.build(
      result([
        { id: "body1", etag: "e1" },
        { id: "body2", etag: "e2" },
      ]),
    );
    await land(r.asks[0]!, topology("body1", 3));
    expect(r.asks).toHaveLength(1);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
  });

  it("leaves a superseded op to finish when the engine has no soft cancel", async () => {
    const r = rig();
    (r.host.geometry as { softCancel: boolean }).softCancel = false;
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    expect(r.cancel).not.toHaveBeenCalled();
    await land(r.asks[1]!, topology("body2", 2));
    await land(r.asks[0]!, topology("body1", 3));
    expect(keys(r.list.rows)).toEqual(["f:body2:0", "f:body2:1"]);
  });

  it("cancels a running ask when a cached body answers at once", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.browser.setBody("body2");
    r.browser.setBody("body1");
    expect(r.cancel).toHaveBeenCalledExactlyOnceWith("req2", { soft: true });
    expect(r.list.state).toBe("ready");
  });
});

describe("a failed fetch", () => {
  it("sets the error, drops the face rows, does not ask again by itself, and retry works", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, null);
    expect(r.list.state).toBe("error");
    expect(r.list.error).toMatch(/faces/);
    expect(r.list.rows).toEqual([]);

    r.browser.show(true);
    r.browser.step(1);
    expect(r.asks).toHaveLength(1);

    r.browser.retry();
    expect(r.asks).toHaveLength(2);
    expect(r.list.state).toBe("loading");
    expect(r.list.error).toBeNull();
    await land(r.asks[1]!, topology("body1"));
    expect(r.list.state).toBe("ready");
    expect(r.list.rows).toHaveLength(3);
  });

  it("asks again on coming back to a body that failed, from a body that asked or a cached one", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, null);
    r.browser.setBody("body2");
    await land(r.asks[1]!, topology("body2"));
    expect(r.list.state).toBe("ready");
    r.browser.setBody("body1");
    expect(r.asks.map((a) => a.body)).toEqual(["body1", "body2", "body1"]);
    await land(r.asks[2]!, null);
    r.browser.setBody("body2");
    expect(r.list.state).toBe("ready");
    r.browser.setBody("body1");
    expect(r.asks).toHaveLength(4);
    expect(r.list.state).toBe("loading");
  });

  it("treats a rejection as a failure too", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.asks[0]!.fail(new Error("gone"));
    await settle();
    expect(r.list.state).toBe("error");
  });

  it("tries again on a new build", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, null);
    await r.build(result([{ id: "body1", etag: "e1c" }]));
    expect(r.asks).toHaveLength(2);
  });

  it("keeps edge rows through a failure, without the facts the op gives", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", faceOwners: ["f1", "f1", "f1"] }]));
    r.wires.set("body1", [edge("body1", 0, 2), edge("body1", 1, 2)]);
    await r.build();
    r.browser.setKind("edges");
    r.browser.show(true);
    expect(keys(r.list.rows)).toEqual(["e:body1:0", "e:body1:1"]);
    await land(r.asks[0]!, null);
    expect(r.list.state).toBe("error");
    expect(keys(r.list.rows)).toEqual(["e:body1:0", "e:body1:1"]);
    expect("faces" in r.list.rows[0]!.facts).toBe(false);
  });
});

describe("edges", () => {
  it("fills in neighbours once the reply lands, and only then", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", faceOwners: ["f1", "f1", "f1"] }]));
    r.wires.set("body1", [edge("body1", 0, 2), edge("body1", 1, 2)]);
    await r.build();
    r.browser.setKind("edges");
    r.browser.show(true);
    expect(r.list.rows.map((x) => (x.facts as { faces?: number[] }).faces)).toEqual([undefined, undefined]);
    await land(r.asks[0]!, topology("body1", 3, [[0, 1], [2]]));
    expect(r.list.rows.map((x) => (x.facts as { faces?: number[] }).faces)).toEqual([[1, 2], [3]]);
  });

  it("uses the same reply for both kinds", async () => {
    const r = rig();
    r.wires.set("body1", [edge("body1", 0, 1)]);
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3, [[0, 1]]));
    r.browser.setKind("edges");
    expect(keys(r.list.rows)).toEqual(["e:body1:0"]);
    r.browser.setKind("faces");
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
    expect(r.asks).toHaveLength(1);
  });

  it("walks the wires once for repeated steps on an unchanged list", async () => {
    const r = rig();
    r.wires.set("body1", [edge("body1", 0, 2), edge("body1", 1, 2)]);
    await r.build();
    r.browser.setKind("edges");
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3, [[0], [1]]));
    r.viewport.bodyEdgeRefs.mockClear();
    r.browser.step(1);
    r.browser.step(1);
    r.browser.step(1);
    expect(r.viewport.bodyEdgeRefs).not.toHaveBeenCalled();
  });

  it("clears a type and a facing when the kind changes, keeps the size", async () => {
    const r = rig();
    await r.build();
    r.list.setFilters({ type: "flat", facing: "up", minSize: 12 });
    r.browser.setKind("edges");
    expect(r.list.filters).toEqual({ type: null, facing: null, minSize: 12 });
  });
});

describe("the active body", () => {
  const two = () =>
    result([
      { id: "body1", etag: "e1" },
      { id: "body2", etag: "e2" },
    ]);

  it("starts on the first body, and on none in an empty model", async () => {
    const r = rig(result([]));
    await r.build();
    expect(r.list.bodyId).toBeNull();
    expect(r.list.bodies).toEqual([]);
    await r.build(two());
    expect(r.list.bodyId).toBe("body1");
    expect(r.list.bodies).toEqual([
      { id: "body1", name: "BODY1" },
      { id: "body2", name: "BODY2" },
    ]);
  });

  it("follows a face pick on another body", async () => {
    const r = rig(two());
    await r.build();
    r.selection.faces = [4];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    expect(r.list.selected).toEqual(["f:body2:1"]);
  });

  it("follows an edge pick and a body pick", async () => {
    const r = rig(two());
    await r.build();
    r.selection.edges = [edge("body2", 6, 9)];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    expect(r.list.selected).toEqual(["e:body2:6"]);
    r.selection.edges = [];
    r.selection.bodies = ["body1"];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body1");
    expect(r.list.selected).toEqual(["b:body1"]);
  });

  it("stays put when the pick is on the active body among others, and when it clears", async () => {
    const r = rig(two());
    await r.build();
    r.browser.setBody("body2");
    r.selection.faces = [0, 4];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    r.selection.faces = [];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    expect(r.list.selected).toEqual([]);
  });

  it("lets the Body field win until the selection changes, a build does not undo it", async () => {
    const r = rig(two());
    await r.build();
    r.selection.faces = [1];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body1");
    r.browser.setBody("body2");
    expect(r.list.selected).toEqual(["f:body1:1"]);
    await r.build(two());
    expect(r.list.bodyId).toBe("body2");
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    r.selection.faces = [2];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body1");
  });

  it("gives a run's piece its row's key, and one key for the whole run", async () => {
    const r = rig(result([{ id: "body1", etag: "e1", faceCount: 5, faceBands: [[1, 3]] }]));
    await r.build();
    r.selection.faces = [1, 3, 4];
    r.browser.selectionChanged();
    expect(r.list.selected).toEqual(["f:body1:1", "f:body1:4"]);
  });

  it("leaves a hidden body, and never follows a pick onto one", async () => {
    const r = rig(two());
    await r.build();
    r.browser.setBody("body2");
    r.store.setBodyVisibility("body2", false);
    await settle();
    expect(r.list.bodies.map((b) => b.id)).toEqual(["body1"]);
    expect(r.list.bodyId).toBe("body1");
    r.selection.faces = [4];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body1");
    r.store.setBodyVisibility("body2", true);
    await settle();
    expect(r.list.bodies.map((b) => b.id)).toEqual(["body1", "body2"]);
  });

  it("has no body when every body is hidden", async () => {
    const r = rig(result([{ id: "body1", etag: "e1" }]));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.store.setBodyVisibility("body1", false);
    await settle();
    expect(r.list.bodyId).toBeNull();
    expect(r.list.rows).toEqual([]);
    expect(r.list.state).toBe("idle");
  });

  it("moves to a selected body when its own goes, else to the first", async () => {
    const three = result([
      { id: "body1", etag: "e1" },
      { id: "body2", etag: "e2" },
      { id: "body3", etag: "e3" },
    ]);
    const r = rig(three);
    await r.build();
    r.browser.setBody("body1");
    r.selection.bodies = ["body3"];
    await r.build(
      result([
        { id: "body2", etag: "e2" },
        { id: "body3", etag: "e3" },
      ]),
    );
    expect(r.list.bodyId).toBe("body3");
    r.selection.bodies = [];
    await r.build(result([{ id: "body2", etag: "e2" }]));
    expect(r.list.bodyId).toBe("body2");
  });

  it("clears rows and cursor and asks for the new body when its own goes", async () => {
    const r = rig(two());
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1"));
    r.browser.step(1);
    expect(r.list.cursor).toBe("f:body1:0");
    await r.build(result([{ id: "body2", etag: "e2" }]));
    expect(r.list.bodyId).toBe("body2");
    expect(r.list.rows).toEqual([]);
    expect(r.list.cursor).toBeNull();
    expect(r.asks.at(-1)!.body).toBe("body2");
  });
});

describe("the cursor and pages", () => {
  const many = (n: number) => topology("body1", n);
  const body = (faceCount: number) => result([{ id: "body1", etag: "e1", faceCount }]);

  it("does nothing on no rows", async () => {
    const r = rig(result([]));
    await r.build();
    expect(r.browser.step(1)).toBeNull();
    expect(r.list.cursor).toBeNull();
  });

  it("wraps on one row", async () => {
    const r = rig(body(1));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, many(1));
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
    expect(r.browser.step(-1)!.key).toBe("f:body1:0");
  });

  it("starts from either end and wraps both ways on many", async () => {
    const r = rig(body(3));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, many(3));
    expect(r.browser.step(-1)!.key).toBe("f:body1:2");
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
    expect(r.browser.step(-1)!.key).toBe("f:body1:2");
    r.list.setCursor(null);
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
  });

  it("the first step starts the fetch with the tab closed, and later builds keep it live", async () => {
    const r = rig(body(3));
    await r.build();
    expect(r.browser.step(1)).toBeNull();
    expect(r.asks).toHaveLength(1);
    await land(r.asks[0]!, many(3));
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
    await r.build(result([{ id: "body1", etag: "e7" }]));
    expect(r.asks).toHaveLength(2);
  });

  it("steps only through what the filters leave", async () => {
    const r = rig(body(4));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, {
      ...many(4),
      faces: [
        plane(0),
        { i: 1, surface: "cylinder", area: 9, radius: 2 },
        plane(2),
        { i: 3, surface: "sphere", radius: 7 },
      ],
    });
    r.list.setFilters({ type: "flat" });
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
    expect(r.browser.step(1)!.key).toBe("f:body1:2");
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
  });

  it("turns the page to follow the cursor", async () => {
    const r = rig(body(GEOMETRY_PAGE_SIZE + 2));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, many(GEOMETRY_PAGE_SIZE + 2));
    expect(r.list.pageCount).toBe(2);
    expect(r.list.pageRows).toHaveLength(GEOMETRY_PAGE_SIZE);
    r.browser.step(-1);
    expect(r.list.page).toBe(1);
    expect(keys(r.list.pageRows)).toEqual([`f:body1:${GEOMETRY_PAGE_SIZE}`, `f:body1:${GEOMETRY_PAGE_SIZE + 1}`]);
    r.browser.step(1);
    expect(r.list.page).toBe(0);
  });

  it("has one page at exactly a page of rows, two at one more", async () => {
    const r = rig(body(GEOMETRY_PAGE_SIZE));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, many(GEOMETRY_PAGE_SIZE));
    expect(r.list.pageCount).toBe(1);
    r.list.setPage(5);
    expect(r.list.page).toBe(0);
    r.list.setPage(-1);
    expect(r.list.page).toBe(0);
  });

  it("keeps the cursor by key through a build, then by place when its row is gone", async () => {
    const r = rig(body(4));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, many(4));
    r.list.setCursor("f:body1:2");
    await r.build(result([{ id: "body1", etag: "e2", faceCount: 4 }]));
    await land(r.asks[1]!, many(4));
    expect(r.list.cursor).toBe("f:body1:2");
    await r.build(result([{ id: "body1", etag: "e3", faceCount: 2 }]));
    await land(r.asks[2]!, many(2));
    expect(r.list.cursor).toBe("f:body1:1");
    await r.build(result([{ id: "body1", etag: "e4", faceCount: 0 }]));
    await land(r.asks[3]!, many(0));
    expect(r.list.cursor).toBeNull();
  });

  it("goes to the cursor's page when a filter leaves it, and the first page without one", async () => {
    const r = rig(body(GEOMETRY_PAGE_SIZE + 2));
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, many(GEOMETRY_PAGE_SIZE + 2));
    r.list.setPage(1);
    r.list.setFilters({ minSize: 1 });
    expect(r.list.page).toBe(0);
    r.browser.step(-1);
    expect(r.list.page).toBe(1);
    r.list.setFilters({ minSize: 2 });
    expect(r.list.page).toBe(1);
    r.list.setFilters({ minSize: 1000 });
    expect(r.list.page).toBe(0);
    expect(r.list.cursor).toBeNull();
    expect(r.list.pageRows).toEqual([]);
  });
});

describe("pickBlocked", () => {
  it("is null with nothing in the way", async () => {
    expect(rig().browser.pickBlocked()).toBeNull();
  });

  it("names an open sketch", () => {
    const r = rig();
    r.host.sketch.active = true;
    r.host.toolBusy.mockReturnValue(true);
    r.host.toolOwnsScreen.mockReturnValue(true);
    expect(r.browser.pickBlocked()).toMatch(/sketch/i);
  });

  it("names a tool", () => {
    const r = rig();
    r.host.toolBusy.mockReturnValue(true);
    r.host.toolOwnsScreen.mockReturnValue(true);
    expect(r.browser.pickBlocked()).toMatch(/tool/i);
  });

  it("names a model still building", () => {
    const r = rig();
    r.viewport.picksSuspended = true;
    expect(r.browser.pickBlocked()).toMatch(/building/i);
  });

  it("is not stopped by the ambient Move gizmo, though the gizmo suspends picking", () => {
    const r = rig();
    r.host.toolBusy.mockReturnValue(true);
    r.viewport.picksSuspended = true;
    expect(r.browser.pickBlocked()).toBeNull();
  });

  it("still names a building model under the ambient Move gizmo", () => {
    const r = rig();
    r.host.toolBusy.mockReturnValue(true);
    r.viewport.picksSuspended = true;
    r.viewport.modelUnsettled = true;
    expect(r.browser.pickBlocked()).toMatch(/building/i);
  });
});

describe("picking a row", () => {
  async function ready(
    specs: BodySpec[] = [
      { id: "other", etag: "o", faceCount: 7 },
      { id: "body1", etag: "e1" },
    ],
  ) {
    const r = rig(result(specs));
    await r.build();
    r.browser.setBody("body1");
    r.browser.show(true);
    await land(r.asks.at(-1)!, topology("body1", 3, [[0], [1]]));
    return r;
  }

  it("writes a face at its id in the current build, replacing or adding", async () => {
    const r = await ready();
    expect(r.browser.pickRows([r.list.rows[2]!], { additive: true })).toBeNull();
    expect(r.viewport.applyPicks).toHaveBeenCalledExactlyOnceWith([{ kind: "face", faceId: 9 }], { additive: true });
  });

  it("writes an edge by its ref, and several rows as one change", async () => {
    const r = await ready();
    const wires = [edge("body1", 0, 2), edge("body1", 1, 2)];
    r.wires.set("body1", wires);
    r.browser.setKind("edges");
    expect(r.browser.pickRows(r.list.rows, { additive: false })).toBeNull();
    expect(r.viewport.applyPicks).toHaveBeenCalledExactlyOnceWith(
      [
        { kind: "edge", edge: wires[0] },
        { kind: "edge", edge: wires[1] },
      ],
      { additive: false },
    );
  });

  it("clears the Move gizmo first, a body selection's gizmo does not stop the pick", async () => {
    const r = await ready();
    r.host.toolBusy.mockReturnValue(true);
    r.viewport.picksSuspended = true;
    const order: string[] = [];
    r.host.dropBodyGizmo.mockImplementation(() => order.push("drop"));
    r.viewport.applyPicks.mockImplementation(() => order.push("pick"));
    expect(r.browser.pickRows([r.list.rows[0]!], { additive: false })).toBeNull();
    expect(order).toEqual(["drop", "pick"]);
  });

  it("switches a Bodies policy to faces before the pick, and only that policy", async () => {
    const r = await ready();
    r.viewport.policy = "bodies";
    const order: string[] = [];
    r.host.handleAction.mockImplementation((a: string) => order.push(a));
    r.viewport.applyPicks.mockImplementation(() => order.push("pick"));
    r.browser.pickRows([r.list.rows[0]!], { additive: false });
    expect(order).toEqual(["selmode-faces", "pick"]);

    r.host.handleAction.mockClear();
    for (const policy of ["auto", "faces"] as const) {
      r.viewport.policy = policy;
      r.browser.pickRows([r.list.rows[0]!], { additive: false });
    }
    expect(r.host.handleAction).not.toHaveBeenCalled();
  });

  it("refuses in words and writes nothing while something holds the model", async () => {
    const r = await ready();
    r.host.sketch.active = true;
    expect(r.browser.pickRows([r.list.rows[0]!], { additive: false })).toMatch(/sketch/i);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    expect(r.host.dropBodyGizmo).not.toHaveBeenCalled();
  });

  it("refuses an old face row while the build's new rows are on their way, takes the new one", async () => {
    const r = await ready();
    const old = r.list.rows[1]!;
    await r.build(
      result([
        { id: "other", etag: "o", faceCount: 7 },
        { id: "body1", etag: "e1b" },
      ]),
    );
    expect(r.list.state).toBe("loading");
    expect(r.list.rows[1]).toBe(old);
    expect(r.browser.pickRows([old], { additive: false })).toMatch(/\w/);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    await land(r.asks.at(-1)!, topology("body1"));
    expect(r.browser.pickRows([r.list.rows[1]!], { additive: false })).toBeNull();
    expect(r.viewport.applyPicks).toHaveBeenCalledExactlyOnceWith([{ kind: "face", faceId: 8 }], { additive: false });
  });

  it("refuses a row past the body's end or of a gone body", async () => {
    const r = await ready();
    const last = r.list.rows[2]!;
    await r.build(
      result([
        { id: "other", etag: "o", faceCount: 7 },
        { id: "body1", etag: "e1", faceCount: 2 },
      ]),
    );
    expect(r.browser.pickRows([last], { additive: false })).toMatch(/\w/);
    await r.build(result([{ id: "other", etag: "o", faceCount: 7 }]));
    expect(r.browser.pickRows([last], { additive: false })).toMatch(/\w/);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("refuses an edge row whose edge is no longer listed", async () => {
    const r = await ready();
    r.wires.set("body1", [edge("body1", 0, 2), edge("body1", 1, 2)]);
    r.browser.setKind("edges");
    const second = r.list.rows[1]!;
    r.wires.set("body1", [edge("body1", 0, 1)]);
    await r.build(
      result([
        { id: "other", etag: "o", faceCount: 7 },
        { id: "body1", etag: "e1b" },
      ]),
    );
    expect(r.browser.pickRows([second], { additive: false })).toMatch(/\w/);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("refuses an edge row from before a build with the tab closed, the rows being out of date", async () => {
    const r = await ready();
    r.wires.set("body1", [edge("body1", 0, 2), edge("body1", 1, 2)]);
    r.browser.setKind("edges");
    const row = r.list.rows[0]!;
    r.browser.show(false);
    await r.build(
      result([
        { id: "other", etag: "o", faceCount: 7 },
        { id: "body1", etag: "e1b" },
      ]),
    );
    expect(r.browser.pickRows([row], { additive: false })).toMatch(/\w/);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("lights a row and clears the light, but not while a tool runs", async () => {
    const r = await ready();
    r.browser.hover(r.list.rows[1]!);
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith({ kind: "face", faceId: 8 });
    r.browser.hover(null);
    expect(r.viewport.hoverPick).toHaveBeenLastCalledWith(null);
    r.viewport.hoverPick.mockClear();
    r.host.toolOwnsScreen.mockReturnValue(true);
    r.browser.hover(r.list.rows[1]!);
    r.browser.hover(null);
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });
});

describe("a second document", () => {
  const SAME = () =>
    result([
      { id: "body1", etag: "e1" },
      { id: "body2", etag: "e2" },
    ]);
  const B = { parameters: {}, features: [{ id: "g1", type: "box", length: 9, width: 8, height: 7 }] };

  async function firstDocumentInUse() {
    const r = rig(SAME());
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));
    r.selection.faces = [1];
    r.browser.selectionChanged();
    r.browser.step(1);
    r.list.setFilters({ type: "flat", facing: "up", minSize: 5 });
    r.browser.setKind("edges");
    r.list.setFilters({ minSize: 6 });
    expect(r.list.selected).not.toEqual([]);
    return r;
  }
  const clean = (r: Awaited<ReturnType<typeof firstDocumentInUse>>) => {
    expect(r.list.rows).toEqual([]);
    expect(r.list.cursor).toBeNull();
    expect(r.list.page).toBe(0);
    expect(r.list.kind).toBe("faces");
    expect(r.list.filters).toEqual({ type: null, facing: null, minSize: null });
    expect(r.list.selected).toEqual([]);
    expect(r.list.truncated).toBeNull();
    expect(r.list.error).toBeNull();
  };

  for (const how of ["New", "Open"] as const) {
    it(`${how} leaves nothing of the first at once`, async () => {
      const r = await firstDocumentInUse();
      r.selection.faces = [];
      if (how === "New") r.store.newDocument();
      else r.store.load(JSON.stringify(B));
      clean(r);
      expect(r.list.bodies).toEqual([]);
      expect(r.list.bodyId).toBeNull();
      expect(r.list.state).toBe("idle");
    });
  }

  it("asks again for the same body id and etag, the shown tab fetching for the new document", async () => {
    const r = await firstDocumentInUse();
    r.selection.faces = [];
    const before = r.asks.length;
    r.store.load(JSON.stringify(B));
    await r.build(SAME());
    clean(r);
    expect(r.list.bodyId).toBe("body1");
    expect(r.asks).toHaveLength(before + 1);
    const ask = r.asks.at(-1)!;
    expect(ask.body).toBe("body1");
    expect(ask.doc.features.map((f) => f.id)).toEqual(["g1"]);
    expect(r.list.rows).toEqual([]);
    await land(ask, topology("body1", 1));
    expect(keys(r.list.rows)).toEqual(["f:body1:0"]);
  });

  it("drops the first document's late reply, whichever way it ends", async () => {
    const r = rig(SAME());
    await r.build();
    r.browser.show(true);
    const late = r.asks[0]!;
    r.store.load(JSON.stringify(B));
    await r.build(SAME());
    const second = r.asks.at(-1)!;
    expect(second).not.toBe(late);

    await land(late, topology("body1", 9));
    expect(r.list.rows).toEqual([]);
    expect(r.list.state).toBe("loading");

    await land(second, topology("body1", 1));
    expect(keys(r.list.rows)).toEqual(["f:body1:0"]);
    expect(r.browser.step(1)!.key).toBe("f:body1:0");
  });

  it("does not report the end of a document as an error", async () => {
    const r = rig(SAME());
    await r.build();
    r.browser.show(true);
    const late = r.asks[0]!;
    r.store.newDocument();
    late.fail(new SessionEnded());
    await settle();
    expect(r.list.state).not.toBe("error");
    expect(r.list.error).toBeNull();
  });

  it("stays quiet after the second document too, with the tab closed and the first stepped", async () => {
    const r = rig(SAME());
    await r.build();
    r.browser.step(1);
    expect(r.asks).toHaveLength(1);
    r.store.load(JSON.stringify(B));
    await r.build(SAME());
    expect(r.asks).toHaveLength(1);
    expect(r.list.rows).toEqual([]);
  });

  it("a third document starts as clean as the second", async () => {
    const r = await firstDocumentInUse();
    r.selection.faces = [];
    r.store.load(JSON.stringify(B));
    await r.build(SAME());
    r.list.setFilters({ minSize: 3 });
    r.browser.step(1);
    r.store.newDocument();
    clean(r);
    expect(r.list.bodyId).toBeNull();
  });
});
