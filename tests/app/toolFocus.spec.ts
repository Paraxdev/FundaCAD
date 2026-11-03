// Where focus goes when a tool or a sketch starts and ends: back to a keyboard user's place when the tool's own box drops
// it on the page, and to the 3D view when a sketch starts from a list.
import { afterEach, describe, expect, it } from "vitest";
import { installToolFocus } from "../../src/app/toolFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

function setup(shown = true) {
  document.body.innerHTML = `
    <canvas id="view" tabindex="0"></canvas>
    <div role="listbox" id="list">
      <div role="option" id="row1" tabindex="-1">Edge 1</div>
      <div role="option" id="row2" tabindex="0">Edge 2</div>
    </div>
    <button id="rail">Fillet</button>
    <div role="dialog" id="palette"><input id="search" /></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const host = {
    tool: false,
    sketch: { active: false },
    toolAtWork: () => host.tool || host.sketch.active,
    viewport: { domElement: $("view") },
  };
  const frames = new Map<number, () => void>();
  let ids = 0;
  const stop = installToolFocus(host, {
    frame: (fn) => (frames.set(++ids, fn), ids),
    cancelFrame: (id) => frames.delete(id),
    shown: () => shown,
  });
  const frame = () => {
    const due = [...frames.values()];
    frames.clear();
    due.forEach((fn) => fn());
  };
  // The tool's box takes focus and is removed with the tool.
  const startTool = () => {
    host.tool = true;
    const box = document.createElement("input");
    box.id = "box";
    document.body.append(box);
    box.focus();
  };
  // A browser drops focus on the body when the box goes, happy-dom may keep the removed box.
  const endTool = () => {
    host.tool = false;
    $("box").blur();
    $("box").remove();
  };
  return { $, host, frame, startTool, endTool, stop };
}

describe("focus after a tool", () => {
  it("goes back to the row a keyboard user started the tool from", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.startTool();
    t.frame();
    t.endTool();
    expect(document.activeElement).toBe(document.body);
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  it("passes over the palette the tool was started from, it is gone by then", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.$("search").focus();
    t.frame();
    t.startTool();
    t.$("palette").remove();
    t.frame();
    t.endTool();
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  it("goes to the list's tab stop when a build replaced the row", () => {
    const t = setup();
    t.$("row1").focus();
    t.frame();
    t.startTool();
    t.frame();
    t.$("row1").remove();
    t.endTool();
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  it("stays where the tool left it when that is not the page", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.startTool();
    t.frame();
    t.endTool();
    t.$("rail").focus();
    t.frame();
    expect(document.activeElement).toBe(t.$("rail"));
  });

  it("leaves focus a pointer put somewhere alone", () => {
    const t = setup(false);
    t.$("rail").focus();
    t.frame();
    t.startTool();
    t.frame();
    t.endTool();
    t.frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("gives nothing back when the tool started with focus on the page", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.$("row2").blur();
    t.frame();
    t.startTool();
    t.frame();
    t.endTool();
    t.frame();
    expect(document.activeElement).toBe(document.body);
  });

  it("does nothing once stopped", () => {
    const t = setup();
    t.stop();
    t.$("row2").focus();
    t.frame();
    t.startTool();
    t.frame();
    t.endTool();
    t.frame();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("focus when a sketch starts", () => {
  it("goes to the 3D view from a list, whose type ahead would take the sketch's keys", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.host.sketch.active = true;
    t.frame();
    expect(document.activeElement).toBe(t.$("view"));
  });

  it("stays on a button, which leaves letters to the shortcuts", () => {
    const t = setup();
    t.$("rail").focus();
    t.frame();
    t.host.sketch.active = true;
    t.frame();
    expect(document.activeElement).toBe(t.$("rail"));
  });

  it("is moved once, a person may Tab back to the list during the sketch", () => {
    const t = setup();
    t.host.sketch.active = true;
    t.frame();
    t.$("row2").focus();
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });
});
