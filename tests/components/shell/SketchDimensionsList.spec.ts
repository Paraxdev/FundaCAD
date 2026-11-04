// The Dimensions list in the sketch palette: one number row per badge, reading the badge store and committing through
// the same closures. The real facade builds the items from slanted shapes off the origin.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import SketchDimensionsList from "../../../src/components/shell/SketchDimensionsList.vue";
import { SketchDimensions, type ExtraDim } from "../../../src/sketch/sketchDimensions";
import { useSketchAnnotationStore } from "../../../src/stores/sketchAnnotations";
import type { ResolvedEntity } from "../../../src/sketch/snap";
import type { SketchPlane } from "../../../src/sketch/plane";
import type { Viewport } from "../../../src/viewport/viewport";

enableAutoUnmount(afterEach);

const viewport = {} as Viewport;
const newPlane = () =>
  ({ to3D: (x: number, y: number, out: THREE.Vector3) => out.set(x, y, 0) }) as unknown as SketchPlane;

const RECT: ResolvedEntity = { type: "rectangle", id: "r1", x: 33.5, y: 17.2, width: 20, height: 10 };
const CIRCLE: ResolvedEntity = { type: "circle", id: "c1", x: 41, y: -7, radius: 3.5 };

let onEdit: Mock<(i: number, f: string, mm: number) => void>;
let onEditExpr: Mock<(i: number, f: string, raw: string) => string | null>;
let plane: SketchPlane;
let bound: Record<string, string>;
let hooks: {
  overlapPick: () => boolean;
  planePoint: () => null;
  labelMenu: () => void;
  light: Mock<(ids: string[] | null) => void>;
};

const facade = () =>
  new SketchDimensions(
    viewport,
    (i, f, mm) => onEdit(i, f, mm),
    (i, f, raw) => onEditExpr(i, f, raw),
    (i, f) => bound[`${i}:${f}`],
  );

const extra = (over: Partial<ExtraDim> = {}): ExtraDim => ({
  key: "c:k1",
  name: "Angle between Line 1 and Line 2",
  entities: ["l1", "l2"],
  anchor: new THREE.Vector2(1, 2),
  valueMm: 40,
  commit: () => {},
  ...over,
});

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  plane = newPlane();
  onEdit = vi.fn();
  onEditExpr = vi.fn(() => null);
  bound = {};
  hooks = {
    overlapPick: () => false,
    planePoint: () => null,
    labelMenu: () => {},
    light: vi.fn<(ids: string[] | null) => void>(),
  };
});

type W = ReturnType<typeof mount>;

async function open(ents: ResolvedEntity[], extras: ExtraDim[] = [], skip?: Set<string>) {
  const dims = facade();
  dims.show(ents, plane, extras, skip);
  const store = useSketchAnnotationStore();
  store.dimHooks = hooks;
  const w = mount(SketchDimensionsList, { attachTo: document.body });
  await nextTick();
  return { dims, store, w };
}

const rowsOf = (w: W) => w.findAll("li.dim-row");
const inputOf = (w: W, i: number) => rowsOf(w)[i]!.get("input");
const valueOf = (w: W, i: number) => (inputOf(w, i).element as HTMLInputElement).value;
const labelOf = (w: W, i: number) => rowsOf(w)[i]!.get("label").text();
const focusIn = (w: W, i: number) => {
  const el = inputOf(w, i).element as HTMLInputElement;
  el.focus();
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
};

async function type(w: W, i: number, text: string, key = "Enter") {
  const input = inputOf(w, i);
  (input.element as HTMLInputElement).focus();
  await input.setValue(text);
  await input.trigger("keydown", { key });
  await nextTick();
}

describe("Dimensions list rows", () => {
  it("says there are none, then one named row each for many", async () => {
    const { w, dims } = await open([]);
    expect(w.text()).toBe("No dimensions yet.");
    dims.show([RECT, CIRCLE], plane, [extra()]);
    await nextTick();
    expect(rowsOf(w).map((_, i) => [labelOf(w, i), valueOf(w, i)])).toEqual([
      ["Width of Rectangle 1", "20"],
      ["Height of Rectangle 1", "10"],
      ["Diameter of Circle 1", "7"],
      ["Angle between Line 1 and Line 2", "40"],
    ]);
  });

  it("names each field by its row label", async () => {
    const { w } = await open([RECT]);
    for (let i = 0; i < 2; i++) {
      const input = inputOf(w, i).element;
      const label = rowsOf(w)[i]!.get("label").element as HTMLLabelElement;
      expect(input.getAttribute("aria-labelledby")).toBe(label.id);
      expect(label.htmlFor).toBe(input.id);
    }
  });

  it("numbers a name that repeats and no other", async () => {
    const { w } = await open(
      [],
      [extra({ key: "c:a" }), extra({ key: "c:b" }), extra({ key: "c:c", name: "Radius of Arc 1" })],
    );
    expect([0, 1, 2].map((i) => labelOf(w, i))).toEqual([
      "Angle between Line 1 and Line 2, row 1",
      "Angle between Line 1 and Line 2, row 2",
      "Radius of Arc 1",
    ]);
  });

  it("shows a conflicting and a redundant dimension's state", async () => {
    const { w } = await open(
      [],
      [extra({ key: "c:a", conflict: true }), extra({ key: "c:b", over: true }), extra({ key: "c:c" })],
    );
    expect(rowsOf(w).map((r) => (r.find(".ui-field-hint").exists() ? r.get(".ui-field-hint").text() : null))).toEqual([
      "Conflicting",
      "Redundant",
      null,
    ]);
  });
});

