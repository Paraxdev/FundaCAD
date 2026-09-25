// FR-1: the Dimension tool's "Pick a second point" was a toast on every point
// pick. After two dimensions the toasts stacked up over the bottom of the
// canvas and the second pick of the third one landed on a toast's close button,
// so the tool sat waiting for a point it had been given.

import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { DimFlow, type DimHost } from "../../src/sketch/dimFlow";
import { SketchPlane } from "../../src/sketch/plane";
import { usePromptStore } from "../../src/stores/prompt";
import { useToastStore } from "../../src/stores/toasts";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

// the toast store times its rows with window.setTimeout
(globalThis as Record<string, unknown>).window ??= globalThis;

const line = (id: string, x1: number, y1: number, x2: number, y2: number): ResolvedEntity =>
  ({ type: "line", id, x1, y1, x2, y2 });

// a notched bottom edge well away from the Origin, so no pick lands on it
const notch = [
  line("l1", 0, 5, 7, 5),
  line("l2", 7, 5, 10, 8),
  line("l3", 10, 8, 13, 5),
  line("l4", 13, 5, 20, 5),
];

function makeFlow() {
  const entities = notch.map((e) => ({ ...e }));
  const constraints: SketchConstraint[] = [];
  const plane = new SketchPlane("XY");
  const dim = {
    isActive: false,
    show() { this.isActive = true; },
    hide() { this.isActive = false; },
    updateFromCursor() {},
    position() {},
    setClickThrough() {},
    focus() {},
    isUserDriven: () => false,
  };
  const host = {
    entities: () => entities,
    constraints: () => constraints,
    dim: () => dim,
    overlay: () => ({ setPreview() {} }),
    viewport: () => ({
      projectToScreen: () => ({ x: 0, y: 0 }),
      domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }) },
      requestRender() {},
    }),
    plane: () => plane,
    lastCursor: () => new THREE.Vector2(),
    referenceMode: () => false,
    pickTol: () => 0.5,
    planeMmPerPx: () => 0.1,
    planePoint: () => null,
    textEntityAt: () => null,
    evalDimInput: (raw: string) => ({ value: Number(raw), expr: null }),
    recordBinding() {},
    placeDim: (c: SketchConstraint) => c,
    onState() {},
  } as unknown as DimHost;
  return { flow: new DimFlow(host), dim };
}

const click = (flow: DimFlow, x: number, y: number) =>
  flow.dimensionClick(new THREE.Vector2(x, y), { clientX: 0, clientY: 0 } as PointerEvent);

describe("FR-1: a point pick asks for the second one in the prompt", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("the first point pick prompts, it does not toast", () => {
    const { flow } = makeFlow();
    click(flow, 7, 5);
    expect(flow.pickCount).toBe(1);
    expect(usePromptStore().text).toMatch(/Pick a second point/);
    expect(useToastStore().items).toEqual([]);
  });

  it("a missed second pick re-states the prompt without a toast", () => {
    const { flow } = makeFlow();
    click(flow, 7, 5);
    click(flow, 50, 50);
    expect(flow.pickCount).toBe(1);
    expect(usePromptStore().text).toMatch(/Pick a second point/);
    expect(useToastStore().items).toEqual([]);
  });

  it("three dimensions in a row leave no toast behind and each opens its box", () => {
    const { flow, dim } = makeFlow();
    for (const [a, b] of [[0, 20], [0, 7], [7, 13]] as const) {
      click(flow, a, 5);
      click(flow, b, 5);
      expect(flow.plan?.kind).toBe("distance");
      expect(dim.isActive).toBe(true);
      flow.cancelDim();
    }
    expect(useToastStore().items).toEqual([]);
  });
});

describe("toast stack", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("the same line again refreshes the one showing instead of stacking", () => {
    const toasts = useToastStore();
    toasts.push("Pick a second point", "info", undefined, 3500);
    toasts.push("Pick a second point", "info", undefined, 3500);
    toasts.push("Something else", "info", undefined, 3500);
    expect(toasts.items.map((t) => t.message)).toEqual(["Pick a second point", "Something else"]);
  });
});
