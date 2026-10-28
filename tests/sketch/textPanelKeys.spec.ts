// SketchMode listens for keys on the window in the capture phase, ahead of anything inside the Text tool's panel. Its
// onKey is the real one off the prototype, wired the way SketchMode wires it; the panel is the real one, mounted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { SketchMode } from "../../src/sketch/sketchMode";
import TextToolPanel from "../../src/components/overlays/TextToolPanel.vue";
import { TextPanel } from "../../src/sketch/textPanel";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import type { TextValues } from "../../src/sketch/textForm";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

enableAutoUnmount(afterEach);

let unwire: (() => void) | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});
afterEach(() => {
  unwire?.();
  unwire = null;
});

function sketchInTextTool() {
  const log: string[] = [];
  const s = Object.create(SketchMode.prototype) as { onKey(e: KeyboardEvent): void };
  Object.assign(s, {
    tool: "text",
    selected: new Set(["l1"]),
    splinePts: [],
    clickPts: [],
    base: null,
    arcStart: null,
    dragFrom: null,
    moveDrag: null,
    dim: { isActive: false, ownsTarget: () => false },
    patternFlow: { hasPending: () => false },
    mirrorFlow: { running: false },
    modifyFlow: { offsetting: false, filletArmed: false },
    dimFlow: { picking: false, plan: null },
    constraintTools: { hasPending: () => false },
    dims: { deleteSelected: () => (log.push("delete dimension"), true) },
    setTool: (t: string) => log.push(`tool ${t}`),
    setTangentArc: () => log.push("tangent arc"),
    finish: () => log.push("finish"),
    refreshActive() {},
  });
  const onKey = (e: KeyboardEvent) => s.onKey(e);
  window.addEventListener("keydown", onKey, true);
  unwire = () => window.removeEventListener("keydown", onKey, true);
  return log;
}

function openPanel() {
  const handlers = {
    onCommit: vi.fn<(v: TextValues) => void>(),
    onCancel: vi.fn(),
    onChange: vi.fn<(v: TextValues) => void>(),
  };
  new TextPanel().show({ x: 40, y: 60 }, ["Arial", "Courier"], {}, handlers);
  mount(TextToolPanel, { props: { req: useToolPanelStore().text! }, attachTo: document.body });
  return handlers;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("keys on the Text tool's panel", () => {
  // A native select shielded these as a text field does. A letter here used to switch the tool and drop the text.
  it("never reach SketchMode from the font list, a box, a segment or a button", () => {
    const log = sketchInTextTool();
    const handlers = openPanel();
    const typed: [string, string][] = [
      [".select-trigger", "l"],
      [".select-trigger", "Backspace"],
      ['[role="radio"]', "c"],
      ['[role="radio"]', "t"],
      ["input[type=checkbox]", "r"],
      ["input[type=checkbox]", "Delete"],
      [".text-tool-add", "o"],
      [".text-tool-add", "p"],
      [".text-tool-cancel", "a"],
    ];
    for (const [sel, k] of typed) key(q(sel), k);
    expect(log).toEqual([]);
    expect(useToolPanelStore().text).not.toBeNull();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    // The same key from the canvas is still a tool key.
    key(document.body, "l");
    expect(log).toEqual(["tool line"]);
  });

  it("leave Escape on the font list to the panel, which cancels the text tool only", async () => {
    const log = sketchInTextTool();
    const handlers = openPanel();
    const font = q(".select-trigger");
    font.focus();
    key(font, "Escape");
    await nextTick();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(log).toEqual([]);
  });
});
