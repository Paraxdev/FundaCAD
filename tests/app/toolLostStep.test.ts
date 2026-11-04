// A document change, an undo or a redo above all, that takes away what an open tool works on closes it: Enter would
// add a red step or nothing, and either way lose the redo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelActiveTools = vi.fn();
vi.mock("../../src/app/toolBusy", () => ({ cancelActiveTools: () => cancelActiveTools() }));

import { closeToolOnLostStep } from "../../src/app/selection";
import type { Engine } from "../../src/app/engine";

beforeEach(() => cancelActiveTools.mockReset());

function watched(opts: { editing?: string; sketches?: string[]; atWork?: boolean; ids: string[] }) {
  const listeners = new Set<(doc: unknown) => void>();
  let ids = opts.ids;
  const doc = () => ({ features: ids.map((id) => ({ id })) });
  const e = {
    tools: { extrude: { active: !!opts.sketches?.length, profileSketches: opts.sketches ?? [] } },
    toolAtWork: () => opts.atWork ?? true,
    store: {
      editPreviewId: opts.editing ?? null,
      get document() {
        return doc();
      },
      onDocChange(fn: (d: unknown) => void) {
        listeners.add(fn);
        fn(doc());
        return () => listeners.delete(fn);
      },
    },
  } as unknown as Engine;
  closeToolOnLostStep(e);
  return (next: string[]) => {
    ids = next;
    for (const fn of listeners) fn(doc());
  };
}
const standDowns = () => cancelActiveTools.mock.calls.length;

describe("closeToolOnLostStep", () => {
  it("closes a tool re-editing the step a change removed, not one re-editing a step that stays", () => {
    watched({ editing: "f7", ids: ["b3", "f7"] })(["b3"]);
    expect(standDowns()).toBe(1);
    watched({ editing: "f7", ids: ["b3", "f7", "f9"] })(["b3", "f7"]);
    expect(standDowns()).toBe(1);
  });

  it("closes an extrude when one of its sketches goes, with none, one or many picked", () => {
    watched({ sketches: [], ids: ["b3", "s4"] })(["b3"]);
    expect(standDowns()).toBe(0);
    watched({ sketches: ["s4"], ids: ["s4", "b3"] })(["s4"]);
    expect(standDowns()).toBe(0);
    watched({ sketches: ["s4"], ids: ["b3", "s4"] })(["b3"]);
    expect(standDowns()).toBe(1);
    watched({ sketches: ["s4", "s6"], ids: ["s4", "b3", "s6"] })(["s4", "b3"]);
    expect(standDowns()).toBe(2);
  });

  it("closes the tool when the step comes back and goes again, as a redo then an undo do", () => {
    const change = watched({ editing: "f7", ids: ["b3"] });
    change(["b3", "f7"]);
    expect(standDowns()).toBe(0);
    change(["b3"]);
    expect(standDowns()).toBe(1);
  });

  it("leaves alone an id that was never in the document, an open sketch's own profile", () => {
    watched({ sketches: ["__active__"], ids: ["b3", "s4"] })(["b3"]);
    expect(standDowns()).toBe(0);
  });

  it("does nothing while no tool is at work", () => {
    watched({ editing: "f7", atWork: false, ids: ["b3", "f7"] })(["b3"]);
    expect(standDowns()).toBe(0);
  });
});
