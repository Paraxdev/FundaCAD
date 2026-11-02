// The app's route to the engine's topology op: what goes on the wire, what comes back, and that a reply to a document
// that has ended reaches nothing of the next one.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { Geometry } from "../../src/geometry/client";
import type { TransportSink } from "../../src/geometry/transport";
import type { TopologyReply } from "../../src/types";

vi.stubGlobal("window", globalThis);
vi.mock("../../src/ui/toast", () => ({ toast: () => {}, dismissToast: () => {} }));

const boxA = { id: "a1", type: "box", length: 12, width: 7, height: 3 };
const boxB = { id: "b1", type: "box", length: 31, width: 17, height: 5 };
const REPLY: TopologyReply = {
  body: "body1",
  faceCount: 2,
  faces: [
    { i: 0, surface: "plane", area: 84, centroid: [113.5, -41.25, 37], normal: [0, 0, 1], size: [12, 7] },
    { i: 1, surface: "cylinder", area: 62.8, centroid: [3, 5, 8], axis: [0, 1, 0], radius: 2, length: 5, wraps: true },
  ],
  edgeFaces: [[0, 1], [1]],
};

type Sent = Record<string, unknown> & {
  id: string;
  op: string;
  doc?: string;
  document?: { features: { id: string }[] };
};

function engine() {
  const sent: Sent[] = [];
  let sink!: TransportSink;
  const g = new Geometry({
    open: true,
    async start(s: TransportSink) {
      sink = s;
    },
    send(raw: string) {
      sent.push(JSON.parse(raw) as Sent);
    },
  });
  void g.init();
  const store = new DocumentStore(g, { parameters: {}, features: [boxA as never] });
  g.bindSessions(store.sessions);
  const reply = (id: string, v: object) => sink.message(JSON.stringify({ id, ...v }));
  const last = () => sent.filter((s) => s.op === "topology").at(-1)!;
  return { g, store, sent, reply, last };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("store.topology", () => {
  it("sends the built document, the body and nothing else by default", async () => {
    const e = engine();
    const answer = e.store.topology("body1");
    await settle();
    const { id, doc, document, ...rest } = e.last();
    expect(rest).toEqual({ op: "topology", body: "body1" });
    expect(doc).toBe(e.store.session.id);
    expect(document!.features.map((f) => f.id)).toEqual(["a1"]);
    e.reply(id, { ok: true, result: REPLY });
    await expect(answer).resolves.toEqual(REPLY);
  });

  for (const [name, opts] of [
    ["one face", { faces: [3] }],
    ["several faces", { faces: [0, 2, 5] }],
    ["no faces", { faces: [] }],
    ["a cap", { maxFaces: 2 }],
    ["both", { faces: [1], maxFaces: 40 }],
  ] as const) {
    it(`passes ${name} through`, async () => {
      const e = engine();
      void e.store.topology("Body 7", opts as never);
      await settle();
      const { id: _id, doc: _doc, document: _document, ...rest } = e.last();
      expect(rest).toEqual({ op: "topology", body: "Body 7", ...opts });
    });
  }

  it("hands back the request id, so a newer fetch can cancel this one", async () => {
    const e = engine();
    let started = "";
    void e.store.topology("body1", {}, (id) => (started = id));
    await settle();
    expect(started).toBe(e.last().id);
  });

  it("answers null on an engine error, which also covers an old engine and an unknown body", async () => {
    const e = engine();
    const answer = e.store.topology("body9");
    await settle();
    e.reply(e.last().id, { ok: false, error: { message: "unknown op: topology" } });
    await expect(answer).resolves.toBeNull();
  });

  it("answers null when cancelled", async () => {
    const e = engine();
    const answer = e.store.topology("body1");
    await settle();
    e.reply(e.last().id, { ok: false, cancelled: true, error: { message: "cancelled" } });
    await expect(answer).resolves.toBeNull();
  });

  it("answers null on a backend without the op", async () => {
    const e = engine();
    (e.store as unknown as { geometry: object }).geometry = Object.create(e.g, { topology: { value: undefined } });
    await expect(e.store.topology("body1")).resolves.toBeNull();
  });

  it("a second document asks with its own model, and the first one's reply does not answer it", async () => {
    const e = engine();
    const first = e.store.topology("body1");
    await settle();
    const a = e.last();

    e.store.load(JSON.stringify({ parameters: {}, features: [boxB] }));
    await expect(first).rejects.toThrow();
    const second = e.store.topology("body1");
    await settle();
    const b = e.last();
    expect(b.id).not.toBe(a.id);
    expect(b.doc).not.toBe(a.doc);
    expect(b.doc).toBe(e.store.session.id);
    expect(b.document!.features.map((f) => f.id)).toEqual(["b1"]);

    e.reply(a.id, { ok: true, result: REPLY });
    await settle();
    const own: TopologyReply = { body: "body1", faceCount: 1, faces: [{ i: 0, surface: "other" }] };
    e.reply(b.id, { ok: true, result: own });
    await expect(second).resolves.toEqual(own);
  });
});
