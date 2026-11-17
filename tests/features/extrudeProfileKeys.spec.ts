// Extrude's pick phase by keys: Tab lights the profiles largest first without picking, Space adds, Enter takes the
// lit one, so a plate and the disc inside its hole can be told apart without a pointer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { circleLoop, rectCorners } from "../../src/sketch/region";
import { announce } from "../../src/ui/announce";
import { usePromptStore } from "../../src/stores/prompt";
import { claimEscape } from "../../src/ui/escapeClaim";

vi.mock("../../src/ui/announce", () => ({ announce: vi.fn() }));

interface Fake {
  region: {
    sketchId: string;
    loop: THREE.Vector2[];
    holes: THREE.Vector2[][];
    centroid: THREE.Vector2;
    interior: THREE.Vector2;
  };
  groupId?: string | undefined;
  name: string;
  plane: { n: THREE.Vector3; plane: THREE.Plane };
  interior3D: THREE.Vector3;
}
interface Internals {
  phase: string;
  active: boolean;
  selected: Fake[];
  regionUnder(x: number, y: number): Fake | null;
}

const tools: ExtrudeTool[] = [];
const v = (x: number, y: number) => new THREE.Vector2(x, y);
const plane = { n: new THREE.Vector3(0, 0, 1), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0) };

function fake(
  name: string,
  loop: THREE.Vector2[],
  holes: THREE.Vector2[][],
  at: THREE.Vector2,
  groupId?: string,
): Fake {
  return {
    name,
    groupId,
    plane,
    interior3D: new THREE.Vector3(at.x, at.y, 0),
    region: { sketchId: "f1", loop, holes, centroid: at, interior: at },
  };
}

// 40 x 20 plate at (5, -7) with a 10 mm hole at (25, 3), the disc in it, and a small 3 x 2 tab off to the side
const plate = () => fake("plate", rectCorners(5, -7, 40, 20), [circleLoop(25, 3, 5)], v(6, -6));
const disc = () => fake("disc", circleLoop(25, 3, 5), [], v(25, 3));
const tab = () => fake("tab", rectCorners(60, 1, 3, 2), [], v(61, 2));

function rig(regions: Fake[]) {
  const picked = new Set<Fake>();
  const group = (r: Fake) => (r.groupId === undefined ? [r] : regions.filter((x) => x.groupId === r.groupId));
  const hover = vi.fn();
  const overlay = {
    regions,
    update: vi.fn(),
    selectedRegions: () => regions.filter((r) => picked.has(r)),
    isRegionSelected: (r: Fake) => picked.has(r),
    toggleRegionSelection: vi.fn((r: Fake, additive: boolean) => {
      if (!additive) picked.clear();
      for (const m of group(r)) {
        if (additive && picked.has(m)) picked.delete(m);
        else picked.add(m);
      }
    }),
    setHoverRegion: hover,
    clearRegionSelection: () => picked.clear(),
  };
  const store = {
    document: { features: [{ id: "f1", type: "sketch" }] },
    buildState: { result: { mesh: { positions: [0, 0, 0] } } },
    nextId: () => "f9",
    hiddenBodyIds: () => undefined,
    boundExpr: () => null,
    addFeature: vi.fn(),
  };
  const canvas = document.createElement("canvas");
  const viewport = {
    domElement: canvas,
    suspendPicking: false,
    pixelWorldSize: () => 0.1,
    pointInSolid: () => false,
    requestRender: vi.fn(),
    setPeek: vi.fn(),
    removeFromScene: vi.fn(),
  };
  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  tools.push(tool);
  const done = vi.fn();
  const t = tool as unknown as Internals;
  return { tool, t, canvas, overlay, hover, done, start: () => tool.start(done) };
}

