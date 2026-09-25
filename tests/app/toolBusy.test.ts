// The two busy predicates, and the one thing that stands the body gizmo down.
//
// Worth pinning because the difference between them is a single term and the
// symptom of getting it wrong is silence. Picking a body raises the Move gizmo
// by itself (app/viewportWiring.onBodySelectionChange), so with one predicate
// doing both jobs a body selection was busy from the instant it existed: the
// floating toolbar could never appear over a body, right-clicking a body you
// had already selected opened nothing at all, and the items on the menu you
// could open refused themselves with "Finish the active tool first".

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createToolBusy, restoreWhenIdle } from "../../src/app/toolBusy";
import type { Engine } from "../../src/app/engine";

// isChoiceOpen() is a term of the predicate and reads a store, so the
// predicates need a pinia even though nothing here opens a dialog.
beforeEach(() => setActivePinia(createPinia()));

/** Just enough Engine for the predicates: they read `.active` flags and two
 *  fields, and nothing here constructs a tool. */
function fakeEngine(over: {
  move?: boolean;
  extrude?: boolean;
  sketch?: boolean;
  mode?: "faces" | "bodies";
} = {}) {
  let cancelled = 0;
  const off = { active: false };
  const e = {
    sketch: { active: over.sketch ?? false },
    planePick: false,
    viewport: { selecting: over.mode ?? "bodies" },
    store: { buildState: { result: null } },
    tools: {
      extrude: { active: over.extrude ?? false },
      move: { active: over.move ?? false, cancel: () => { cancelled++; } },
      edgeFeature: off, pressPull: off, faceOffset: off, draft: off, thread: off, hole: off,
      loft: off, planeOffset: off, datumPose: off, lightAim: off, pattern: off, measure: off, targetEdit: off,
      revolvePitch: off, joint: off, section: { picking: false },
    },
  } as unknown as Engine;
  return { e, cancels: () => cancelled };
}

describe("toolBusy versus toolOwnsScreen", () => {
  it("agree about everything except the Move gizmo", () => {
    const idle = createToolBusy(fakeEngine().e);
    expect(idle.toolBusy()).toBe(false);
    expect(idle.toolOwnsScreen()).toBe(false);

    const moving = createToolBusy(fakeEngine({ move: true }).e);
    expect(moving.toolBusy()).toBe(true);
    // The whole point: an ambient affordance may still show over this.
    expect(moving.toolOwnsScreen()).toBe(false);
  });

  it("both refuse for a tool the user actually started", () => {
    // CONTROL on the line above. If toolOwnsScreen ever answered false here,
    // the selection toolbar would draw itself over the middle of a live
    // Press/Pull and take the clicks meant for the drag.
    for (const started of [{ extrude: true }, { sketch: true }]) {
      const t = createToolBusy(fakeEngine(started).e);
      expect(t.toolBusy()).toBe(true);
      expect(t.toolOwnsScreen()).toBe(true);
    }
  });

  it("still counts a Move that is up alongside another tool", () => {
    const t = createToolBusy(fakeEngine({ move: true, extrude: true }).e);
    expect(t.toolOwnsScreen()).toBe(true);
  });
});

describe("dropBodyGizmo", () => {
  it("cancels the gizmo a body selection raised", () => {
    const f = fakeEngine({ move: true, mode: "bodies" });
    createToolBusy(f.e).dropBodyGizmo();
    expect(f.cancels()).toBe(1);
  });

  it("leaves a Move that is not about bodies alone", () => {
    // Faces mode is not where the ambient gizmo comes from, so a Move running
    // there is a mode somebody entered and cancelling it would throw away work.
    const f = fakeEngine({ move: true, mode: "faces" });
    createToolBusy(f.e).dropBodyGizmo();
    expect(f.cancels()).toBe(0);
  });

  it("costs nothing when there is no gizmo", () => {
    const f = fakeEngine({ mode: "bodies" });
    createToolBusy(f.e).dropBodyGizmo();
    expect(f.cancels()).toBe(0);
  });
});

describe("restoreWhenIdle", () => {
  function harness() {
    const frames: (() => void)[] = [];
    const docFns = new Set<() => void>();
    const s = { busy: true, sel: ["body1"] as string[], raised: 0 };
    const stop = restoreWhenIdle({
      busy: () => s.busy,
      selection: () => s.sel,
      onDocChange: (fn) => { docFns.add(fn); fn(); return () => docFns.delete(fn); },
      raise: () => { s.raised++; },
      frame: (fn) => frames.push(fn),
      cancelFrame: (id) => { frames[id - 1] = () => {}; },
    });
    const step = (n = 1) => { for (let i = 0; i < n; i++) frames.shift()?.(); };
    return { s, step, stop, frames, docChanged: () => [...docFns].forEach((fn) => fn()) };
  }

  it("raises the gizmo again once the command is escaped with the body still selected", () => {
    const h = harness();
    h.step(5);
    expect(h.s.raised).toBe(0);
    h.s.busy = false;
    h.step(3);
    expect(h.s.raised).toBe(1);
    expect(h.frames).toHaveLength(0);
  });

  it("waits out the one idle frame a picker leaves before handing its pick on", () => {
    const h = harness();
    h.s.busy = false;
    h.step();
    h.s.busy = true;
    h.step(3);
    expect(h.s.raised).toBe(0);
  });

  it("gives up when the selection changes", () => {
    const h = harness();
    h.s.sel = [];
    h.s.busy = false;
    h.step(3);
    expect(h.s.raised).toBe(0);
    expect(h.frames).toHaveLength(0);
  });

  it("gives up when the command committed, which changed the document", () => {
    const h = harness();
    h.docChanged();
    h.s.busy = false;
    h.step(3);
    expect(h.s.raised).toBe(0);
  });
});
