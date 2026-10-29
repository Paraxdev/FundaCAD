// The sketch Linear Pattern tool is its own tool that stores the same patternRect an old document holds,
// one row, so the engine and every saved sketch keep working unchanged.
import { beforeEach, describe, it, expect } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { PatternFlow, ENTITY_PATTERNS, type PatternHost } from "../../src/sketch/patternFlow";
import type { SketchTool } from "../../src/sketch/sketchMode";
import type { SketchPattern } from "../../src/types";

beforeEach(() => setActivePinia(createPinia()));

function rig(start: SketchTool, existing: SketchPattern[] = []) {
  let tool = start;
  const patterns: SketchPattern[] = [...existing];
  const shown: { name: string }[][] = [];
  const dim = {
    show: (defs: { name: string }[]) => shown.push(defs),
    updateFromCursor: () => {},
    getValue: () => undefined,
    isUserDriven: () => false,
    position: () => {},
    hide: () => {},
  };
  const host = {
    tool: () => tool,
    setActiveTool: (t: SketchTool) => {
      tool = t;
    },
    setTool: () => {},
    selected: () => new Set(["c1"]),
    patterns: () => patterns,
    dim: () => dim,
    sourcePoint: () => ({ x: 0, y: 0 }),
    requestSolve: () => {},
    toScreen: () => null,
    showCentreDot: () => {},
    refreshActive: () => {},
    onState: () => {},
  } as unknown as PatternHost;
  return { flow: new PatternFlow(host), patterns, shown, tool: () => tool };
}

describe("sketch Linear Pattern", () => {
  it("is an entity pattern tool", () => {
    expect(ENTITY_PATTERNS.has("patternLinear")).toBe(true);
  });

  it("places one row and asks only for the count", () => {
    const { flow, patterns, shown } = rig("patternLinear");
    flow.click(new THREE.Vector2(0, 0));
    expect(shown[0]?.map((d) => d.name)).toEqual(["countX"]);
    flow.commit();
    expect(patterns[0]).toMatchObject({ type: "patternRect", countX: 3, countY: 1 });
  });

  it("follows the cursor direction, as a line does", () => {
    const { flow, patterns } = rig("patternLinear");
    flow.click(new THREE.Vector2(0, 0));
    flow.move(new THREE.Vector2(0, 20), { altKey: true, clientX: 0, clientY: 0 } as PointerEvent);
    flow.commit();
    expect(patterns[0]).toMatchObject({ spacingX: 20, angle: 90 });
  });
});

describe("sketch Rectangular Pattern", () => {
  it("opens as a grid with both counts", () => {
    const { flow, patterns, shown } = rig("patternRect");
    flow.click(new THREE.Vector2(0, 0));
    expect(shown[0]?.map((d) => d.name)).toEqual(["countX", "countY"]);
    flow.commit();
    expect(patterns[0]).toMatchObject({ type: "patternRect", countX: 3, countY: 3 });
  });

  it("opens a stored grid in the Rect tool with both counts", () => {
    const grid: SketchPattern = {
      id: "g",
      type: "patternRect",
      sources: ["c1"],
      countX: 3,
      countY: 2,
      spacingX: 10,
      spacingY: 8,
    };
    const { flow, shown, tool } = rig("select", [grid]);
    flow.edit("g");
    expect(tool()).toBe("patternRect");
    expect(shown[0]?.map((d) => d.name)).toEqual(["countX", "countY"]);
  });
});

describe("editing a one row pattern", () => {
  const row: SketchPattern = {
    id: "r",
    type: "patternRect",
    sources: ["c1"],
    countX: 3,
    countY: 1,
    spacingX: 10,
    spacingY: 0,
  };

  it("reopens in the Linear tool, which has no Ny to stack rows with", () => {
    const { flow, shown, tool } = rig("select", [row]);
    flow.edit("r");
    expect(tool()).toBe("patternLinear");
    expect(shown[0]?.map((d) => d.name)).toEqual(["countX"]);
  });
});
