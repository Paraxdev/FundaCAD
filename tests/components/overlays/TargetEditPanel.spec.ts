// The selection editor and the PickList it wears: its buttons are base controls now, so what is pinned is that each
// still calls the tool once, that an empty list's Clear all refuses the click while keeping its tooltip, and that a
// remove names its row and never also pins it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import TargetEditPanel from "../../../src/components/overlays/TargetEditPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";

enableAutoUnmount(afterEach);

function fakeTool(rows: { label: string; resolved: boolean }[]) {
  const listeners = new Set<() => void>();
  return {
    active: true,
    editingId: "f1",
    field: { field: "faces", label: "Faces", kind: "face", shape: "set", arity: "many" },
    rows: vi.fn(() => rows),
    onChange: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: () => listeners.forEach((fn) => fn()),
    hoverAt: vi.fn(),
    removeAt: vi.fn(),
    clear: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
}

function mountWith(tool: ReturnType<typeof fakeTool>) {
  const engine = {
    tools: { targetEdit: tool },
    store: { document: { features: [{ id: "f1", type: "fillet", name: "Round edge" }] } },
  } as unknown as Engine;
  return mount(TargetEditPanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

const $ = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];

describe("TargetEditPanel", () => {
  it("names the feature and lists the rows, the unresolved one marked", () => {
    mountWith(
      fakeTool([
        { label: "Face 1", resolved: true },
        { label: "Face 9", resolved: false },
      ]),
    );
    expect($(".tgt-title")[0]!.textContent).toBe("Round edge");
    expect($(".tgt-item .tgt-label").map((l) => l.textContent)).toEqual(["Face 1", "Face 9"]);
    expect($(".tgt-item").map((r) => r.classList.contains("tgt-unresolved"))).toEqual([false, true]);
  });

  it("calls the tool once from Done, Cancel and Clear all", () => {
    const tool = fakeTool([{ label: "Face 1", resolved: true }]);
    mountWith(tool);
    $(".tgt-done")[0]!.click();
    $(".tgt-cancel")[0]!.click();
    $(".tgt-clear")[0]!.click();
    expect([tool.commit, tool.cancel, tool.clear].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect($(".tgt-done")[0]!.getAttribute("type")).toBe("button");
  });

  it("refuses Clear all on an empty list, keeping its tooltip", () => {
    const tool = fakeTool([]);
    mountWith(tool);
    const clear = $(".tgt-clear")[0]!;
    expect(clear.getAttribute("aria-disabled")).toBe("true");
    expect(clear.title).toBe("Remove every entry");
    expect(clear.textContent!.trim()).toBe("Clear all");
    clear.click();
    clear.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(tool.clear).not.toHaveBeenCalled();
    expect($(".tgt-none")[0]!.textContent).toBe("Click geometry to add");
  });

  it("removes a row by index without pinning it, and the button says which row", async () => {
    const tool = fakeTool([
      { label: "Face 1", resolved: true },
      { label: "Face 4", resolved: true },
    ]);
    mountWith(tool);
    const remove = $(".tgt-remove")[1]!;
    expect(remove.getAttribute("aria-label")).toBe("Remove Face 4");
    expect(remove.title).toBe("Remove Face 4");
    remove.click();
    expect(tool.removeAt).toHaveBeenCalledWith(1);
    expect(tool.hoverAt).toHaveBeenLastCalledWith(null);
    await nextTick();
    expect($(".tgt-held")).toEqual([]);
  });

  it("pins a clicked row, so leaving another row lights the pinned one again", async () => {
    const tool = fakeTool([
      { label: "Face 1", resolved: true },
      { label: "Face 4", resolved: true },
    ]);
    mountWith(tool);
    $(".tgt-item")[0]!.click();
    await nextTick();
    expect($(".tgt-item")[0]!.classList.contains("tgt-held")).toBe(true);
    $(".tgt-item")[1]!.dispatchEvent(new PointerEvent("pointerenter"));
    $(".tgt-item")[1]!.dispatchEvent(new PointerEvent("pointerleave"));
    expect(tool.hoverAt.mock.calls).toEqual([[0], [1], [0]]);
  });

  it("goes away when the tool closes", async () => {
    const tool = fakeTool([{ label: "Face 1", resolved: true }]);
    mountWith(tool);
    tool.active = false;
    tool.emit();
    await nextTick();
    expect($(".tgt-panel")).toEqual([]);
  });
});