function press(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}
const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
  const proto = ExtrudeTool.prototype as unknown as { updatePreview(): void; positionDim(): void };
  vi.spyOn(proto, "updatePreview").mockImplementation(() => {});
  vi.spyOn(proto, "positionDim").mockImplementation(() => {});
});
afterEach(() => {
  for (const tool of tools.splice(0)) if ((tool as unknown as { active: boolean }).active) tool.cancel();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Tab in Extrude's pick", () => {
  it("lights the largest profile and says it, without picking anything", () => {
    const [p, d, s] = [plate(), disc(), tab()];
    const r = rig([d, s, p]);
    r.start();
    const e = press("Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(r.hover).toHaveBeenLastCalledWith(p);
    expect(r.t.selected).toEqual([]);
    expect(r.t.phase).toBe("pick");
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain("Profile 1 of 3");
    expect(said()[0]).toContain("1 hole");
    expect(r.overlay.toggleRegionSelection).not.toHaveBeenCalled();
  });

  it("walks to the disc, the tab, round to the plate, and back with Shift+Tab", () => {
    const [p, d, s] = [plate(), disc(), tab()];
    const r = rig([s, d, p]);
    r.start();
    const lit = () => r.hover.mock.calls.at(-1)![0];
    press("Tab");
    expect(lit()).toBe(p);
    press("Tab");
    expect(lit()).toBe(d);
    press("Tab");
    expect(lit()).toBe(s);
    press("Tab");
    expect(lit()).toBe(p);
    press("Tab", { shiftKey: true });
    expect(lit()).toBe(s);
    press("Tab", { shiftKey: true });
    expect(lit()).toBe(d);
    expect(said().map((t) => /^Profile (\d)/.exec(t as string)![1])).toEqual(["1", "2", "3", "1", "3", "2"]);
  });

  it("walks a single profile in place", () => {
    const only = tab();
    const r = rig([only]);
    r.start();
    press("Tab");
    press("Tab");
    press("Tab", { shiftKey: true });
    expect(r.hover.mock.calls.map((c) => c[0])).toEqual([only, only, only]);
    expect(said().every((t) => (t as string).includes("Profile 1 of 1"))).toBe(true);
  });

  it("is left to the page when the sketch has no profile, and with Ctrl or Alt", () => {
    const empty = rig([]);
    empty.start();
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(said()).toEqual([]);
    empty.tool.cancel();
    const r = rig([plate()]);
    r.start();
    expect(press("Tab", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("Tab", { altKey: true }).defaultPrevented).toBe(false);
    expect(said()).toEqual([]);
  });

  it("moves focus to a labelled surface, taken away with the tool", () => {
    const r = rig([plate(), disc()]);
    r.start();
    const button = document.body.appendChild(document.createElement("button"));
    button.focus();
    press("Tab");
    const surface = document.querySelector<HTMLElement>("[data-key-surface]")!;
    expect(document.activeElement).toBe(surface);
    expect(surface.getAttribute("aria-label")).toBe("Extrude");
    r.tool.cancel();
    expect(document.querySelector("[data-key-surface]")).toBeNull();
  });

  it("names Tab in the prompt", () => {
    rig([plate()]).start();
    expect(usePromptStore().text).toContain("Tab walks them");
  });
});

describe("Enter and Space in Extrude's pick", () => {
  it("Enter picks only the lit profile, so the disc stays out and the hole stays a hole", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([d, p]);
    r.start();
    press("Tab");
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(r.t.selected).toEqual([p]);
    expect(r.t.phase).toBe("drag");
    expect(r.overlay.toggleRegionSelection).toHaveBeenCalledTimes(1);
    expect(r.overlay.toggleRegionSelection).toHaveBeenCalledWith(p, false);
  });

  it("Enter takes the disc when Tab went one on", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([p, d]);
    r.start();
    press("Tab");
    press("Tab");
    press("Enter");
    expect(r.t.selected).toEqual([d]);
    expect(r.t.phase).toBe("drag");
  });

  it("Space adds, Tab, Space adds the next, and Enter goes on with both", () => {
    const [p, d, s] = [plate(), disc(), tab()];
    const r = rig([p, d, s]);
    r.start();
    press("Tab");
    expect(press(" ").defaultPrevented).toBe(true);
    expect(r.t.selected).toEqual([p]);
    expect(r.t.phase).toBe("pick");
    press("Tab");
    press(" ");
    expect(r.t.selected).toEqual([p, d]);
    expect(r.t.phase).toBe("pick");
    expect(said().at(-1)).toContain("2 of 3 picked");
    press("Enter");
    expect(r.t.selected).toEqual([p, d]);
    expect(r.t.phase).toBe("drag");
  });

  it("Space on a profile already picked takes it off again", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([p, d]);
    r.start();
    press("Tab");
    press(" ");
    press(" ");
    expect(r.t.selected).toEqual([]);
    expect(said().at(-1)).toContain("0 of 2 picked");
    expect(said().at(-2)).toContain("1 of 2 picked");
    expect(said().at(-1)).not.toContain(", picked");
  });

  it("Enter with nothing lit does nothing and stays in pick", () => {
    const r = rig([plate(), disc()]);
    r.start();
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(r.t.selected).toEqual([]);
    expect(r.t.phase).toBe("pick");
    expect(r.t.active).toBe(true);
    expect(said()).toHaveLength(1);
  });

  it("Space with nothing lit is left alone", () => {
    const r = rig([plate()]);
    r.start();
    const e = press(" ");
    expect(e.defaultPrevented).toBe(false);
    expect(r.t.selected).toEqual([]);
  });

  it("Enter with a selection goes on as before, whatever is lit", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([p, d]);
    r.start();
    press("Tab");
    press(" ");
    press("Tab");
    press("Enter");
    expect(r.t.selected).toEqual([p]);
    expect(r.t.phase).toBe("drag");
    expect(r.overlay.toggleRegionSelection).toHaveBeenCalledTimes(1);
  });

  it("takes the glyphs of one text together", () => {
    const g1 = fake("g1", rectCorners(0, 0, 3, 5), [], v(1, 1), "t");
    const g2 = fake("g2", rectCorners(5, 0, 3, 5), [], v(6, 1), "t");
    const big = fake("big", rectCorners(20, 20, 30, 30), [], v(21, 21));
    const r = rig([g1, big, g2]);
    r.start();
    press("Tab");
    press("Tab");
    expect(said().at(-1)).toContain("Profile 2 of 2");
    press("Enter");
    expect(r.t.selected).toEqual([g1, g2]);
  });
});

