// Every engine request belongs to the document session current when it was made: ending that session rejects it
// with SessionEnded, keeps it off the wire if it was still queued, and drops every late frame for it.
import { describe, expect, it } from "vitest";
import { Geometry } from "../../src/geometry/client";
import { OpCancelled, SessionHost, isSessionEnded } from "../../src/document/session";
import type { TransportSink } from "../../src/geometry/transport";
import type { CadDocument } from "../../src/types";

function frame(env: object): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify(env));
  const pad = (4 - (header.length % 4)) % 4;
  const out = new ArrayBuffer(4 + header.length + pad);
  new DataView(out).setUint32(0, header.length, true);
  new Uint8Array(out).set(header, 4);
  return out;
}

const headFrame = (id: string) =>
  frame({
    id,
    stream: { sid: "s1", seq: 0, final: false },
    status: "chunk",
    result: {
      protocol: 2,
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      manifest: [{ id: "ghost", name: "ghost", etag: "e", faceCount: 1, nVerts3: 9, nIdx: 3, nTris: 1, nEdges: 1 }],
    },
  });

function rig(open = true) {
  const sent: { id: string; op: string; raw: string }[] = [];
  let sink!: TransportSink;
  const transport = {
    open,
    async start(s: TransportSink) {
      sink = s;
    },
    send(raw: string) {
      const m = JSON.parse(raw) as { id: string; op: string };
      sent.push({ id: m.id, op: m.op, raw });
    },
  };
  const g = new Geometry(transport);
  const host = new SessionHost();
  g.bindSessions(host);
  void g.init();
  const heard: string[] = [];
  g.onProgress((f, _m, _t, id) => heard.push(`progress:${f}:${id}`));
  g.onQueue((id) => heard.push(`queue:${id}`));
  g.onOpProgress((id) => heard.push(`op:${id}`));
  g.onRebuildChunk((c) => heard.push(`chunk:${c.id}`));
  const text = (v: object) => sink.message(JSON.stringify(v));
  const binary = (b: ArrayBuffer) => sink.message(b);
  const connect = () => {
    transport.open = true;
    sink.opened();
  };
  return { g, host, sent, heard, text, binary, connect, inFlight: () => g.inFlight };
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: unknown) => (isSessionEnded(e) ? "SessionEnded" : `error: ${(e as Error).message}`),
  );

