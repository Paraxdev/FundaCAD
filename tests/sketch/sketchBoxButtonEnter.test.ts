// Enter on a focused value box button (Confirm, Cancel, an option) is that button's. The sketch's window capture
// listener hears it first and committed the shape from the cursor, so Cancel on Enter drew the rectangle.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { SketchMode } from "../../src/sketch/sketchMode";

// Node has no DOM; onKey and the focus helpers test instanceof against these.
for (const name of ["Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
  (globalThis as Record<string, unknown>)[name] ??= class {};
}
const g = globalThis as unknown as { HTMLElement: new () => object; HTMLButtonElement?: new () => object };
g.HTMLButtonElement ??= class extends g.HTMLElement {};

function boxButton(inBox: boolean) {
  return Object.assign(new g.HTMLButtonElement!(), {
    isContentEditable: false,
    getAttribute: () => null,
    closest: (sel: string) => (inBox && sel.includes(".dim-input") ? {} : null),
  });
}

function rectangleMidDrag() {
  const commitFromCursor = vi.fn();
  const s = Object.create(SketchMode.prototype) as { onKey(e: Partial<KeyboardEvent>): void };
  Object.assign(s, {
    tool: "rectangle",
    base: new THREE.Vector2(),
    lastCursor: new THREE.Vector2(1, 1),
    splinePts: [],
    commitFromCursor,
    dim: { isActive: true, ownsTarget: () => true },
    patternFlow: { hasPending: () => false },
    mirrorFlow: { running: false },
  });
  return { s, commitFromCursor };
}

function enter(target: object) {
  let prevented = false;
  return {
    key: "Enter",
    target: target as EventTarget,
    preventDefault: () => (prevented = true),
    stopPropagation() {},
    get defaultPrevented() {
      return prevented;
    },
  };
}

describe("Enter in a sketch while the value box shows", () => {
  it("on a focused box button leaves it to the button, the shape is not committed", () => {
    const { s, commitFromCursor } = rectangleMidDrag();
    const e = enter(boxButton(true));
    s.onKey(e);
    expect({ commits: commitFromCursor.mock.calls.length, prevented: e.defaultPrevented }).toEqual({
      commits: 0,
      prevented: false,
    });
  });

  it("on a button outside the box still commits the shape from the cursor", () => {
    const { s, commitFromCursor } = rectangleMidDrag();
    const e = enter(boxButton(false));
    s.onKey(e);
    expect({ commits: commitFromCursor.mock.calls.length, prevented: e.defaultPrevented }).toEqual({
      commits: 1,
      prevented: true,
    });
  });
});