describe("a key that belongs to what has focus in Extrude's pick", () => {
  function pressOn(target: Element, key: string) {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }
  function place(html: string, selector: string) {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    return host.querySelector(selector)!;
  }
  const others = [
    ["a text field in the page", '<input id="t" type="text">', "#t"],
    ["a text field in the sketch area", '<main id="main"><input id="t" type="text"></main>', "#t"],
    ["a text area", '<textarea id="t"></textarea>', "#t"],
    ["a dialog's button", '<div role="dialog"><button id="t">OK</button></div>', "#t"],
    ["a button in the main area", '<main id="main"><button id="t">OK</button></main>', "#t"],
    ["a tree row", '<div role="tree"><div id="t" role="treeitem" tabindex="0">Plate</div></div>', "#t"],
  ] as const;

  it.each(others)("leaves Tab, Enter and Space to %s, nothing lit", (_n, html, selector) => {
    const r = rig([plate(), disc()]);
    r.start();
    const target = place(html, selector);
    for (const k of ["Tab", "Enter", " "]) expect(pressOn(target, k).defaultPrevented, k).toBe(false);
    expect(r.hover).not.toHaveBeenCalled();
    expect(r.t.selected).toEqual([]);
    expect(said()).toEqual([]);
  });

  it.each(others)("leaves Enter and Space to %s after a walk lit a profile", (_n, html, selector) => {
    const r = rig([plate(), disc()]);
    r.start();
    press("Tab");
    vi.mocked(announce).mockClear();
    const target = place(html, selector);
    for (const k of ["Enter", " "]) expect(pressOn(target, k).defaultPrevented, k).toBe(false);
    expect(r.t.phase).toBe("pick");
    expect(r.t.selected).toEqual([]);
    expect(said()).toEqual([]);
  });

  it("walks from a rail button by Tab, and leaves its Enter to the button", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([d, p]);
    r.start();
    const rail = place('<div class="tool-rail"><button id="t">Extrude</button></div>', "#t");
    expect(pressOn(rail, "Enter").defaultPrevented).toBe(false);
    expect(said()).toEqual([]);
    expect(pressOn(rail, "Tab").defaultPrevented).toBe(true);
    expect(r.hover).toHaveBeenLastCalledWith(p);
  });

  it("leaves all three alone while an open dialog claims Escape, and takes them again once it closed", async () => {
    const [p, d] = [plate(), disc()];
    const r = rig([d, p]);
    r.start();
    press("Tab");
    vi.mocked(announce).mockClear();
    const release = claimEscape();
    for (const k of ["Tab", "Enter", " "]) expect(press(k).defaultPrevented, k).toBe(false);
    expect(said()).toEqual([]);
    expect(r.t.selected).toEqual([]);
    release();
    await new Promise((f) => setTimeout(f, 0));
    expect(press(" ").defaultPrevented).toBe(true);
    expect(r.t.selected).toEqual([p]);
  });

  it("still takes them with focus on the page body", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([d, p]);
    r.start();
    for (const k of ["Tab", " "]) expect(pressOn(document.body, k).defaultPrevented, k).toBe(true);
    expect(r.t.selected).toEqual([p]);
  });
});