const doc: CadDocument = { parameters: {}, features: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("engine requests and document sessions", () => {
  it("ending a session rejects exactly its calls, and late frames of them reach no listener", async () => {
    const r = rig();
    const a1 = outcome(r.g.generateShape("gear", { teeth: 12 }));
    const a2 = outcome(r.g.rebuild(doc));
    const appCancel = outcome(r.g.cancel("rq-x"));
    const [idA1, idA2, idCancel] = r.sent.map((s) => s.id);
    r.host.begin("new");
    const b1 = outcome(r.g.generateShape("gear", { teeth: 8 }));
    const idB1 = r.sent.at(-1)!.id;
    const afterSwap = r.inFlight();

    for (const id of [idA1, idA2]) {
      r.text({ id, status: "queued", behind: null });
      r.text({ id, status: "building", feature: 2, meshed: 1, meshTotal: 4 });
      r.text({ id, status: "importing", pct: 40, label: "Transferring shapes" });
    }
    r.binary(headFrame(idA2!));
    r.binary(frame({ id: idA1, ok: true, result: { mesh: null } }));
    r.text({ id: idA2, ok: true, result: { protocol: 2 } });
    const heardFromA = [...r.heard];

    r.text({ id: idB1, status: "queued", behind: null });
    r.text({ id: idCancel, ok: true, result: { cancelled: true } });
    r.text({ id: idB1, ok: false, error: { message: "no such generator" } });
    expect({
      ops: r.sent.map((s) => s.op),
      afterSwap,
      results: await Promise.all([a1, a2, appCancel, b1]),
      heardFromA,
      heardFromB: r.heard,
      left: r.inFlight(),
    }).toEqual({
      ops: ["generateShape", "rebuild", "cancel", "generateShape"],
      afterSwap: 2,
      results: ["SessionEnded", "SessionEnded", "resolved", "resolved"],
      heardFromA: [],
      heardFromB: [`queue:${idB1}`],
      left: 0,
    });

    // A second document after the first: B's own call ends with B, C's goes through.
    const b2 = outcome(r.g.generateShape("gear", { teeth: 9 }));
    r.host.begin("open");
    const c1 = outcome(r.g.generateShape("gear", { teeth: 10 }));
    r.text({ id: r.sent.at(-1)!.id, ok: true, result: {} });
    expect(await Promise.all([b2, c1])).toEqual(["SessionEnded", "resolved"]);
  });

  it("a request of an ended session still in the outbox never goes out on reconnect", async () => {
    const r = rig(false);
    const a = outcome(r.g.rebuild(doc));
    r.host.begin("discard");
    const b = outcome(r.g.generateShape("gear", { teeth: 8 }));
    r.connect();
    const sentOps = r.sent.map((s) => s.op);
    r.text({ id: r.sent[0]!.id, ok: true, result: {} });
    expect({ sentOps, results: await Promise.all([a, b]) }).toEqual({
      sentOps: ["generateShape"],
      results: ["SessionEnded", "resolved"],
    });
  });

  it("a stream head for an id nobody waits on opens no stream", async () => {
    const r = rig();
    r.binary(headFrame("never-sent"));
    await tick();
    expect({ heard: r.heard, inFlight: r.inFlight() }).toEqual({ heard: [], inFlight: 0 });
  });

  it("a new session's first rebuild is a whole document, a rebuild later in the same session is a delta", async () => {
    const r = rig();
    const one: CadDocument = { parameters: {}, features: [{ id: "f1", type: "box" } as never] };
    const two: CadDocument = { parameters: {}, features: [...one.features, { id: "f2", type: "box" } as never] };
    const shape = (i: number) => {
      const m = JSON.parse(r.sent[i]!.raw) as Record<string, unknown>;
      return { whole: "document" in m, delta: "baseRevision" in m, known: m.known };
    };
    const answer = async (p: Promise<unknown>) => {
      r.text({ id: r.sent.at(-1)!.id, ok: true, result: { mesh: null } });
      await p;
    };
    await answer(r.g.rebuild(one));
    await answer(r.g.rebuild(two));
    r.host.begin("new");
    await answer(r.g.rebuild(two));
    await answer(r.g.rebuild(one));
    expect([0, 1, 2, 3].map(shape)).toEqual([
      { whole: true, delta: false, known: {} },
      { whole: false, delta: true, known: {} },
      { whole: true, delta: false, known: {} },
      { whole: false, delta: true, known: {} },
    ]);
  });

  it("a building status reaches progress listeners with its request id", async () => {
    const r = rig();
    void r.g.rebuild(doc);
    const id = r.sent[0]!.id;
    r.text({ id, status: "building", feature: 3 });
    r.text({ id: "not-ours", status: "building", feature: 4 });
    expect(r.heard).toEqual([`progress:3:${id}`]);
  });

  it("a request whose op was cancelled before its id was known is never sent, one not cancelled is", async () => {
    const r = rig();
    const refused = await r.g.importGeometry("a.step", "step", () => {
      throw new OpCancelled();
    });
    const kept = r.g.importGeometry("b.step", "step", () => {});
    expect({ refused, sent: r.sent.map((s) => s.op), inFlight: r.inFlight() }).toEqual({
      refused: { ok: false, cancelled: true, message: "import cancelled" },
      sent: ["import"],
      inFlight: 1,
    });
    void kept;
  });

  it("Cancel with no request id cancels nothing, it no longer falls back to the last request sent", async () => {
    const r = rig();
    void r.g.rebuild(doc);
    const without = await r.g.cancel();
    expect({ without, sent: r.sent.map((s) => s.op) }).toEqual({ without: false, sent: ["rebuild"] });
  });

  it("a request made while its session is ending is refused unsent, one in the next session goes out", async () => {
    const r = rig();
    let during: Promise<string> | null = null;
    r.host.current.own(() => {
      during = outcome(r.g.rebuild(doc));
    });
    r.host.begin("new");
    const after = outcome(r.g.generateShape("gear", { teeth: 8 }));
    r.text({ id: r.sent[0]!.id, ok: true, result: {} });
    expect({ during: await during, after: await after, sent: r.sent.map((s) => s.op) }).toEqual({
      during: "SessionEnded",
      after: "resolved",
      sent: ["generateShape"],
    });
  });
});
