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
    expect($(".tgt-item .is-selected")).toEqual([]);
  });

  it("pins a clicked row, so leaving another row lights the pinned one again", async () => {
    const tool = fakeTool([
      { label: "Face 1", resolved: true },
      { label: "Face 4", resolved: true },
    ]);
    mountWith(tool);
    $(".tgt-item .tgt-label")[0]!.click();
    await nextTick();
    expect($(".tgt-item .tgt-label").map((b) => b.getAttribute("aria-current"))).toEqual(["true", null]);
    $(".tgt-item .tgt-label")[1]!.dispatchEvent(new PointerEvent("pointerenter"));
    $(".tgt-item .tgt-label")[1]!.dispatchEvent(new PointerEvent("pointerleave"));
    expect(tool.hoverAt.mock.calls).toEqual([[0], [1], [0]]);
  });

  it("holds each row as a named button beside its Remove, not around it", () => {
    const tool = fakeTool([
      { label: "Face 8 of Bracket", resolved: true },
      { label: "Edge 12 of Bracket", resolved: true },
      { label: "Face 5 of Lid", resolved: false },
    ]);
    mountWith(tool);
    const items = $(".tgt-item");
    expect(items.map((li) => [...li.children].map((c) => c.tagName + "." + c.className.split(" ").pop()))).toEqual(
      items.map(() => ["BUTTON.tgt-label", "BUTTON.tgt-remove"]),
    );
    expect($(".tgt-label").map((b) => [b.tagName, b.getAttribute("type"), b.textContent])).toEqual([
      ["BUTTON", "button", "Face 8 of Bracket"],
      ["BUTTON", "button", "Edge 12 of Bracket"],
      ["BUTTON", "button", "Face 5 of Lid"],
    ]);
    expect($(".tgt-label button, .tgt-label .tgt-remove")).toEqual([]);
  });

  it("lights a row's geometry on keyboard focus and returns to the pinned row on blur", async () => {
    const tool = fakeTool([
      { label: "Face 3", resolved: true },
      { label: "Face 7", resolved: true },
      { label: "Face 9", resolved: true },
    ]);
    mountWith(tool);
    const rows = $(".tgt-item .tgt-label");
    rows[2]!.focus();
    expect(tool.hoverAt.mock.calls).toEqual([[2]]);
    rows[2]!.blur();
    expect(tool.hoverAt.mock.calls).toEqual([[2], [null]]);
    rows[1]!.click();
    await nextTick();
    rows[0]!.focus();
    rows[0]!.blur();
    expect(tool.hoverAt.mock.calls.slice(2)).toEqual([[1], [0], [1]]);
  });

  it("leaves Enter and Escape to the tool, the row button handling neither itself", async () => {
    const tool = fakeTool([{ label: "Face 3", resolved: true }]);
    mountWith(tool);
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(`${e.key}:${e.defaultPrevented}`);
    window.addEventListener("keydown", onKey);
    const row = $(".tgt-item .tgt-label")[0]!;
    for (const key of ["Enter", "Escape"]) {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    window.removeEventListener("keydown", onKey);
    expect(seen).toEqual(["Enter:false", "Escape:false"]);
    expect(tool.hoverAt).not.toHaveBeenCalled();
    expect(tool.commit).not.toHaveBeenCalled();
    expect(tool.cancel).not.toHaveBeenCalled();
  });

  it("goes away when the tool closes", async () => {
    const tool = fakeTool([{ label: "Face 1", resolved: true }]);
    mountWith(tool);
    tool.active = false;
    tool.emit();
    await nextTick();
    expect($(".tgt-panel")).toEqual([]);
  });

  it("tells rows of one name apart, in the text and in each Remove, and removes the row clicked", () => {
    const tool = fakeTool([
      { label: "Edge 12 of Lid", resolved: true },
      { label: "Face 3 of Lid", resolved: true },
      { label: "Edge 12 of Lid", resolved: true },
      { label: "Edge 12 of Lid", resolved: false },
    ]);
    mountWith(tool);
    const names = ["Edge 12 of Lid, row 1", "Face 3 of Lid", "Edge 12 of Lid, row 3", "Edge 12 of Lid, row 4"];
    expect($(".tgt-item .tgt-label").map((l) => l.textContent)).toEqual(names);
    expect($(".tgt-remove").map((b) => b.getAttribute("aria-label"))).toEqual(names.map((n) => `Remove ${n}`));
    $(".tgt-remove")[2]!.click();
    expect(tool.removeAt.mock.calls).toEqual([[2]]);
  });
});
