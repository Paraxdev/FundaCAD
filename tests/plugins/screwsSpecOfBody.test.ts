// specOfBody runs for every body row of the Browser pane, so it must not scan the bodies once per body.

import { describe, expect, it } from "vitest";
import { specOfBody } from "../../plugins/FundaCAD.Screws/insert";
import type { Engine } from "../../src/app/engine";

function engineWith(bodies: { id: string; faceOwners: string[] }[], features: Record<string, unknown>[]) {
  return { store: { buildState: { result: { bodies } }, document: { features } } } as unknown as Engine;
}

describe("specOfBody", () => {
  const spec = { name: "ISO 4762 M3x10" };
  const fastener = { id: "f1", type: "import", generatedBy: { plugin: "FundaCAD.Screws", spec } };

  it("finds the spec of a generated body and nothing for the others", () => {
    const e = engineWith(
      [
        { id: "b1", faceOwners: ["box"] },
        { id: "b2", faceOwners: ["f1", "f1"] },
      ],
      [{ id: "box", type: "box" }, fastener],
    );
    expect(specOfBody(e, "b1")).toBeNull();
    expect(specOfBody(e, "b2")).toEqual(spec);
    expect(specOfBody(e, "b3")).toBeNull();
  });

  it("reads a new build's bodies, not the ones it saw before", () => {
    const features = [{ id: "box", type: "box" }, fastener];
    expect(specOfBody(engineWith([{ id: "b1", faceOwners: ["box"] }], features), "b1")).toBeNull();
    expect(specOfBody(engineWith([{ id: "b1", faceOwners: ["f1"] }], features), "b1")).toEqual(spec);
  });

  it("answers every body of an 80,000 body model in well under the time a scan per body takes", () => {
    const bodies = Array.from({ length: 80_000 }, (_, i) => ({ id: `body${i + 1}`, faceOwners: ["box"] }));
    bodies[bodies.length - 1]!.faceOwners = ["f1"];
    const e = engineWith(bodies, [{ id: "box", type: "box" }, fastener]);
    const started = performance.now();
    let found = 0;
    for (const b of bodies) if (specOfBody(e, b.id)) found++;
    expect(found).toBe(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