describe("a lit profile the regions were rebuilt from under", () => {
  function rebuilt() {
    const r = rig([plate(), disc()]);
    r.start();
    press("Tab");
    r.overlay.regions.splice(0, r.overlay.regions.length, plate(), disc());
    vi.mocked(announce).mockClear();
    return r;
  }

  it.each([" ", "Enter"])("makes %j say Tab lights one, and picks nothing stale", (k) => {
    const r = rebuilt();
    expect(press(k).defaultPrevented).toBe(true);
    expect(r.overlay.toggleRegionSelection).not.toHaveBeenCalled();
    expect(r.t.selected).toEqual([]);
    expect(r.t.phase).toBe("pick");
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain("Tab lights one");
  });

  it("lights the first of the new regions on the next Tab, and Space then adds it", () => {
    const r = rebuilt();
    press("Tab");
    const lit = r.overlay.regions[0]!;
    expect(r.hover).toHaveBeenLastCalledWith(lit);
    press(" ");
    expect(r.t.selected).toEqual([lit]);
  });
});

describe("Esc, the pointer and a second start", () => {
  it("Esc leaves the tool with nothing picked", () => {
    const r = rig([plate(), disc()]);
    r.start();
    press("Tab");
    press("Escape");
    expect(r.t.active).toBe(false);
    expect(r.done).toHaveBeenCalledWith(null);
    expect(r.t.selected).toEqual([]);
  });

  it("a pointer pick still works after a walk, and the walk begins again after a pointer move", () => {
    const [p, d] = [plate(), disc()];
    const r = rig([p, d]);
    r.start();
    press("Tab");
    press("Tab");
    vi.spyOn(r.tool as unknown as Internals, "regionUnder").mockReturnValue(p);
    r.canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 10 }));
    expect(r.hover).toHaveBeenLastCalledWith(p);
    r.hover.mockClear();
    press("Tab");
    expect(r.hover).toHaveBeenLastCalledWith(p);
    expect(said().at(-1)).toContain("Profile 1 of 2");
    r.canvas.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, cancelable: true }));
    expect(r.t.selected).toEqual([p]);
    expect(r.t.phase).toBe("drag");
  });

  it("a second start begins from the top", () => {
    const r = rig([plate(), disc()]);
    r.start();
    press("Tab");
    press("Tab");
    expect(said().at(-1)).toContain("Profile 2 of 2");
    r.tool.cancel();
    r.start();
    press("Tab");
    expect(said().at(-1)).toContain("Profile 1 of 2");
  });

  it("Enter right after a restart has nothing lit", () => {
    const r = rig([plate(), disc()]);
    r.start();
    press("Tab");
    r.tool.cancel();
    r.start();
    press("Enter");
    expect(r.t.phase).toBe("pick");
    expect(r.t.selected).toEqual([]);
  });
});