describe("Dimensions list commits", () => {
  it("sends a typed length in millimetres to the entity edit", async () => {
    const { w } = await open([{ ...RECT, x: -4.5, y: 8.25 }]);
    await type(w, 1, "12.5");
    expect(onEdit.mock.calls).toEqual([[0, "height", 12.5]]);
    expect(onEditExpr).not.toHaveBeenCalled();
  });

  it("commits a typed unit as millimetres", async () => {
    const { w } = await open([CIRCLE]);
    await type(w, 0, "1 in");
    expect(onEdit.mock.calls).toEqual([[0, "diameter", 25.4]]);
  });

  it("refuses 0 and a negative length, and takes the smallest positive one", async () => {
    const { w } = await open([RECT]);
    await type(w, 0, "0");
    expect(inputOf(w, 0).attributes("aria-invalid")).toBe("true");
    await type(w, 0, "-3");
    expect(onEdit).not.toHaveBeenCalled();
    expect(inputOf(w, 0).attributes("aria-invalid")).toBe("true");
    await type(w, 0, "0.01");
    expect(onEdit.mock.calls).toEqual([[0, "width", 0.01]]);
  });

  it("accepts a negative angle", async () => {
    const commit = vi.fn();
    const { w } = await open([], [extra({ kind: "angle", commit })]);
    await type(w, 0, "-45");
    expect(commit.mock.calls).toEqual([[-45]]);
  });

  it("sends a formula to the expression path, never to the value", async () => {
    const { w } = await open([RECT]);
    await type(w, 0, "W/2");
    expect(onEditExpr.mock.calls).toEqual([[0, "width", "W/2"]]);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("shows a bound dimension's expression and sends every typed text to it", async () => {
    bound = { "0:width": "W" };
    const { w } = await open([RECT]);
    expect(valueOf(w, 0)).toBe("W");
    await type(w, 0, "30");
    expect(onEditExpr.mock.calls).toEqual([[0, "width", "30"]]);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("keeps a refused expression on the field with its reason", async () => {
    onEditExpr.mockReturnValue("Unknown name Q");
    const { w } = await open([RECT]);
    await type(w, 0, "Q*2");
    expect(inputOf(w, 0).attributes("aria-invalid")).toBe("true");
    expect(rowsOf(w)[0]!.get(".ui-field-hint").text()).toBe("Unknown name Q");
  });

  it("reverts on Escape", async () => {
    const { w } = await open([RECT]);
    await type(w, 0, "99", "Escape");
    expect(valueOf(w, 0)).toBe("20");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("reads a reference dimension without editing it", async () => {
    const commit = vi.fn();
    const { w } = await open([], [extra({ driven: true, valueMm: 12.5, commit })]);
    expect(inputOf(w, 0).attributes("readonly")).toBeDefined();
    expect(valueOf(w, 0)).toBe("12.5");
    await type(w, 0, "20");
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("Dimensions list and the badges", () => {
  it("lights the badge and the shapes of the row in focus, and clears on blur", async () => {
    const { w, store } = await open([RECT, CIRCLE]);
    focusIn(w, 2);
    expect(store.dimLit).toBe("c1:diameter");
    expect(hooks.light).toHaveBeenLastCalledWith(["c1"]);
    focusIn(w, 0);
    expect(store.dimLit).toBe("r1:width");
    inputOf(w, 0).element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    expect(store.dimLit).toBeNull();
    expect(hooks.light).toHaveBeenLastCalledWith(null);
  });

  it("keeps focus and the typed draft through a rebuild", async () => {
    const { w, dims, store } = await open([RECT, CIRCLE]);
    focusIn(w, 1);
    await inputOf(w, 1).setValue("13");
    dims.show([{ ...RECT, width: 24 }, CIRCLE], plane);
    await nextTick();
    await nextTick();
    const input = inputOf(w, 1).element as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("13");
    expect(store.dimLit).toBe("r1:height");
    expect(valueOf(w, 0)).toBe("24");
  });

  it("puts focus back on a committed row after a rebuild dropped it", async () => {
    const { w, dims } = await open([RECT]);
    await type(w, 0, "21");
    (document.activeElement as HTMLElement).blur();
    dims.show([{ ...RECT, width: 21 }], plane);
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(inputOf(w, 0).element);
  });

  it("keeps rows in the order they first appeared when a side becomes a constraint", async () => {
    const { w, dims } = await open([RECT, CIRCLE]);
    const side = extra({ key: "r1:width", name: "Width of Rectangle 1", entities: ["r1"], valueMm: 22 });
    dims.show([RECT, CIRCLE], plane, [side], new Set(["r1:width"]));
    await nextTick();
    expect([0, 1, 2].map((i) => labelOf(w, i))).toEqual([
      "Width of Rectangle 1",
      "Height of Rectangle 1",
      "Diameter of Circle 1",
    ]);
    expect(valueOf(w, 0)).toBe("22");
  });

  it("replaces a first sketch's rows and its lit key when a second sketch opens", async () => {
    const { w, dims, store } = await open([RECT, CIRCLE]);
    focusIn(w, 0);
    expect(store.dimLit).toBe("r1:width");

    dims.hide();
    dims.show([CIRCLE, { ...RECT, id: "r9", x: -6, y: 2 }], newPlane());
    await nextTick();
    expect(store.dimLit).toBeNull();
    expect(rowsOf(w).map((_, i) => labelOf(w, i))).toEqual([
      "Diameter of Circle 1",
      "Width of Rectangle 1",
      "Height of Rectangle 1",
    ]);
  });
});
