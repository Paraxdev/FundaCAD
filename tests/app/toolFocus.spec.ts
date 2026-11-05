// Where focus goes when a tool or a sketch starts and ends: back to where focus was when keys started the tool and its own
// box dropped focus on the page, and to the sketch's key surface or the 3D view when a sketch starts from a list.
import { afterEach, describe, expect, it } from "vitest";
import { installToolFocus } from "../../src/app/toolFocus";
import { KeySurface } from "../../src/sketch/keySurface";

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  document.body.innerHTML = `
    <canvas id="view" tabindex="0"></canvas>
    <div role="listbox" id="list">
      <div role="option" id="row1" tabindex="-1">Edge 1</div>
      <div role="option" id="row2" tabindex="0">Edge 2</div>
    </div>
    <div role="tree"><div role="treeitem" id="plane" tabindex="0">XY plane</div></div>
    <button id="rail">Fillet</button>
    <label>Size at least <input id="size" /></label>
    <div role="dialog" id="palette"><input id="search" /></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const keys = new KeySurface();
  const host = {
    tool: false,
    sketch: { active: false, focusKeys: () => keys.focus() },
    toolAtWork: () => host.tool || host.sketch.active,
    viewport: { domElement: $("view") },
  };
  const frames = new Map<number, () => void>();
  let ids = 0;
  const stop = installToolFocus(host, {
    frame: (fn) => (frames.set(++ids, fn), ids),
    cancelFrame: (id) => frames.delete(id),
  });
  const frame = () => {
    const due = [...frames.values()];
    frames.clear();
    due.forEach((fn) => fn());
  };
  const idle = () => (frame(), frame());
  const key = () => (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  // A browser fires pointerdown before it moves focus.
  const click = (id: string) => {
    $(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    $(id).focus();
  };
  // The tool's box takes focus and is removed with the tool.
  const startTool = (by: "key" | "pointer" = "key") => {
    if (by === "key") key();
    else document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
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
  // As sketchMode: the surface is a Tab stop while Line, Rectangle or Circle is armed, and goes with the sketch.
  const sketch = (on: boolean, armed = true) => {
    if (on) {
      keys.mount(document.body);
      keys.setStop(armed);
    } else {
      if (document.activeElement === surface()) surface()!.blur();
      keys.dispose();
    }
    host.sketch.active = on;
  };
  const surface = () => document.querySelector<HTMLElement>("[data-key-surface]");
  return { $, host, frame, idle, key, click, startTool, endTool, stop, keys, sketch, surface };
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
    expect(document.activeElement).toBe(document.body);
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  // A picker stands down in the frame of a click and hands the pick on in the next, as a sketch opening on a face.
  it("gives nothing back when another tool starts the frame after one ends", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.startTool();
    t.frame();
    t.endTool();
    t.frame();
    t.host.sketch.active = true;
    t.frame();
    t.frame();
    expect(document.activeElement).toBe(document.body);
  });

  // Keys can outrun the frames, a test driver's always do.
  it("goes back to a row focused and left between two frames", () => {
    const t = setup();
    t.$("rail").focus();
    t.frame();
    t.$("row2").focus();
    t.$("search").focus();
    t.$("row2").focus();
    t.startTool();
    t.frame();
    t.endTool();
    t.idle();
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
    t.idle();
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
    t.idle();
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
    t.idle();
    expect(document.activeElement).toBe(t.$("rail"));
  });

  it("goes back to the control a pointer started the tool from when its box leaves focus on the page", () => {
    const t = setup();
    t.$("rail").focus();
    t.frame();
    t.startTool("pointer");
    t.frame();
    t.endTool();
    t.idle();
    expect(document.activeElement).toBe(t.$("rail"));
  });

  it("goes to the 3D view after a tool a pointer started from the page", () => {
    const t = setup();
    t.startTool("pointer");
    t.frame();
    t.endTool();
    t.idle();
    expect(document.activeElement).toBe(t.$("view"));
  });

  it("stays where a pointer took it when the tool ends", () => {
    const t = setup();
    t.$("rail").focus();
    t.frame();
    t.startTool("pointer");
    t.frame();
    t.endTool();
    t.click("row1");
    t.idle();
    expect(document.activeElement).toBe(t.$("row1"));
  });

  it("goes back to a row a pointer focused when keys start the tool from the palette", () => {
    const t = setup();
    t.click("row2");
    t.frame();
    t.key();
    t.$("search").focus();
    t.frame();
    t.key();
    // The palette gives focus back as it closes.
    t.$("row2").focus();
    t.startTool();
    t.frame();
    t.endTool();
    t.idle();
    expect(document.activeElement).toBe(t.$("row2"));
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
    t.idle();
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
    t.idle();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("focus when a sketch starts", () => {
  it("goes to the sketch's key surface from a list, whose type ahead would take the sketch's keys", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.sketch(true);
    t.frame();
    expect(document.activeElement).toBe(t.surface());
  });

  it("goes to the 3D view from a list while no draw tool makes the surface a Tab stop", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.sketch(true, false);
    t.frame();
    expect(document.activeElement).toBe(t.$("view"));
  });

  it("goes to the 3D view from a list when the sketch has no surface", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.host.sketch.active = true;
    t.frame();
    expect(document.activeElement).toBe(t.$("view"));
  });

  it("goes to the sketch's key surface from a text field, which would take the sketch's letters", () => {
    const t = setup();
    t.$("size").focus();
    t.frame();
    t.key();
    t.sketch(true);
    t.frame();
    expect(document.activeElement).toBe(t.surface());
  });

  it("goes to its own sketch's key surface, not to another tool's earlier in the page", () => {
    const t = setup();
    const other = new KeySurface();
    other.mount(document.body, "Extrude");
    other.setStop(true);
    t.$("row2").focus();
    t.frame();
    t.sketch(true);
    t.frame();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Sketch");
    other.dispose();
  });

  it("stays on a button, which leaves letters to the shortcuts", () => {
    const t = setup();
    t.$("rail").focus();
    t.frame();
    t.sketch(true);
    t.frame();
    expect(document.activeElement).toBe(t.$("rail"));
  });

  it("is moved once, a person may Tab back to the list during the sketch", () => {
    const t = setup();
    t.sketch(true);
    t.frame();
    t.$("row2").focus();
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });
});

describe("focus when a sketch ends", () => {
  const sketchFrom = (t: ReturnType<typeof setup>, id: string, armed = true) => {
    t.$(id).focus();
    t.frame();
    t.key();
    t.sketch(true, armed);
    t.frame();
    expect(document.activeElement).toBe(armed ? t.surface() : t.$("view"));
  };

  it("goes back to the plane row it started from, once idle holds two frames", () => {
    const t = setup();
    sketchFrom(t, "row2");
    t.sketch(false);
    t.frame();
    expect(document.activeElement).toBe(document.body);
    t.frame();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  it("goes back to the row from the key surface or the 3D view, if focus is still there", () => {
    for (const armed of [true, false]) {
      const t = setup();
      sketchFrom(t, "row2", armed);
      t.host.sketch.active = false;
      t.idle();
      expect(document.activeElement).toBe(t.$("row2"));
      t.stop();
    }
  });

  it("leaves focus on the surface the sketch's own keys gave it, and gives the row back after", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.key();
    t.sketch(true);
    t.keys.focus();
    t.frame();
    expect(document.activeElement).toBe(t.surface());
    t.sketch(false);
    t.idle();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  it("goes back to the face row a waiting Sketch took", () => {
    const t = setup();
    t.$("row2").focus();
    t.frame();
    t.key();
    t.host.tool = true;
    t.frame();
    t.host.tool = false;
    t.frame();
    t.sketch(true);
    t.frame();
    expect(document.activeElement).toBe(t.surface());
    t.sketch(false);
    t.idle();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  // A mouse user's next letter is a tool key, which the list would take as type ahead.
  it("gives nothing back to a plane row a click started it from, it stays in the 3D view", () => {
    for (const armed of [true, false]) {
      const t = setup();
      t.click("row2");
      t.sketch(true, armed);
      t.frame();
      expect(document.activeElement).toBe(armed ? t.surface() : t.$("view"));
      t.key();
      t.sketch(false);
      t.idle();
      expect(document.activeElement).toBe(t.$("view"));
      t.stop();
    }
  });

  it("goes back to an Items tree plane row", () => {
    const t = setup();
    sketchFrom(t, "plane");
    t.sketch(false);
    t.idle();
    expect(document.activeElement).toBe(t.$("plane"));
  });

  it("goes to the list's tab stop when a build replaced the row", () => {
    const t = setup();
    sketchFrom(t, "row1");
    t.$("row1").remove();
    t.sketch(false);
    t.idle();
    expect(document.activeElement).toBe(t.$("row2"));
  });

  it("stays where the person took focus during the sketch", () => {
    const t = setup();
    sketchFrom(t, "row2");
    t.$("rail").focus();
    t.sketch(false);
    t.idle();
    expect(document.activeElement).toBe(t.$("rail"));
  });
});
