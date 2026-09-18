// A value typed into a feature's row has to reach the engine. The rebuild wire
// protocol sends only the features whose OBJECT changed since the last build,
// so a write that patched a feature in place built the old value again: a Move
// edited from its rows, typed and committed faster than the row's preview,
// kept the body where it was.
import { describe, expect, it, vi, afterEach } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { Geometry } from "../../src/geometry/client";
import type { GeometryTransport, TransportSink } from "../../src/geometry/transport";
import type { CadDocument, Feature } from "../../src/types";

class RecordingTransport implements GeometryTransport {
  sent: Record<string, unknown>[] = [];
  private sink: TransportSink | null = null;
  open = false;
  async start(sink: TransportSink) {
    this.sink = sink;
    this.open = true;
    sink.opened();
  }
  send(raw: string) {
    const req = JSON.parse(raw) as Record<string, unknown>;
    if (req["op"] !== "rebuild") return;
    this.sent.push(req);
    queueMicrotask(() =>
      this.sink!.message(JSON.stringify({ id: req["id"], ok: true, result: { protocol: 2, bodies: [], bbox: null } })),
    );
  }
}

/** The feature `id` as the engine holds it after every rebuild request so far. */
function engineCopy(sent: Record<string, unknown>[], id: string): Feature | undefined {
  let features: Feature[] = [];
  for (const req of sent) {
    const doc = req["document"] as CadDocument | undefined;
    if (doc) {
      features = doc.features.slice();
      continue;
    }
    const ops = req["ops"] as { length: number; set: [number, Feature][] };
    features.length = ops.length;
    for (const [i, f] of ops.set) features[i] = f;
  }
  return features.find((f) => f?.id === id);
}

const moveDoc = (): CadDocument => ({
  parameters: {},
  features: [
    { id: "f1", type: "box", length: 20, width: 20, height: 20 },
    { id: "m1", type: "move", dx: 10, dy: 0, dz: 0, rx: 0, ry: 0, rz: 30, bodies: ["body1"] },
  ] as Feature[],
});

describe("a value edit reaches the engine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup() {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const transport = new RecordingTransport();
    const geometry = new Geometry(transport);
    await geometry.init();
    const store = new DocumentStore(geometry, moveDoc());
    await store.rebuildNow();
    return { transport, store };
  }

  it("a Move's typed value is in the next rebuild", async () => {
    const { transport, store } = await setup();
    store.setTargetValue({ kind: "feature", feature: "m1", field: "dx" }, 40, "length");
    await vi.runAllTimersAsync();
    const last = transport.sent[transport.sent.length - 1]!;
    expect(last["ops"]).toBeDefined(); // a delta, the path that dropped the edit
    expect(engineCopy(transport.sent, "m1")).toMatchObject({ dx: 40, rz: 30 });
  });

  it("every Move field, and a later second edit, arrive", async () => {
    const { transport, store } = await setup();
    const fields = ["dx", "dy", "dz", "rx", "ry", "rz"] as const;
    for (const [n, field] of fields.entries()) {
      store.setTargetValue({ kind: "feature", feature: "m1", field }, n + 5, field.startsWith("r") ? "angle" : "length");
      await vi.runAllTimersAsync();
      expect((engineCopy(transport.sent, "m1") as unknown as Record<string, number>)[field]).toBe(n + 5);
    }
  });

  it("the document is not changed through a feature object the caller still holds", async () => {
    const { store } = await setup();
    const before = store.document.features[1];
    store.setTargetValue({ kind: "feature", feature: "m1", field: "dz" }, 7, "length");
    expect(store.document.features[1]).not.toBe(before);
    expect((before as unknown as Record<string, number>)["dz"]).toBe(0);
  });
});
