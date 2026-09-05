// The window's half of a live session: what it publishes, and what it takes.
//
// The dangerous shapes here are all silent. An edit applied with no undo step, a
// revision that does not move when the user edits (which would make every stale
// check pass), a read-only window that applies anyway. Each has a control below
// that must fail if the rule were dropped.
//
// The geometry backend is a stub because none of this is geometry: the loop is
// one message out and one message back, and a real socket would only add a way
// for these to be flaky.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore, EMPTY_DOCUMENT } from "../../src/document/store";
import { LiveSessionHost } from "../../src/live/liveSession";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

/** A backend that records what the host published and replays a scripted reply.
 *  `rebuild` resolves empty: the store schedules one after every load, and a
 *  pending promise there would leak between tests. */
class StubBackend {
  sent: { op: string; payload: Record<string, unknown> }[] = [];
  reply: Record<string, unknown> | null = { ok: true, guests: [], proposals: [] };

  async session(op: string, payload: object = {}): Promise<Record<string, unknown> | null> {
    this.sent.push({ op, payload: payload as Record<string, unknown> });
    return this.reply;
  }
  async rebuild() {
    return { ok: true, result: { bodies: [], errors: [] } } as never;
  }
  async init() {}
  onStatus() {
    return () => {};
  }
  get connected() {
    return true;
  }
}

const backend = () => new StubBackend() as unknown as GeometryBackend & StubBackend;

function doc(n: number): CadDocument {
  return {
    parameters: {},
    features: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, type: "box" })),
  } as unknown as CadDocument;
}

function proposal(id: string, features: number, note: string | null = null) {
  return { id, name: "an assistant", note, document: doc(features) };
}

describe("the window's half of a live session", () => {
  let geo: GeometryBackend & StubBackend;
  let store: DocumentStore;

  beforeEach(() => {
    geo = backend();
    store = new DocumentStore(geo, EMPTY_DOCUMENT);
  });

  it("publishes the open document, and nothing until it is started", async () => {
    const host = new LiveSessionHost(store, geo, () => true);
    await host.tick();
    expect(geo.sent, "a stopped host published anyway").toHaveLength(0);

    host.start();
    await host.tick();
    await host.stop();

    const published = geo.sent.filter((m) => m.op === "session_host");
    expect(published.length).toBeGreaterThan(0);
    expect(published[0]!.payload["document"]).toMatchObject({ features: [] });
  });

  it("moves the revision for a PERSON's edit, not only an assistant's", async () => {
    // The revision is what the sidecar checks a proposal against. If a user's
    // own edits did not move it, every stale check would pass and an assistant
    // could overwrite a change made while it was thinking.
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick(); // drains the publish start() kicks off
    const before = geo.sent.at(-1)!.payload["revision"] as number;

    store.mutate((d) => {
      d.features.push({ id: "f1", type: "box" } as never);
    }, true);
    await host.tick();
    await host.stop();

    const after = geo.sent.filter((m) => m.op === "session_host").at(-1)!.payload["revision"];
    expect(after, "a user's edit left the revision where it was").toBeGreaterThan(before);
  });

  it("applies an assistant's edit through the document store, so it is one undo", async () => {
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick(); // drain the publish start() kicks off before scripting one
    geo.reply = { ok: true, guests: ["an assistant"], proposals: [proposal("p1", 3, "add a hole")] };
    await host.tick();

    expect(store.document.features).toHaveLength(3);
    store.undo();
    expect(store.document.features, "the edit was not undoable").toHaveLength(0);
    await host.stop();
  });

  it("acknowledges by proposal id, which is what the assistant waits on", async () => {
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick(); // drain the publish start() kicks off before scripting one
    geo.reply = { ok: true, guests: ["an assistant"], proposals: [proposal("p7", 2)] };
    await host.tick();

    geo.reply = { ok: true, guests: ["an assistant"], proposals: [] };
    await host.tick();
    const status = geo.sent.filter((m) => m.op === "session_host").at(-1)!.payload["status"] as {
      applied: string[];
    };
    expect(status.applied).toContain("p7");
    await host.stop();
  });

  it("does not apply anything while the window is sharing read-only", async () => {
    const host = new LiveSessionHost(store, geo, () => false);
    host.start();
    await host.tick(); // drain the publish start() kicks off before scripting one
    geo.reply = { ok: true, guests: ["an assistant"], proposals: [proposal("p1", 5)] };
    await host.tick();

    expect(store.document.features, "a read-only window took an edit").toHaveLength(0);
    const status = geo.sent.filter((m) => m.op === "session_host").at(-1)!.payload["status"] as {
      canEdit: boolean;
      applied: string[];
    };
    // …and says so, so the assistant refuses up front rather than waiting out a
    // timeout to discover it.
    expect(status.canEdit).toBe(false);
    expect(status.applied).not.toContain("p1");
    await host.stop();
  });

  it("reads the edit policy at the moment of use, not at start", async () => {
    // The control for the test above: a policy captured at start() would leave a
    // window applying edits for the rest of the session after the user turned
    // the setting down to read-only.
    let allowed = true;
    const host = new LiveSessionHost(store, geo, () => allowed);
    host.start();
    await host.tick(); // drain the publish start() kicks off before scripting one
    geo.reply = { ok: true, guests: ["a"], proposals: [proposal("p1", 2)] };
    await host.tick();
    expect(store.document.features).toHaveLength(2);

    allowed = false;
    geo.reply = { ok: true, guests: ["a"], proposals: [proposal("p2", 6)] };
    await host.tick();
    expect(store.document.features, "the setting change was ignored").toHaveLength(2);
    await host.stop();
  });

  it("ignores a proposal that is not a document", async () => {
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick(); // drain the publish start() kicks off before scripting one
    geo.reply = {
      ok: true,
      guests: ["a"],
      proposals: [{ id: "p1", name: "a", note: null, document: { nope: true } }],
    };
    await host.tick();
    expect(store.document.features).toHaveLength(0);
    await host.stop();
  });

  it("stops publishing and says so when it is stopped", async () => {
    const host = new LiveSessionHost(store, geo, () => true);
    host.start();
    await host.tick();
    await host.stop();
    expect(geo.sent.map((m) => m.op)).toContain("session_release");

    const sentBefore = geo.sent.length;
    await host.tick();
    expect(geo.sent, "a stopped host kept publishing").toHaveLength(sentBefore);
    expect(host.snapshot.sharing).toBe(false);
  });

  it("survives a backend that is not there", async () => {
    // The socket drops, the sidecar restarts. One missed tick, not a broken
    // window — every publish carries the whole document, so the next one is a
    // complete recovery with no resync of any kind.
    const failing = {
      session: vi.fn().mockRejectedValue(new Error("socket closed")),
      rebuild: async () => ({ ok: true, result: { bodies: [], errors: [] } }),
      init: async () => {},
      onStatus: () => () => {},
      connected: false,
    } as unknown as GeometryBackend;
    const host = new LiveSessionHost(store, failing, () => true);
    host.start();
    await expect(host.tick()).resolves.toBeUndefined();
    await host.stop();
  });

  it("tells subscribers who is attached", async () => {
    const host = new LiveSessionHost(store, geo, () => true);
    const seen: string[][] = [];
    host.subscribe((s) => seen.push(s.guests));
    host.start();
    await host.tick(); // drain the publish start() kicks off before scripting one
    geo.reply = { ok: true, guests: ["an assistant"], proposals: [] };
    await host.tick();
    expect(seen.at(-1)).toEqual(["an assistant"]);
    await host.stop();
    expect(host.snapshot.guests, "a stopped session still showed a guest").toEqual([]);
  });
});
