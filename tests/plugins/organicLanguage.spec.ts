// The Node body panel, its rows, options and refusals, and the tool's prompt read in the chosen language through the
// plugin's own lines, and a list read after a switch is in the new language.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import NodePanel from "../../plugins/FundaCAD.Organic/NodePanel.vue";
import { activate } from "../../plugins/FundaCAD.Organic/main";
import {
  NODE_CHOICE_FIELDS,
  NODE_TARGETS,
  nodeNumFields,
  sizeLabel,
  type NodeValues,
} from "../../plugins/FundaCAD.Organic/nodeForm";
import * as panel from "../../plugins/FundaCAD.Organic/panel";
import { setLanguage } from "../../src/i18n";
import { resetContributions } from "../../src/plugins/contrib";
import { featureEnglish, featureMeta } from "../../src/ui/featureMeta";
import type { Engine } from "../../src/app/engine";
import { byName, nameOf, stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(async () => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
  await setLanguage("en");
});
afterEach(async () => {
  panel.close();
  vi.unstubAllGlobals();
  await setLanguage("system");
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

async function open(editing = false, error: string | null = null) {
  const h = {
    select: vi.fn(),
    setValue: vi.fn<(id: string, field: string, raw: string) => string | null>(() => "Type a number"),
    setFeature: vi.fn(),
    removeNode: vi.fn(),
    removeChain: vi.fn(),
    setLinkNew: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
  mount(NodePanel, { attachTo: document.body });
  panel.open(
    {
      editing,
      feature: {
        id: "f1",
        type: "organic",
        nodes: [node("n1"), node("n2", { sx: 6, sy: 7, sz: 8 }), node("n3", { sx: 2.25, sy: 2.25, sz: 2.25 })],
        chains: [["n1", "n2", "n3"]],
      },
      selected: "n1",
      linkNew: true,
      bound: new Set(),
      error,
    },
    h,
  );
  await flushPromises();
  return { root: document.querySelector("[data-panel=node-body]")!, h };
}

const names = (root: Element) =>
  [...root.querySelectorAll<HTMLInputElement>(".ui-number-field input")].map((el) => nameOf(el));

describe("the Node body panel follows the language", () => {
  it("reads German", async () => {
    await setLanguage("de");
    const { root } = await open();
    expect(nameOf(root.closest("[role=region]")!)).toBe("Knotenkörper");
    expect(root.querySelector("[role=list]")?.getAttribute("aria-label")).toBe("Knoten");
    expect(names(root)).toContain("Radius X");
    expect(names(root)).toContain("Drehung Z");
    expect(names(root)).toContain("Mittelpunkt Y");
    expect(byName(root, "button", "Knoten n1 entfernen")).toBeDefined();
    expect(byName(root, "button", "Kette n1 → n2 → n3 entfernen")).toBeDefined();
    expect(byName(root, "button", "n2, Größe 12 mal 14 mal 16 mm")).toBeDefined();
    expect(byName(root, "button", "n3, Durchmesser 4,5 mm")).toBeDefined();
    expect(root.textContent).toContain("⌀ 4,5");
    expect(root.textContent).toContain("12 × 14 × 16");
    expect(byName(root, "button", "Hinzufügen")).toBeDefined();
    expect(byName(root, "button", "Abbrechen")).toBeDefined();
    expect(root.textContent).toContain("Neue Knoten mit dem ausgewählten verknüpfen");
  });

  it("reads Japanese and shows the edit title and button when editing", async () => {
    await setLanguage("ja");
    const { root } = await open(true);
    expect(nameOf(root.closest("[role=region]")!)).toBe("ノードボディを編集");
    expect(byName(root, "button", "更新")).toBeDefined();
    expect(names(root)).toContain("半径 X");
    expect(byName(root, "button", "n1、直径 10 mm")).toBeDefined();
  });

  it("follows a switch while the panel is open", async () => {
    const { root } = await open();
    expect(root.textContent).toContain("Nodes");
    await setLanguage("fr");
    await flushPromises();
    expect(root.textContent).toContain("Nœuds");
    expect(root.textContent).toContain("Chaînes");
    expect(names(root)).toContain("Rayon X");
    const op = root.querySelector<HTMLElement>("[data-field=operation]")!;
    expect(op.textContent).toContain("Nouveau corps");
  });

  it("puts a refusal and the Error word in the language", async () => {
    await setLanguage("de");
    const { root } = await open(false, "x");
    expect(root.querySelector("[role=alert]")?.textContent).toBe("Fehler: x");
  });

  it("says a refused value as label and reason", async () => {
    await setLanguage("fr");
    const { root } = await open();
    const input = [...root.querySelectorAll<HTMLInputElement>(".ui-number-field input")].find(
      (el) => nameOf(el) === "Centre Z",
    )!;
    input.focus();
    input.value = "abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    const alerts = [...root.querySelectorAll("[role=alert]")].map((a) => a.textContent);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatch(/^Erreur : /);
  });
});

describe("a refusal is worded again after a switch", () => {
  it("keeps the label and reason and words them in the new language", async () => {
    const { root } = await open();
    const input = [...root.querySelectorAll<HTMLInputElement>(".ui-number-field input")].find(
      (el) => nameOf(el) === "Radius X",
    )!;
    input.focus();
    input.value = "-1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(root.querySelector("[role=alert]")?.textContent).toBe("Error: Radius X: A radius must be greater than 0");
    await setLanguage("de");
    await flushPromises();
    expect(root.querySelector("[role=alert]")?.textContent).toBe("Fehler: Radius X: Ein Radius muss größer als 0 sein");
  });
});

describe("a size on the canvas chip", () => {
  it("writes the decimal mark of the language", async () => {
    expect(sizeLabel(12.5)).toBe("12.5 mm");
    await setLanguage("de");
    expect(sizeLabel(12.5)).toBe("12,5 mm");
    expect(sizeLabel(30)).toBe("3 cm");
  });
});

describe("the Node body feature in the history", () => {
  it("is named in the language and in English for an English sentence", async () => {
    resetContributions();
    const off = await activate({ toolBusy: () => false } as unknown as Engine);
    try {
      await setLanguage("de");
      expect(featureMeta({ type: "organic" }).label).toBe("Knotenkörper");
      expect(featureEnglish({ type: "organic" })).toBe("Node body");
    } finally {
      off();
      resetContributions();
    }
  });
});

describe("the Node body feature rows follow the language", () => {
  it("lists the value rows, option labels and body row in the active language", async () => {
    const values = { nodes: [{ id: "n1" }] };
    const choice = NODE_CHOICE_FIELDS[0]!;
    expect(nodeNumFields(values)[0]![1]).toBe("Blend");
    expect(nodeNumFields(values).map(([, label]) => label)).toContain("n1 Turn Z");
    expect(choice.options.map((o) => o.label)).toEqual(["New body", "Join", "Cut", "Intersect"]);

    await setLanguage("de");
    expect(nodeNumFields(values)[0]![1]).toBe("Übergang");
    expect(nodeNumFields(values).map(([, label]) => label)).toContain("n1 Drehung Z");
    expect(choice.label).toBe("Operation");
    expect(choice.options.map((o) => o.label)).toEqual(["Neuer Körper", "Verbinden", "Ausschneiden", "Schnittmenge"]);
    expect(NODE_TARGETS[0]!.label).toBe("Bodies");

    await setLanguage("ja");
    expect(choice.label).toBe("操作");
    expect(choice.options.map((o) => o.label)).toEqual(["新しいボディ", "結合", "切り取り", "交差"]);
    expect(nodeNumFields(values).map(([, label]) => label)).toContain("n1 半径 X");
  });
});
