// The engine's import reply as the app receives it: a DXF's sketches reach the
// caller, and a reply with no geometry stays without it.

import { describe, expect, it } from "vitest";
import { Geometry } from "../../src/geometry/client";
import type { GeometryTransport, TransportSink } from "../../src/geometry/transport";

class ImportTransport implements GeometryTransport {
  private sink: TransportSink | null = null;
  open = false;
  constructor(private readonly result: object) {}
  async start(sink: TransportSink) {
    this.sink = sink;
    this.open = true;
    sink.opened();
  }
  send(raw: string) {
    const req = JSON.parse(raw) as Record<string, unknown>;
    if (req["op"] !== "import") return;
    queueMicrotask(() => this.sink!.message(JSON.stringify({ id: req["id"], ok: true, result: this.result })));
  }
}

describe("importGeometry", () => {
  it("hands a DXF's sketches through and adds no geometry it did not get", async () => {
    const sketches = [{ name: "Plate", entities: [{ id: "e1", type: "line", x1: 0, y1: 0, x2: 1, y2: 0 }] }];
    const g = new Geometry(new ImportTransport({ name: "plate", unit: "mm", notes: ["n"], sketches }));
    await g.init();
    const res = await g.importGeometry("plate.dxf", "dxf");
    expect(res).toMatchObject({ ok: true, name: "plate", sketches, notes: ["n"] });
    expect(res.ok && res.geom).toBeUndefined();
  });
});
