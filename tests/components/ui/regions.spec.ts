import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setShortcutOverrides } from "../../../src/input/shortcuts";

import {
  REGION_ORDER,
  currentRegion,
  cycleRegion,
  focusRegion,
  installRegionKeys,
  regionsInOrder,
  trackRegionFocus,
} from "../../../src/ui/regions";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const active = () => document.activeElement;
let stop: () => void = () => {};

beforeEach(() => {
  document.body.innerHTML = `
    <header id="titlebar"><button id="doc">Doc</button><nav id="menubar"><button id="file">File</button></nav></header>
    <div id="main">
      <div id="stage">
        <div id="viewport"></div>
        <aside id="browser"><button id="row1">Row 1</button><button id="row2">Row 2</button></aside>
        <div id="toolrail"><button id="sketch">Sketch</button></div>
        <section id="timeline"><button id="step">Step</button></section>
      </div>
    </div>
    <div class="ui-panel"><button id="p1">Panel 1</button></div>
    <div class="ui-panel"><span>No controls</span></div>`;
  stop = trackRegionFocus();
});
afterEach(() => stop());

const kinds = () => regionsInOrder().map((r) => r.kind);

describe("regionsInOrder", () => {
  it("lists what is on screen in F6 order, not document order", () => {
    expect(kinds()).toEqual(["menubar", "tools", "items", "viewport", "panel", "panel", "history"]);
    expect(REGION_ORDER.indexOf("tools")).toBeLessThan(REGION_ORDER.indexOf("items"));
  });

  it("skips inert, hidden and undisplayed regions", () => {
    $("#browser").setAttribute("inert", "");
    $("#timeline").hidden = true;
    $("#toolrail").style.display = "none";
    expect(kinds()).toEqual(["menubar", "viewport", "panel", "panel"]);
  });

  it("takes a part that opts in with data-region", () => {
    document.body.insertAdjacentHTML("beforeend", `<div data-region="render"><button>Go</button></div>`);
    expect(kinds()).toContain("render");
  });
});

describe("currentRegion", () => {
  it("is the innermost region, so a row counts as Items rather than the Model", () => {
    $("#row1").focus();
    expect(currentRegion()?.kind).toBe("items");
    expect(currentRegion()?.el).toBe($("#browser"));
  });

  it("is null when focus is in no region", () => {
    document.body.insertAdjacentHTML("beforeend", `<button id="loose">Loose</button>`);
    $("#loose").focus();
    expect(currentRegion()).toBeNull();
  });
});

describe("cycleRegion", () => {
  it("steps forward through every region and wraps", () => {
    $("#file").focus();
    const seen = [1, 2, 3, 4, 5, 6, 7].map(() => cycleRegion(1)?.kind);
    expect(seen).toEqual(["tools", "items", "viewport", "panel", "panel", "history", "menubar"]);
  });

  it("steps back and wraps from the first to the last", () => {
    $("#file").focus();
    expect(cycleRegion(-1)?.kind).toBe("history");
    expect(active()).toBe($("#step"));
    expect(cycleRegion(-1)?.kind).toBe("panel");
  });

  it("starts at the first or the last region when focus is in none", () => {
    expect(cycleRegion(1)?.kind).toBe("menubar");
    (active() as HTMLElement).blur();
    expect(cycleRegion(-1)?.kind).toBe("history");
  });

  it("enters the menu bar at the menu, not the first control of the title bar", () => {
    $("#step").focus();
    cycleRegion(1);
    expect(active()).toBe($("#file"));
  });

  it("lands on the region itself when it holds no control", () => {
    $("#p1").focus();
    cycleRegion(1);
    expect(active()).toBe(document.querySelectorAll(".ui-panel")[1]);
  });

  it("passes over a region that refuses focus", () => {
    $("#toolrail").innerHTML = `<button disabled>Off</button>`;
    const rail = $("#toolrail");
    rail.focus = () => {};
    $("#file").focus();
    expect(cycleRegion(1)?.kind).toBe("items");
  });

  it("does nothing when every region is inert behind a dialog", () => {
    for (const r of regionsInOrder()) r.el.setAttribute("inert", "");
    expect(cycleRegion(1)).toBeNull();
  });
});

