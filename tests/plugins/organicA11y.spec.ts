// The Node body panel draws with the base controls: every control is named, the nodes and chains are lists, the
// position, radius and turn of a node are named groups of named numbers with their unit, and a refusal is an error
// alert in words.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import NodePanel from "../../plugins/FundaCAD.Organic/NodePanel.vue";
import * as panel from "../../plugins/FundaCAD.Organic/panel";
import type { NodeFeature, NodeValues } from "../../plugins/FundaCAD.Organic/nodeForm";
import { byName, describedBy, nameOf, rawControls, stubResizeObserver, unnamed } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
});
afterEach(() => {
  panel.close();
  vi.unstubAllGlobals();
});

const node = (id: string, over: Partial<NodeValues> = {}): NodeValues => ({
  id,
  x: 0,
  y: 0,
  z: 0,
  sx: 5,
  sy: 5,
  sz: 5,
  rx: 0,
  ry: 0,
  rz: 0,
  ...over,
});

function handlers() {
  return {
    select: vi.fn(),
    setValue: vi.fn<(id: string, field: string, raw: string) => string | null>(() => null),
    setFeature: vi.fn(),
    removeNode: vi.fn(),
    removeChain: vi.fn(),
    setLinkNew: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
}

async function open(
  feature: Partial<NodeFeature> = {},
  view: Partial<panel.NodeView> = {},
  h = handlers(),
): Promise<{ root: Element; h: ReturnType<typeof handlers> }> {
  mount(NodePanel, { attachTo: document.body });
  panel.open(
    {
      editing: false,
      feature: {
        id: "f1",
        type: "organic",
        nodes: [node("n1"), node("n2", { sx: 6, sy: 7, sz: 8 }), node("n3")],
        chains: [["n1", "n2", "n3"]],
        ...feature,
      },
      selected: "n1",
      linkNew: true,
      bound: new Set(),
      error: null,
      ...view,
    },
    h,
  );
  await flushPromises();
  return { root: document.querySelector("[data-panel=node-body]")!, h };
}

const field = (root: Element, name: string) =>
  [...root.querySelectorAll<HTMLInputElement>(".ui-number-field input")].find((el) => nameOf(el) === name)!;

function type(input: HTMLInputElement, text: string) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("the Node body panel, for a screen reader", () => {
  it("names every control and draws no raw one", async () => {
    const { root } = await open();
    expect(rawControls(root)).toEqual([]);
    expect(unnamed(root)).toEqual([]);
  });

  it("is a named region still marked data-panel=node-body", async () => {
    const { root } = await open();
    const region = root.closest("[role=region]")!;
    expect(region).not.toBeNull();
    expect(nameOf(region)).toBe("Node body");
  });

  it("titles the panel for an edit", async () => {
    const { root } = await open({}, { editing: true });
    expect(nameOf(root.closest("[role=region]")!)).toBe("Edit node body");
  });

  it("lists the nodes as buttons named by id and size, the picked one current", async () => {
    const { root } = await open();
    const list = root.querySelector<HTMLElement>("ul[aria-label=Nodes], [role=list][aria-label=Nodes]")!;
    expect(list).not.toBeNull();
    const rows = [...list.querySelectorAll<HTMLElement>("[data-node]")];
    expect(rows.map((r) => r.dataset["node"])).toEqual(["n1", "n2", "n3"]);
    expect(rows.map((r) => r.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect(rows.map((r) => nameOf(r))).toEqual([
      "n1, diameter 10 mm",
      "n2, size 12 by 14 by 16 mm",
      "n3, diameter 10 mm",
    ]);
    expect(rows.map((r) => r.parentElement!.getAttribute("role") ?? r.parentElement!.tagName)).toEqual([
      "listitem",
      "listitem",
      "listitem",
    ]);
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual(["true", null, null]);
  });

  it("selects a node on a click of its row and removes it from its own named button", async () => {
    const { root, h } = await open();
    byName<HTMLElement>(root, "[data-node]", /^n2,/)!.click();
    expect(h.select).toHaveBeenCalledWith("n2");
    byName<HTMLElement>(root, "button", "Remove node n2")!.click();
    expect(h.removeNode).toHaveBeenCalledWith("n2");
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it("lists the chains with a named remove button each", async () => {
    const { root, h } = await open({
      chains: [
        ["n1", "n2"],
        ["n2", "n3"],
      ],
    });
    const list = root.querySelector<HTMLElement>("[role=list][aria-label=Chains], ul[aria-label=Chains]")!;
    expect(list.children).toHaveLength(2);
    expect(list.textContent).toContain("n1 → n2");
    byName<HTMLElement>(root, "button", "Remove chain n2 to n3")!.click();
    expect(h.removeChain).toHaveBeenCalledWith(1);
  });

  it("draws the picked node's numbers as three named groups of named fields", async () => {
    const { root } = await open();
    const groups = [...root.querySelectorAll<HTMLElement>("[role=group]")].filter((g) =>
      /^(Centre|Radius|Turn)$/.test(nameOf(g)),
    );
    expect(groups.map((g) => nameOf(g))).toEqual(["Centre", "Radius", "Turn"]);
    const names = groups.map((g) => [...g.querySelectorAll("input")].map((i) => nameOf(i)));
    expect(names).toEqual([
      ["Centre X", "Centre Y", "Centre Z"],
      ["Radius X", "Radius Y", "Radius Z"],
      ["Turn X", "Turn Y", "Turn Z"],
    ]);
  });

  it("says millimetres on a position, a radius and the blend, and degrees on a turn", async () => {
    const { root } = await open();
    for (const name of ["Centre X", "Radius Y", "Blend"]) {
      expect(describedBy(field(root, name)), name).toMatch(/mm|millimet/i);
    }
    for (const name of ["Turn X", "Turn Z"]) {
      expect(describedBy(field(root, name)), name).toMatch(/deg|°/i);
    }
  });

  it("commits a typed number through the tool, by field", async () => {
    const { root, h } = await open();
    type(field(root, "Radius Z"), "7.5");
    await flushPromises();
    expect(h.setValue).toHaveBeenCalledWith("n1", "sz", "7.5");
    type(field(root, "Blend"), "2");
    await flushPromises();
    expect(h.setFeature).toHaveBeenCalledWith({ blend: 2 });
  });

  it("shows a field a parameter drives as locked, with the reason", async () => {
    const { root, h } = await open({ nodes: [node("n1", { x: "width" })] }, { bound: new Set(["n1.x"]) });
    const locked = field(root, "Centre X");
    expect(locked.value).toBe("width");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.title).toBe("A parameter drives this value");
    type(locked, "9");
    await flushPromises();
    expect(h.setValue).not.toHaveBeenCalled();
  });

  it("names the operation and the link choice", async () => {
    const { root, h } = await open();
    const op = byName<HTMLElement>(root, "[role=combobox]", /^Operation/)!;
    expect(op).toBeDefined();
    expect(nameOf(op)).toMatch(/New body/);
    op.click();
    await flushPromises();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["New body", "Join", "Cut", "Intersect"]);
    options[2]!.click();
    await flushPromises();
    expect(h.setFeature).toHaveBeenCalledWith({ operation: "cut" });

    const link = byName<HTMLInputElement>(root, "input[type=checkbox]", "Link new nodes to the picked one")!;
    expect(link.checked).toBe(true);
    link.click();
    expect(h.setLinkNew).toHaveBeenCalledWith(false);
  });

  it("keeps Cancel and Add or Update as named buttons with their data-action", async () => {
    const { root, h } = await open();
    root.querySelector<HTMLElement>("[data-action=cancel]")!.click();
    root.querySelector<HTMLElement>("[data-action=commit]")!.click();
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(nameOf(root.querySelector("[data-action=commit]")!)).toBe("Add");
  });

  it("calls the Update button Update for an edit", async () => {
    const { root } = await open({}, { editing: true });
    expect(nameOf(root.querySelector("[data-action=commit]")!)).toBe("Update");
  });

  it("tells a model error as an error alert in words", async () => {
    const { root } = await open({}, { error: "the nodes do not form a solid" });
    const alerts = [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent);
    expect(alerts).toEqual(["Error: the nodes do not form a solid"]);
  });

  it("tells a number the tool refuses as an error alert naming the field", async () => {
    const { root, h } = await open();
    h.setValue.mockReturnValue("Type a number");
    type(field(root, "Centre Z"), "4");
    await flushPromises();
    const alerts = [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent);
    expect(alerts).toEqual(["Error: Centre Z: Type a number"]);
  });

  it("refuses a radius of zero before the tool hears of it", async () => {
    const { root, h } = await open();
    type(field(root, "Radius X"), "0");
    await flushPromises();
    expect(h.setValue).not.toHaveBeenCalled();
    expect(root.querySelector("[role=alert]")?.textContent).toMatch(
      /^Error: Radius X: .*radius must be greater than 0/,
    );
  });

  it("tells text that is no number as an error alert and sends nothing", async () => {
    const { root, h } = await open();
    type(field(root, "Centre Y"), "3*");
    await flushPromises();
    expect(h.setValue).not.toHaveBeenCalled();
    expect([...root.querySelectorAll("[role=alert]")].map((a) => a.textContent?.slice(0, 7))).toEqual(["Error: "]);
  });

  it("refuses a negative blend", async () => {
    const { root, h } = await open();
    type(field(root, "Blend"), "-1");
    await flushPromises();
    expect(h.setFeature).not.toHaveBeenCalled();
    expect(root.querySelector("[role=alert]")?.textContent).toMatch(/^Error: .*0 or more/);
  });

  it("hides the size tag from a screen reader, since the row says the size", async () => {
    await open();
    panel.label.value = { x: 10, y: 20, text: "⌀ 10" };
    await flushPromises();
    const tag = document.querySelector("[data-node-size]")!;
    expect(tag.getAttribute("aria-hidden")).toBe("true");
  });

  it("asks for the first node while there is none", async () => {
    const { root } = await open({ nodes: [], chains: [] }, { selected: null });
    expect(root.textContent).toContain("Click in the view to place the first node.");
    expect(root.querySelectorAll("[role=list]")).toHaveLength(0);
  });
});
