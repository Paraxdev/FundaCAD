// The blend member list. Its buttons act on pointerdown with the default refused, so focus stays put and the press
// never becomes a pick on the edge underneath; that, the names the remove buttons carry and the Card head are pinned.

import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import FilletMembers from "../../../src/components/overlays/FilletMembers.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { EdgeMemberRow } from "../../../src/features/edgeFeatureTool";

enableAutoUnmount(afterEach);

function setup(rows: EdgeMemberRow[], kind: "fillet" | "chamfer" = "fillet") {
  const tool = {
    editingMembers: vi.fn(() => true),
    memberRows: vi.fn(() => rows),
    blendKind: () => kind,
    removeMemberByKey: vi.fn(),
    promptAddMember: vi.fn(),
  };
  const engine = {
    tools: { edgeFeature: tool },
    store: { onBuild: () => () => {}, onDocChange: () => () => {} },
  } as unknown as Engine;
  mount(FilletMembers, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
  return tool;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const $ = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];
const down = (el: HTMLElement) => {
  const e = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

const ROWS: EdgeMemberRow[] = [
  { key: "a", label: "Edge 3", resolved: true },
  { key: "b", label: "Edge 7", resolved: false },
] as EdgeMemberRow[];

describe("FilletMembers", () => {
  it("heads a card with the blend's kind and its counts", async () => {
    setup(ROWS, "chamfer");
    await frame();
    const card = $(".fm-card")[0]!;
    expect(card.getAttribute("role")).toBe("group");
    const title = $(".fm-card .float-card-title")[0]!;
    expect(title.textContent).toBe("Chamfer");
    expect(card.getAttribute("aria-labelledby")).toBe(title.id);
    expect($(".fm-count")[0]!.textContent).toBe("1 edge");
    expect($(".fm-warn-count")[0]!.textContent).toBe("1 unresolved");
    expect($(".fm-row").map((r) => r.classList.contains("unresolved"))).toEqual([false, true]);
  });

  it("removes a member on the press, with its default refused and the press kept off the viewport", async () => {
    const tool = setup(ROWS);
    await frame();
    const outer = vi.fn();
    document.body.addEventListener("pointerdown", outer);
    const x = $(".fm-x")[1]!;
    expect(x.getAttribute("aria-label")).toBe("Remove Edge 7");
    expect(x.title).toBe("Remove Edge 7");
    expect(down(x).defaultPrevented).toBe(true);
    expect(tool.removeMemberByKey).toHaveBeenCalledWith("b");
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener("pointerdown", outer);
  });

  it("asks the tool for another edge from Add edge", async () => {
    const tool = setup(ROWS);
    await frame();
    const add = $(".fm-add")[0]!;
    expect(add.textContent!.trim()).toBe("Add edge");
    expect(down(add).defaultPrevented).toBe(true);
    expect(tool.promptAddMember).toHaveBeenCalledOnce();
  });

  it("stays out of the DOM while no blend is edited", async () => {
    const tool = setup(ROWS);
    tool.editingMembers.mockReturnValue(false);
    await frame();
    expect($(".fm-card")).toEqual([]);
  });
});
