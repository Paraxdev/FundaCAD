// Under the browser build's root zoom the cursor and projected points are in window pixels while a style's left and
// top are scaled by the zoom, so a box placed at a point times the zoom has to land back on that point.

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../../src/ui/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));

import { InferTag, SnapTag } from "../../src/sketch/snapTag";
import { AreaBox } from "../../src/viewport/areaBox";
import { RotateDial } from "../../src/viewport/rotateDial";
import ProjectFilterBar from "../../src/components/overlays/ProjectFilterBar.vue";
import { useToolPanelStore } from "../../src/stores/toolPanels";

enableAutoUnmount(afterEach);

const Z = 1.75;
const px = (v: string) => parseFloat(v);

describe("boxes placed at a window point under the root zoom", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.style.zoom = String(Z);
  });
  afterEach(() => {
    document.documentElement.style.zoom = "";
  });

  it("puts the snap tag 12 by 26 pixels off the cursor", () => {
    new SnapTag().show("Endpoint", { x: 700, y: 350 });
    const el = document.querySelector<HTMLElement>('[data-testid="snap-tag"]')!;
    expect((px(el.style.left) - 12) * Z).toBeCloseTo(700, -0.5);
    expect((px(el.style.top) + 26) * Z).toBeCloseTo(350, -0.5);
  });

  it("puts the relation icons up and to the left of the cursor", () => {
    new InferTag().show(["horizontal"], ["horizontal"], { x: 700, y: 350 });
    const el = document.querySelector<HTMLElement>('[data-testid="infer-tag"]')!;
    expect((px(el.style.left) + 14) * Z).toBeCloseTo(700, -0.5);
    expect((px(el.style.top) + 34) * Z).toBeCloseTo(350, -0.5);
  });

  it("spans the area box from the press to the cursor", () => {
    const box = new AreaBox();
    box.show(350, 175, 700, 525, "window");
    const el = document.querySelector<HTMLElement>(".areabox")!;
    expect(px(el.style.left) * Z).toBeCloseTo(350);
    expect(px(el.style.top) * Z).toBeCloseTo(175);
    expect((px(el.style.left) + px(el.style.width)) * Z).toBeCloseTo(700);
    expect((px(el.style.top) + px(el.style.height)) * Z).toBeCloseTo(525);
    box.hide();
  });

  it("sets the rotate dial's badge on its projected point", () => {
    const dial = new RotateDial(new THREE.Vector3(0, 0, 1), 0xff0000);
    dial.placeLabel(() => ({ x: 700, y: 350 }));
    const el = document.querySelector<HTMLElement>(".rotate-dial-label")!;
    expect(px(el.style.left) * Z).toBeCloseTo(700);
    expect(px(el.style.top) * Z).toBeCloseTo(350);
    dial.dispose();
  });

  it("centres the Project filter bar under its anchor's top", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    mount(ProjectFilterBar, { global: { plugins: [pinia] } });
    useToolPanelStore().projectAnchor = { top: 350, left: 600, width: 200 } as DOMRect;
    await new Promise((r) => setTimeout(r));
    const el = document.querySelector<HTMLElement>(".project-filter-bar")!;
    expect((px(el.style.top) - 10) * Z).toBeCloseTo(350);
    expect((px(el.style.left) + el.offsetWidth / 2) * Z).toBeCloseTo(700);
  });
});
