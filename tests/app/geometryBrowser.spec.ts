// The Geometry list's controller on a real DocumentStore: what it asks the engine, what it keeps, and what the next
// document never sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SessionEnded } from "../../src/document/session";
import { SELECTION_SPEECH_DELAY } from "../../src/app/planePick";
import { GEOMETRY_PAGE_SIZE } from "../../src/stores/geometryBrowser";
import { edge, keys, land, plane, result, rig, settle, topology, type BodySpec } from "./geometryBrowserRig";
import { awaitTreePick, resetTreePicks, type TreePick, type TreePickAnswer } from "../../src/ui/treePick";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("../../src/ui/announce", async (actual) => ({
  ...(await actual<typeof import("../../src/ui/announce")>()),
  announce,
}));
vi.mock("../../src/ui/toast", () => ({
  toast: () => {},
  dismissToast: () => {},
  hintToast: () => {},
  dismissToastsSaying: () => {},
}));

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

  it("names bodies as Items does, numbering repeats and taking a rename with no new request", async () => {
    const r = rig(
      result([
        { id: "body1", etag: "e1", name: "Box" },
        { id: "body2", etag: "e2", name: "Box" },
        { id: "body3", etag: "e3", name: "Peg" },
      ]),
    );
    await r.build();
    r.browser.show(true);
    expect(r.list.bodies).toEqual([
      { id: "body1", name: "Box" },
      { id: "body2", name: "Box 2" },
      { id: "body3", name: "Peg" },
    ]);
    r.browser.setBody("body2");
    await land(r.asks[1]!, topology("body2"));
    expect(r.list.rows.map((x) => ("body" in x.facts ? x.facts.body : null))).toEqual(["Box 2", "Box 2", "Box 2"]);

    r.store.setBodyName("body2", "Lid");
    await settle();
    expect(r.list.bodies.map((b) => b.name)).toEqual(["Box", "Lid", "Peg"]);
    expect(r.list.rows.map((x) => ("body" in x.facts ? x.facts.body : null))).toEqual(["Lid", "Lid", "Lid"]);
    expect(r.asks).toHaveLength(2);
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

  it("follows an edit's roll back, holds through its live preview, and leaves it for the finished model", async () => {
    const r = rig();
    r.store.addFeature({ id: "c1", type: "box", length: 2, width: 2, height: 2 } as never);
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, topology("body1", 3));

    r.state.result = result([{ id: "body1", etag: "rolled" }]);
    r.store.beginEditPreview("c1");
    await settle();
    expect(r.store.buildState.previewBuilt).toEqual([]);
    expect(r.asks.map((a) => [a.body, a.doc.features.map((f) => f.id)])).toEqual([
      ["body1", ["f1", "c1"]],
      ["body1", ["f1"]],
    ]);
    await land(r.asks[1]!, topology("body1", 2));
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1"]);
    expect(r.list.bodies.map((b) => b.id)).toEqual(["body1"]);

    r.state.result = result([{ id: "body1", etag: "live" }]);
    r.store.setEditPreview({ id: "c1", type: "box", length: 3, width: 2, height: 2 } as never);
    await settle();
    expect(r.store.buildState.previewBuilt).toHaveLength(1);
    expect(r.asks).toHaveLength(2);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1"]);

    r.state.result = result([
      { id: "body1", etag: "e1" },
      { id: "body2", etag: "e2" },
    ]);
    r.store.endEditPreview();
    await settle();
    expect(r.asks).toHaveLength(2);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
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

  it("tries once more on a build that keeps the body's etag, a build with the same result does not", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.asks[0]!.fail(new Error("engine restarted"));
    await settle();
    expect(r.list.state).toBe("error");
    await r.build();
    expect(r.asks).toHaveLength(1);
    await r.build(
      result([
        { id: "body1", etag: "e1" },
        { id: "body2", etag: "e2b" },
      ]),
    );
    expect(r.asks.map((a) => a.body)).toEqual(["body1", "body1"]);
    expect(r.list.state).toBe("loading");
    await land(r.asks[1]!, topology("body1", 2));
    expect([r.list.state, keys(r.list.rows)]).toEqual(["ready", ["f:body1:0", "f:body1:1"]]);
  });

  it("still shows the error and its reason after a visit to Planes, and asks nothing more", async () => {
    const r = rig();
    await r.build();
    r.browser.show(true);
    await land(r.asks[0]!, null);
    r.browser.setKind("planes");
    expect(r.list.state).toBe("ready");
    r.browser.setKind("faces");
    expect([r.list.state, r.list.error, r.list.rows]).toEqual([
      "error",
      "The engine could not list this body's faces.",
      [],
    ]);
    r.browser.setKind("edges");
    expect(r.list.state).toBe("error");
    expect(r.asks).toHaveLength(1);
    r.browser.retry();
    expect([r.asks.length, r.list.state]).toEqual([2, "loading"]);
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

  it("says when hiding the listed body moves the list to another, and when none is left", async () => {
    const r = rig(
      result([
        { id: "body1", etag: "e1", name: "Box" },
        { id: "body2", etag: "e2", name: "Box" },
      ]),
    );
    await r.build();
    r.browser.show(true);
    r.browser.setBody("body2");
    announce.mockClear();
    r.store.setBodyVisibility("body2", false);
    await settle();
    expect(r.list.bodyId).toBe("body1");
    expect(announce.mock.calls.map((c) => c[0])).toEqual(["Box 2 hidden, the list shows Box"]);
    r.store.setBodyVisibility("body1", false);
    await settle();
    expect(announce.mock.calls.at(-1)?.[0]).toBe("Box hidden, no body left to list");
  });

  it("says nothing of a body change while the list is closed", async () => {
    const r = rig(two());
    await r.build();
    r.browser.setBody("body2");
    announce.mockClear();
    r.store.setBodyVisibility("body2", false);
    await settle();
    expect(r.list.bodyId).toBe("body1");
    expect(announce).not.toHaveBeenCalled();
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

describe("stepBlocked", () => {
  const waitForRow = () =>
    awaitTreePick(
      () => true,
      () => {},
    );
  afterEach(() => resetTreePicks());

  function underTool() {
    const r = rig();
    r.host.toolBusy.mockReturnValue(true);
    r.host.toolOwnsScreen.mockReturnValue(true);
    return r;
  }

  it("is pickBlocked with no pick waiting", () => {
    expect(rig().browser.stepBlocked()).toBeNull();
    const r = underTool();
    expect(r.browser.stepBlocked()).toBe("Finish the tool first");
    expect(r.browser.stepBlocked()).toBe(r.browser.pickBlocked());
  });

  it("is null for a tool that waits for a row, which holds the screen", () => {
    const r = underTool();
    waitForRow();
    expect(r.browser.stepBlocked()).toBeNull();
    expect(r.browser.pickBlocked()).toBe("Finish the tool first");
  });

  it("still names an open sketch under a pick", () => {
    const r = underTool();
    r.host.sketch.active = true;
    waitForRow();
    expect(r.browser.stepBlocked()).toBe("Finish the sketch first");
  });

  it("names a model still building under a pick, but not a suspended pick", () => {
    const r = underTool();
    waitForRow();
    r.viewport.picksSuspended = true;
    expect(r.browser.stepBlocked()).toBeNull();
    r.viewport.modelUnsettled = true;
    expect(r.browser.stepBlocked()).toBe("The model is still building");
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

describe("a tool waiting for a pick", () => {
  async function waiting(answers: TreePickAnswer[] = [true]) {
    const r = rig(
      result([
        { id: "other", etag: "o", faceCount: 7 },
        { id: "body1", etag: "e1" },
      ]),
    );
    const wires = [edge("body1", 0, 3), edge("body1", 1, 3), edge("body1", 2, 3)];
    r.wires.set("body1", wires);
    await r.build();
    r.browser.setBody("body1");
    r.browser.show(true);
    await land(r.asks.at(-1)!, topology("body1", 3, [[0], [1], [2]]));
    r.host.toolOwnsScreen.mockReturnValue(true);
    r.host.toolBusy.mockReturnValue(true);
    const taken: TreePick[] = [];
    const release = awaitTreePick(
      (pick) => {
        taken.push(pick);
        return answers[taken.length - 1] ?? true;
      },
      () => {},
    );
    return { ...r, wires, taken, release };
  }
  afterEach(() => resetTreePicks());

  it("gets a face row as that face, and nothing is selected", async () => {
    const r = await waiting();
    expect(r.browser.pickRows([r.list.rows[1]!], { additive: false })).toBeNull();
    expect(r.taken).toEqual([{ kind: "face", faceId: 8 }]);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
    expect(r.host.setStatus).not.toHaveBeenCalled();
  });

  it("gets a run of edge rows one by one and stops at the first refusal, which is said once", async () => {
    const r = await waiting([true, "That row is an edge, this step needs a face"]);
    r.browser.setKind("edges");
    expect(r.browser.pickRows(r.list.rows, { additive: false })).toBeNull();
    expect(r.taken).toEqual([
      { kind: "edge", edge: r.wires[0] },
      { kind: "edge", edge: r.wires[1] },
    ]);
    expect(r.host.setStatus).toHaveBeenCalledExactlyOnceWith(
      "Straight edge 1 of BODY1 picked. That row is an edge, this step needs a face",
      "",
      { silent: true },
    );
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("speaks a taken face row by its label and the body's shown name, politely under the selection key", async () => {
    const r = await waiting();
    r.store.setBodyName("body1", "Bracket");
    await settle();
    announce.mockClear();
    expect(r.browser.offer([r.list.rows[1]!])).toBeNull();
    expect(r.taken).toEqual([{ kind: "face", faceId: 8 }]);
    expect(announce.mock.calls).toEqual([
      ["Flat face 2 of Bracket picked", "polite", { key: "selection", delay: SELECTION_SPEECH_DELAY }],
    ]);
  });

  it("speaks a run of three rows as a count, and a refused third together with the two taken", async () => {
    const r = await waiting([true, true, "That row is an edge, this step needs a face"]);
    r.browser.setKind("edges");
    announce.mockClear();
    r.browser.offer(r.list.rows);
    expect(r.taken).toHaveLength(3);
    expect(announce.mock.calls.map((c) => c[0])).toEqual([
      "2 rows picked. That row is an edge, this step needs a face",
    ]);
    expect(r.host.setStatus).toHaveBeenCalledExactlyOnceWith(
      "2 rows picked. That row is an edge, this step needs a face",
      "",
      { silent: true },
    );
  });

  it("says nothing but the refusal for a refused first row, and a stale row is refused before any is offered", async () => {
    const r = await waiting(["That row is a face, this step needs an edge"]);
    r.browser.offer([r.list.rows[2]!, r.list.rows[0]!]);
    expect(r.host.setStatus).toHaveBeenCalledExactlyOnceWith("That row is a face, this step needs an edge", "", {
      silent: true,
    });
    expect(r.taken).toHaveLength(1);
    r.host.setStatus.mockClear();
    const old = r.list.rows[0]!;
    await r.build(result([{ id: "body1", etag: "e1c" }]));
    expect(r.browser.offer([r.list.rows[0] ?? old, old])).toMatch(/\w/);
    expect(r.taken).toHaveLength(1);
  });

  it("offers nothing of the first document to a pick waiting in the second", async () => {
    const r = await waiting();
    r.store.setBodyName("body1", "Bracket");
    await settle();
    const first = r.list.rows[1]!;
    r.store.load(
      JSON.stringify({ parameters: {}, features: [{ id: "g1", type: "box", length: 9, width: 8, height: 7 }] }),
    );
    await r.build(result([{ id: "body1", etag: "e1", name: "Lid" }]));
    announce.mockClear();
    expect(r.browser.offer([first])).toMatch(/\w/);
    expect(r.taken).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
    await land(r.asks.at(-1)!, topology("body1", 2));
    expect(r.browser.offer([r.list.rows[1]!])).toBeNull();
    expect(announce.mock.calls.map((c) => c[0])).toEqual(["Flat face 2 of Lid picked"]);
  });

  it("stops offering rows once a pick ends its wait", async () => {
    const r = await waiting();
    r.browser.setKind("edges");
    const rows = r.list.rows.slice(0, 2);
    let n = 0;
    r.release();
    const release = awaitTreePick(
      () => (++n === 1 && release(), true),
      () => {},
    );
    r.browser.pickRows(rows, { additive: false });
    expect(n).toBe(1);
  });

  it("lights a row and puts it out while a pick waits, as the tool's own hover is left alone", async () => {
    const r = await waiting();
    r.browser.hover(r.list.rows[1]!);
    expect(r.viewport.hoverPick.mock.calls).toEqual([[{ kind: "face", faceId: 8 }]]);
    r.browser.hover(r.list.rows[2]!);
    r.browser.hover(null);
    expect(r.viewport.hoverPick.mock.calls).toEqual([
      [{ kind: "face", faceId: 8 }],
      [{ kind: "face", faceId: 9 }],
      [null],
    ]);
    r.viewport.hoverPick.mockClear();
    r.browser.hover(null);
    r.browser.hover(null);
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });

  it("lights an edge row the same way, as that edge", async () => {
    const r = await waiting();
    r.browser.setKind("edges");
    r.browser.hover(r.list.rows[2]!);
    expect(r.viewport.hoverPick.mock.calls).toEqual([[{ kind: "edge", edge: r.wires[2] }]]);
  });

  it("lights nothing while the model builds under a pick, and puts out what was lit", async () => {
    const r = await waiting();
    r.viewport.modelUnsettled = true;
    r.browser.hover(r.list.rows[1]!);
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
    r.viewport.modelUnsettled = false;
    r.browser.hover(r.list.rows[1]!);
    r.viewport.modelUnsettled = true;
    r.browser.hover(r.list.rows[0]!);
    expect(r.viewport.hoverPick.mock.calls).toEqual([[{ kind: "face", faceId: 8 }], [null]]);
  });

  it("lights nothing under a tool that waits for no pick, and under a sketch", async () => {
    const r = await waiting();
    r.release();
    r.browser.hover(r.list.rows[1]!);
    r.browser.hover(null);
    awaitTreePick(
      () => true,
      () => {},
    );
    r.host.sketch.active = true;
    r.browser.hover(r.list.rows[1]!);
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });

  it("puts out a light the pick's taker outlived, a sketch having opened since", async () => {
    const r = await waiting();
    r.browser.hover(r.list.rows[1]!);
    r.release();
    r.host.sketch.active = true;
    r.browser.hover(null);
    expect(r.viewport.hoverPick.mock.calls).toEqual([[{ kind: "face", faceId: 8 }], [null]]);
  });

  it("puts out a light with its document, and leaves the second one's tool hover alone", async () => {
    const r = await waiting();
    r.browser.hover(r.list.rows[1]!);
    r.store.newDocument();
    expect(r.viewport.hoverPick.mock.calls).toEqual([[{ kind: "face", faceId: 8 }], [null]]);
    r.viewport.hoverPick.mockClear();
    r.browser.hover(null);
    r.store.newDocument();
    expect(r.viewport.hoverPick).not.toHaveBeenCalled();
  });

  it("puts out an edge stepped to with no tool running when another document opens", async () => {
    const r = await waiting();
    r.release();
    r.host.toolOwnsScreen.mockReturnValue(false);
    r.host.toolBusy.mockReturnValue(false);
    r.browser.setKind("edges");
    r.browser.hover(r.list.rows[2]!);
    r.store.newDocument();
    expect(r.viewport.hoverPick.mock.calls).toEqual([[{ kind: "edge", edge: r.wires[2] }], [null]]);
  });

  it("a step selects only, so a waiting tool is never fed by Next Face", async () => {
    const r = await waiting();
    expect(r.browser.pickRows([r.list.rows[0]!], { additive: false, stepping: true })).toMatch(/tool/i);
    expect(r.taken).toEqual([]);
    expect(r.viewport.applyPicks).not.toHaveBeenCalled();
  });

  it("keeps an edge row through the tool's own preview build", async () => {
    const r = await waiting();
    r.browser.setKind("edges");
    r.state.result = result([
      { id: "other", etag: "o", faceCount: 7 },
      { id: "body1", etag: "preview" },
    ]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    expect(r.store.buildState.previewBuilt).toBeTruthy();
    expect(r.browser.pickRows([r.list.rows[2]!], { additive: false })).toBeNull();
    expect(r.taken).toEqual([{ kind: "edge", edge: r.wires[2] }]);
  });

  it("says the list fills in once the tool is done on a kind switch during the tool's preview, and lists once it settles", async () => {
    const r = await waiting();
    r.state.result = result([
      { id: "other", etag: "o", faceCount: 7 },
      { id: "body1", etag: "preview" },
    ]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    r.browser.setKind("edges");
    expect({ state: r.list.state, error: r.list.error }).toEqual({
      state: "loading",
      error: "The list fills in once the tool is done",
    });

    r.store.setPreview(null);
    await settle();
    expect({ state: r.list.state, error: r.list.error }).toEqual({ state: "ready", error: null });
    expect(keys(r.list.rows)).toEqual(["e:body1:0", "e:body1:1", "e:body1:2"]);
    r.browser.setKind("faces");
    expect(r.list.error).toBeNull();
  });

  it("says the model is building while the tool's first preview is in flight, then that the list waits on the tool", async () => {
    const r = await waiting();
    const geometry = (r.store as unknown as { geometry: { rebuild(): unknown } }).geometry;
    let finish!: (v: unknown) => void;
    geometry.rebuild = () =>
      new Promise((res) => {
        finish = res;
      });
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    expect(r.store.buildState.building).toBe(true);
    r.browser.setKind("edges");
    expect({ state: r.list.state, error: r.list.error }).toEqual({
      state: "loading",
      error: "The model is still building",
    });

    finish({ ok: true, result: result([{ id: "body1", etag: "preview" }]) });
    await settle();
    expect(r.store.buildState.previewBuilt).toHaveLength(1);
    expect({ state: r.list.state, error: r.list.error }).toEqual({
      state: "loading",
      error: "The list fills in once the tool is done",
    });
  });

  it("refuses a face row in the tool's preview build, its number means the drawn model's face", async () => {
    const r = await waiting();
    r.state.result = result([
      { id: "other", etag: "o", faceCount: 7 },
      { id: "body1", etag: "preview" },
    ]);
    r.store.setPreview({ id: "p1", type: "box", length: 1, width: 1, height: 1 } as never);
    await settle();
    expect(r.browser.pickRows([r.list.rows[0]!], { additive: false })).toMatch(/\w/);
    expect(r.taken).toEqual([]);
  });

  it("refuses a face row from an older build and takes the new row", async () => {
    const r = await waiting();
    const old = r.list.rows[0]!;
    await r.build(
      result([
        { id: "other", etag: "o", faceCount: 7 },
        { id: "body1", etag: "e1b" },
      ]),
    );
    expect(r.browser.pickRows([old], { additive: false })).toMatch(/\w/);
    expect(r.taken).toEqual([]);
    await land(r.asks.at(-1)!, topology("body1", 3, [[0], [1], [2]]));
    expect(r.browser.pickRows([r.list.rows[0]!], { additive: false })).toBeNull();
    expect(r.taken).toEqual([{ kind: "face", faceId: 7 }]);
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

describe("planes", () => {
  const SLANTED = { origin: [113.5, -41.25, 37], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] };
  const LID = { id: "d1", type: "datumPlane", name: "Lid", plane: SLANTED };
  const REAR = { id: "d2", type: "datumPlane", name: "Rear", plane: { ...SLANTED, normal: [0, 1, 0] } };
  const docWith = (...datums: object[]) =>
    JSON.stringify({
      parameters: {},
      features: [{ id: "f1", type: "box", length: 40, width: 30, height: 20 }, ...datums],
    });

  async function planesRig(...datums: object[]) {
    const r = rig();
    r.store.load(docWith(...datums));
    await r.build();
    r.browser.show(true);
    return r;
  }

  it("lists them without asking the engine, ready at once", async () => {
    const r = await planesRig(LID);
    await land(r.asks[0]!, topology("body1", 3));
    const asked = r.asks.length;
    r.browser.setKind("planes");
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d1"]);
    expect(r.list.state).toBe("ready");
    expect(r.asks).toHaveLength(asked);
  });

  it("lists them while the model is building, as they need no build", async () => {
    const r = await planesRig(LID);
    await land(r.asks[0]!, topology("body1", 3));
    const held = r.store.rebuildNow();
    r.browser.setKind("planes");
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d1"]);
    await held;
    await settle();
  });

  it("drops a face reply that lands after the list moved to planes, and asks again on the way back", async () => {
    const r = await planesRig(LID);
    r.browser.setKind("planes");
    expect(r.cancel).toHaveBeenCalledWith("req1", { soft: true });
    await land(r.asks[0]!, { ...topology("body1", 3), truncated: { faces: 9 } });
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d1"]);
    expect(r.list.truncated).toBeNull();
    expect(r.list.state).toBe("ready");
    r.browser.setKind("faces");
    expect(r.asks).toHaveLength(2);
    await land(r.asks[1]!, topology("body1", 2));
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1"]);
  });

  it("drops a failed face request after the move too, so no error shows over the planes", async () => {
    const r = await planesRig();
    r.browser.setKind("planes");
    await land(r.asks[0]!, null);
    expect(r.list.state).toBe("ready");
    expect(r.list.error).toBeNull();
  });

  it("hides the note about faces left out, and the faces bring it back", async () => {
    const r = await planesRig();
    await land(r.asks[0]!, { ...topology("body1", 3), truncated: { faces: 9 } });
    expect(r.list.truncated).toBe(9);
    r.browser.setKind("planes");
    expect(r.list.truncated).toBeNull();
    r.browser.setKind("faces");
    expect(r.list.truncated).toBe(9);
  });

  it("puts out a lit plane when the list leaves Planes, a pointer's row has no leave event then", async () => {
    const r = await planesRig(LID);
    r.browser.setKind("planes");
    r.browser.hover(r.list.rows[3]!);
    expect(r.viewport.hoverDatum).toHaveBeenLastCalledWith("d1");
    r.browser.setKind("edges");
    expect(r.viewport.hoverDatum).toHaveBeenLastCalledWith(null);
    expect(r.viewport.hoverPlane).toHaveBeenLastCalledWith(null);
  });

  it("forgets a size limit and a type on the way in, a plane has neither", async () => {
    const r = await planesRig();
    r.list.setFilters({ minSize: 12.5, type: "flat", facing: "down" });
    r.browser.setKind("planes");
    expect(r.list.filters).toEqual({ type: null, facing: null, minSize: null });
    expect(r.list.filtered).toHaveLength(3);
  });

  it("keeps a size limit going from faces to edges, which both have one", async () => {
    const r = await planesRig();
    r.list.setFilters({ minSize: 12.5, type: "flat", facing: "down" });
    r.browser.setKind("edges");
    expect(r.list.filters).toEqual({ type: null, facing: null, minSize: 12.5 });
  });

  it("follows a rename, a new datum and a suppressed one", async () => {
    const r = await planesRig(LID);
    r.browser.setKind("planes");
    r.store.updateFeature("d1", { name: "Top" } as never);
    expect((r.list.rows[3]!.facts as { name: string }).name).toBe("Top");
    r.store.addFeature(REAR as never);
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d1", "p:d2"]);
    r.store.setSuppressed(["d1"], true);
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d2"]);
    await settle();
  });

  it("does not touch the rows on a document change under the faces, or with the tab closed", async () => {
    const r = await planesRig(LID);
    await land(r.asks[0]!, topology("body1", 3));
    r.store.updateFeature("d1", { name: "Top" } as never);
    expect(keys(r.list.rows)).toEqual(["f:body1:0", "f:body1:1", "f:body1:2"]);
    r.browser.setKind("planes");
    r.browser.show(false);
    r.store.addFeature(REAR as never);
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d1"]);
    await settle();
  });

  it("keeps its rows and cursor when a canvas pick moves the active body", async () => {
    const r = await planesRig(LID);
    r.browser.setKind("planes");
    r.list.setCursor("p:d1");
    r.selection.bodies = ["body2"];
    r.browser.selectionChanged();
    expect(r.list.bodyId).toBe("body2");
    expect(r.list.cursor).toBe("p:d1");
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:d1"]);
    expect(r.list.state).toBe("ready");
  });

  it("offers a Ctrl or Shift click to a pick without starting a sketch", async () => {
    const r = await planesRig(LID);
    r.browser.setKind("planes");
    expect(r.browser.activatePlane(r.list.rows[0]!, false)).toBe(false);
    expect(r.host.sketch.enter).not.toHaveBeenCalled();
    expect(r.browser.activatePlane(r.list.rows[0]!)).toBe(true);
    expect(r.host.sketch.enter).toHaveBeenCalledTimes(1);
  });

  it("forgets the first document's planes, the second starts on faces and lists only its own", async () => {
    const r = await planesRig(LID, REAR);
    r.browser.setKind("planes");
    r.list.setCursor("p:d2");
    r.list.setFilters({ facing: "back" });
    r.store.load(docWith({ ...REAR, id: "g5", name: "Other" }));
    expect(r.list.kind).toBe("faces");
    expect(r.list.rows).toEqual([]);
    expect(r.list.cursor).toBeNull();
    expect(r.list.filters).toEqual({ type: null, facing: null, minSize: null });
    await r.build();
    r.browser.setKind("planes");
    expect(keys(r.list.rows)).toEqual(["p:o:XY", "p:o:XZ", "p:o:YZ", "p:g5"]);
    expect(r.list.cursor).toBeNull();
  });
});

describe("a plane row offered to a waiting pick", () => {
  const LID = {
    id: "d1",
    type: "datumPlane",
    name: "Lid",
    plane: { origin: [113.5, -41.25, 37], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] },
  };
  async function waitingOnPlanes(answers: TreePickAnswer[] = [true]) {
    const r = rig();
    r.store.load(
      JSON.stringify({ parameters: {}, features: [{ id: "f1", type: "box", length: 40, width: 30, height: 20 }, LID] }),
    );
    await r.build();
    r.browser.show(true);
    r.browser.setKind("planes");
    r.host.toolOwnsScreen.mockReturnValue(true);
    const taken: TreePick[] = [];
    awaitTreePick(
      (pick) => {
        taken.push(pick);
        return answers[taken.length - 1] ?? true;
      },
      () => {},
    );
    announce.mockClear();
    return { ...r, taken };
  }
  afterEach(() => resetTreePicks());

  it("gives an origin plane and a datum plane to the tool as picks, speaks each by its label and starts no sketch", async () => {
    const r = await waitingOnPlanes();
    expect(r.browser.activatePlane(r.list.rows[1]!)).toBe(true);
    expect(r.browser.activatePlane(r.list.rows[3]!, false)).toBe(true);
    expect(r.taken).toEqual([
      { kind: "basePlane", plane: "XZ" },
      expect.objectContaining({ kind: "datumPlane", id: "d1" }),
    ]);
    expect(announce.mock.calls.map((c) => c[0])).toEqual(["XZ plane picked", "Lid picked"]);
    expect(r.host.sketch.enter).not.toHaveBeenCalled();
  });

  it("speaks the refusal of a plane the step cannot take, and nothing else", async () => {
    const r = await waitingOnPlanes(["That row is a base plane, this step needs a face"]);
    expect(r.browser.activatePlane(r.list.rows[0]!)).toBe(true);
    expect(r.host.setStatus).toHaveBeenCalledExactlyOnceWith("That row is a base plane, this step needs a face", "", {
      silent: true,
    });
    expect(r.host.sketch.enter).not.toHaveBeenCalled();
  });

  it("lights a plane row while the pick waits, never raising the origin tiles a pick owns, and puts it out", async () => {
    const r = await waitingOnPlanes();
    r.browser.hover(r.list.rows[1]!);
    expect(r.viewport.hoverPlane.mock.calls).toEqual([["XZ"]]);
    r.browser.hover(r.list.rows[3]!);
    expect(r.viewport.hoverDatum.mock.calls.at(-1)).toEqual(["d1"]);
    r.browser.hover(null);
    expect(r.viewport.hoverPlane.mock.calls.at(-1)).toEqual([null]);
    expect(r.viewport.hoverDatum.mock.calls.at(-1)).toEqual([null]);
    expect(r.viewport.showAllPlanes).not.toHaveBeenCalled();
  });

  it("leaves a tool's own plane light alone when the list lit none", async () => {
    const r = await waitingOnPlanes();
    r.browser.hover(null);
    expect(r.viewport.hoverPlane).not.toHaveBeenCalled();
    expect(r.viewport.hoverDatum).not.toHaveBeenCalled();
  });

  it("refuses a datum plane the document has lost, and the tool never sees it", async () => {
    const r = await waitingOnPlanes();
    const lid = r.list.rows[3]!;
    r.store.removeFeature("d1");
    expect(r.browser.activatePlane(lid)).toBe(true);
    expect(r.taken).toEqual([]);
    expect(r.host.setStatus).toHaveBeenCalledOnce();
  });
});

describe("a lit origin plane", () => {
  async function planes() {
    const r = rig();
    await r.build();
    r.browser.show(true);
    r.browser.setKind("planes");
    r.viewport.showAllPlanes.mockClear();
    return r;
  }
  const xy = (r: ReturnType<typeof rig>) =>
    r.list.rows.find((x) => x.plane?.kind === "basePlane" && x.plane.plane === "XY")!;

  it("shows the tiles while lit and takes them away after", async () => {
    const r = await planes();
    r.browser.hover(xy(r));
    expect(r.viewport.hoverPlane.mock.calls.at(-1)).toEqual(["XY"]);
    r.browser.hover(null);
    expect(r.viewport.hoverPlane.mock.calls.at(-1)).toEqual([null]);
    expect(r.viewport.showAllPlanes.mock.calls).toEqual([[true], [false]]);
  });

  it("does not show the tiles for a datum row", async () => {
    const r = await planes();
    r.list.setRows([{ ...xy(r), key: "p:dp9", plane: { kind: "datumPlane", id: "dp9" } } as never]);
    r.browser.hover(r.list.rows[0]!);
    expect(r.viewport.hoverDatum.mock.calls.at(-1)).toEqual(["dp9"]);
    expect(r.viewport.showAllPlanes.mock.calls).toEqual([[false]]);
  });

  it("leaves the tiles to a plane pick that holds the screen, lit or put out", async () => {
    const r = await planes();
    r.host.toolOwnsScreen.mockReturnValue(true);
    r.browser.hover(xy(r));
    r.browser.hover(null);
    expect(r.viewport.showAllPlanes).not.toHaveBeenCalled();
  });

  it("takes the tiles away when the list leaves planes", async () => {
    const r = await planes();
    r.browser.hover(xy(r));
    r.browser.setKind("faces");
    expect(r.viewport.showAllPlanes.mock.calls.at(-1)).toEqual([false]);
  });
});
