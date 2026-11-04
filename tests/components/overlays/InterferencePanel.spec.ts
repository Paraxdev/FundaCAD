// A row click keeps the pair lit without selecting it, as a selection brings up the Move gizmo.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InterferencePanel from "../../../src/components/overlays/InterferencePanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

const clashes = [
  {
    key: "body3 body7",
    label: "Box and Box 2",
    v: "2.5 mm³ overlap",
    spoken: "Box and Box 2, overlap 2.5 mm³",
    a: "body3",
    b: "body7",
  },
  {
    key: "body7 body2",
    label: "Box 2 and Lid",
    v: "0.4 mm³ overlap",
    spoken: "Box 2 and Lid, overlap 0.4 mm³",
    a: "body7",
    b: "body2",
  },
];
const closePair = {
  key: "body2 body9",
  label: "Lid and Pin",
  v: "0.2 mm apart",
  spoken: "Lid and Pin, 0.2 mm apart",
  a: "body2",
  b: "body9",
};

function mountPanel() {
  const calls: unknown[][] = [];
  const viewportCalls: string[] = [];
  const engine = {
    ui: {
      panels: {
        highlightInterference: (a: string, b: string) => calls.push(["highlight", a, b]),
        previewInterference: (a: string | null, b?: string) => calls.push(["preview", a, b]),
        closeInterference: () => {},
        showInterference: async () => {},
      },
    },
    viewport: {
      policy: "faces",
      setSelectedBodies: () => viewportCalls.push("select"),
      setSelectPolicy: () => viewportCalls.push("policy"),
    },
  } as unknown as Engine;
  mount(InterferencePanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  usePanelsStore().showInterference({
    title: "Interference, 2 clashes",
    clashes,
    clearances: [closePair],
    unchecked: [],
  });
  return { calls, viewportCalls };
}

const rows = () => [...document.body.querySelectorAll<HTMLButtonElement>("button.clash-row")];

describe("InterferencePanel", () => {
  it("lists each pair as a button named in words, with the volume as its hint", async () => {
    mountPanel();
    await flushPromises();
    const r = rows();
    expect(r.map((x) => x.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(r.map((x) => x.getAttribute("aria-label"))).toEqual(clashes.map((c) => c.spoken));
    expect(r.map((x) => x.querySelector(".ui-list-row-label")?.textContent)).toEqual([
      "Box and Box 2",
      "Box 2 and Lid",
    ]);
    expect(r.map((x) => x.querySelector(".ui-list-row-hint")?.textContent)).toEqual([
      "2.5 mm³ overlap",
      "0.4 mm³ overlap",
    ]);
    expect(document.body.textContent).not.toMatch(/[∩↔]/);
    expect(document.body.querySelector("ul.clash-list[aria-label='Clashes']")?.querySelectorAll("li").length).toBe(2);
    expect(document.body.querySelector("ul[aria-label='Close pairs']")).toBeNull();
  });

  it("highlights the clicked pair through the panel controller and leaves the selection alone", async () => {
    const { calls, viewportCalls } = mountPanel();
    await flushPromises();
    const r = rows();
    r[1]!.click();
    r[0]!.click();
    expect(calls.filter((c) => c[0] === "highlight")).toEqual([
      ["highlight", "body7", "body2"],
      ["highlight", "body3", "body7"],
    ]);
    expect(viewportCalls).toEqual([]);
  });

  it("previews a pair on focus and on hover, and falls back to the focused row when the pointer leaves", async () => {
    const { calls } = mountPanel();
    await flushPromises();
    const r = rows();
    r[0]!.dispatchEvent(new FocusEvent("focus"));
    r[1]!.dispatchEvent(new Event("pointerenter"));
    r[1]!.dispatchEvent(new Event("pointerleave"));
    r[0]!.dispatchEvent(new FocusEvent("blur"));
    expect(calls).toEqual([
      ["preview", "body3", "body7"],
      ["preview", "body7", "body2"],
      ["preview", "body3", "body7"],
      ["preview", null, undefined],
    ]);
  });

  it("stops previewing a pressed row's focus until it is focused again", async () => {
    const { calls } = mountPanel();
    await flushPromises();
    const r = rows();
    r[0]!.dispatchEvent(new FocusEvent("focus"));
    r[0]!.click();
    r[0]!.dispatchEvent(new Event("pointerleave"));
    expect(calls.slice(1)).toEqual([
      ["highlight", "body3", "body7"],
      ["preview", null, undefined],
    ]);
  });

  it("marks only the kept pair as current, and lists the close pairs once clearance mode is on", async () => {
    mountPanel();
    usePanelsStore().interferenceLit = "body7 body2";
    await flushPromises();
    expect(rows().map((x) => x.getAttribute("aria-current"))).toEqual([null, "true"]);
    document.body.querySelector<HTMLInputElement>(".ui-checkbox input")!.click();
    await flushPromises();
    const all = rows();
    expect(all.length).toBe(3);
    expect(all[2]!.getAttribute("aria-label")).toBe("Lid and Pin, 0.2 mm apart");
    expect(all[2]!.getAttribute("aria-current")).toBeNull();
    expect(document.body.querySelector("ul[aria-label='Close pairs']")?.querySelectorAll("li").length).toBe(1);
  });

  it("rechecks with clearance on, and with a typed threshold only once it commits", async () => {
    const checks: (number | undefined)[] = [];
    const engine = {
      ui: {
        panels: {
          highlightInterference: () => {},
          closeInterference: () => {},
          showInterference: async (t?: number) => void checks.push(t),
        },
      },
    } as unknown as Engine;
    mount(InterferencePanel, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
    usePanelsStore().showInterference({ title: "Interference", clashes: [], clearances: [], unchecked: [] });
    await flushPromises();
    const box = document.body.querySelector<HTMLInputElement>(".ui-checkbox input")!;
    box.click();
    await flushPromises();
    expect(checks).toEqual([0.2]);
    const field = document.body.querySelector<HTMLInputElement>(".ui-number-field input")!;
    field.value = "0,5";
    field.dispatchEvent(new Event("input"));
    await flushPromises();
    expect(checks).toEqual([0.2]);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flushPromises();
    expect(checks).toEqual([0.2, 0.5]);
    expect(document.body.textContent).toContain("No pairs closer than 0.5 mm");
  });
});