describe("focusRegion", () => {
  it("returns to the control last focused in the region", () => {
    $("#row2").focus();
    $("#file").focus();
    cycleRegion(1);
    cycleRegion(1);
    expect(active()).toBe($("#row2"));
  });

  it("falls back to the first Tab stop when the remembered control went", () => {
    $("#row2").focus();
    $("#file").focus();
    $("#row2").remove();
    focusRegion({ kind: "items", el: $("#browser") });
    expect(active()).toBe($("#row1"));
  });

  it("does not follow a remembered control that moved out of the region", () => {
    $("#row2").focus();
    $("#toolrail").append($("#row2"));
    focusRegion({ kind: "items", el: $("#browser") });
    expect(active()).toBe($("#row1"));
  });

  it("lands the viewport on the Model landmark, never on a remembered control", () => {
    $("#row2").focus();
    $("#file").focus();
    focusRegion({ kind: "viewport", el: $("#main") });
    expect(active()).toBe($("#main"));
  });

  it("lands the viewport on the canvas once it is a Tab stop", () => {
    $("#viewport").innerHTML = `<canvas id="canvas" tabindex="0"></canvas>`;
    focusRegion({ kind: "viewport", el: $("#main") });
    expect(active()).toBe($("#canvas"));
  });

  it("keeps the canvas out while it is no Tab stop", () => {
    $("#viewport").innerHTML = `<canvas id="canvas" tabindex="-1"></canvas>`;
    focusRegion({ kind: "viewport", el: $("#main") });
    expect(active()).toBe($("#main"));
  });
});

describe("installRegionKeys", () => {
  let stopKeys: () => void = () => {};
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  beforeEach(() => {
    stopKeys = installRegionKeys(() => "model");
  });
  afterEach(() => {
    stopKeys();
    setShortcutOverrides([]);
  });

  it("moves one region per F6 and back with Shift+F6, the window keymap never seeing it", () => {
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    $("#file").focus();
    expect(press($("#file"), "F6").defaultPrevented).toBe(true);
    expect(active()).toBe($("#sketch"));
    press($("#sketch"), "F6", { shiftKey: true });
    expect(active()).toBe($("#file"));
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("works from a text field, which the keymap skips", () => {
    $("#browser").insertAdjacentHTML("afterbegin", `<input id="filter" />`);
    $("#filter").focus();
    press($("#filter"), "F6");
    expect(currentRegion()?.kind).toBe("viewport");
  });

  it("leaves an F6 another handler already claimed", () => {
    $("#file").addEventListener("keydown", (e) => e.preventDefault());
    $("#file").focus();
    press($("#file"), "F6");
    expect(active()).toBe($("#file"));
  });

  it("leaves other keys, and Alt or Ctrl with F6, to the keymap", () => {
    $("#file").focus();
    press($("#file"), "F5");
    press($("#file"), "F6", { altKey: true });
    press($("#file"), "F6", { ctrlKey: true });
    expect(active()).toBe($("#file"));
  });

  it("follows a remap, but a letter key still types into a text field", () => {
    setShortcutOverrides([{ action: "region-next", key: "j" }]);
    $("#file").focus();
    press($("#file"), "j");
    expect(active()).toBe($("#sketch"));
    $("#browser").insertAdjacentHTML("afterbegin", `<input id="filter" />`);
    $("#filter").focus();
    expect(press($("#filter"), "j").defaultPrevented).toBe(false);
    expect(active()).toBe($("#filter"));
  });

  it("stops listening once stopped", () => {
    stopKeys();
    $("#file").focus();
    press($("#file"), "F6");
    expect(active()).toBe($("#file"));
  });
});
