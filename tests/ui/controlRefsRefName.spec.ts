import { describe, expect, it } from "vitest";

import { refOf } from "../../src/ui/controlRefs";

function row(cls: string, text: string, refName?: string, top = "Edit"): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", top);
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  if (refName) el.dataset.refName = refName;
  menu.append(el);
  document.body.append(menu);
  return el;
}

describe("refOf with a data-ref-name", () => {
  it("keeps the menu ref when the row reads Undo Box 2", () => {
    expect(refOf(row("menu-item", "Undo Box 2", "Undo"))).toBe("menu:Edit/Undo");
    expect(refOf(row("menu-item", "Redo Move Fillet 3", "Redo", "Edit"))).toBe("menu:Edit/Redo");
  });

  it("keeps the context ref the same way", () => {
    expect(refOf(row("ctx-item", "Undo Box 2", "Undo"))).toBe("ctx:Undo");
  });

  it("falls back to the text without the attribute", () => {
    expect(refOf(row("menu-item", "Undo Box 2"))).toBe("menu:Edit/Undo Box 2");
    expect(refOf(row("menu-item", "Delete"))).toBe("menu:Edit/Delete");
  });
});
