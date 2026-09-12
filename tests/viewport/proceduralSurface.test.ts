import { describe, expect, it } from "vitest";
import { compileGraph, graphKey } from "../../src/viewport/proceduralSurface";
import type { SurfaceGraph } from "../../src/document/materials";

// The compiler turns a node graph into the GLSL `sGraph` function. These check
// the SHAPE of what it emits (the generator calls, the wiring into the output
// ports, dependency order) rather than an exact string, which would break on any
// whitespace change.

const graph: SurfaceGraph = {
  output: "out",
  nodes: [
    { id: "n1", type: "noise", params: { scale: 6 } },
    { id: "s1", type: "scratches", params: { scale: 5, angle: 0.5 } },
    { id: "r1", type: "ramp", params: { colorA: "#000000", colorB: "#ffffff" }, in: { t: "n1" } },
    { id: "out", type: "output", params: { roughAmount: 0.6, bumpAmount: 0.8, colorAmount: 0.5 }, in: { roughness: "n1", bump: "s1", color: "r1" } },
  ],
};

describe("compileGraph", () => {
  it("emits a generator call per generator node with its baked params", () => {
    const glsl = compileGraph(graph);
    expect(glsl).toContain("float g_n1 = sGen(wp, wn, 0,"); // noise = kind 0
    expect(glsl).toContain("float g_s1 = sGen(wp, wn, 1,"); // scratches = kind 1
    expect(glsl).toContain("6.00000"); // the noise scale, baked
  });

  it("wires each output port to its source node's variable", () => {
    const glsl = compileGraph(graph);
    expect(glsl).toContain("o.rough = g_n1;");
    expect(glsl).toContain("o.bump = g_s1;");
    expect(glsl).toContain("o.tint = g_r1;");
    expect(glsl).toContain("o.roughAmt = 0.60000;");
  });

  it("emits a node BEFORE the node that consumes it", () => {
    const glsl = compileGraph(graph);
    // the ramp reads n1, so n1's line must come first
    expect(glsl.indexOf("float g_n1")).toBeLessThan(glsl.indexOf("vec3 g_r1"));
  });

  it("falls back to a default for a missing wire rather than emitting nothing", () => {
    const bare: SurfaceGraph = { output: "out", nodes: [{ id: "out", type: "output" }] };
    const glsl = compileGraph(bare);
    expect(glsl).toContain("o.rough = 0.5;");
    expect(glsl).toContain("o.tint = vec3(0.0);");
  });

  it("keys a graph by value, so an identical graph does not force a recompile", () => {
    expect(graphKey(graph)).toBe(graphKey(JSON.parse(JSON.stringify(graph))));
    expect(graphKey(undefined)).toBe("");
  });
});
