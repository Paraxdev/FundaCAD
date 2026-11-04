// Focus after a tool hangs on one line in mountUi and on the engine's own count of a tool at work, so both are held
// here: the order is read from the source, and the module runs on the engine's real toolAtWork.
import { afterEach, describe, expect, it } from "vitest";
import { createToolBusy } from "../../src/app/toolBusy";
import { installToolFocus } from "../../src/app/toolFocus";
import type { Engine } from "../../src/app/engine";

const engineSource = Object.values(
  import.meta.glob("../../src/app/engine.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
)[0]!;

afterEach(() => {
  document.body.innerHTML = "";
});

function mounted() {
  document.body.innerHTML = `
    <canvas id="view" tabindex="0"></canvas>
    <div role="listbox"><div role="option" id="row" tabindex="0">Straight edge 1</div></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const tools = new Proxy({} as Record<string, { active: boolean; picking: boolean }>, {
    get: (t, k: string) => (t[k] ??= { active: false, picking: false }),
  });
  const e = {
    sketch: { active: false, focusKeys: () => false },
    planePick: false,
    tools,
    viewport: { domElement: $("view") },
  };
  Object.assign(e, createToolBusy(e as unknown as Engine));
  const frames: (() => void)[] = [];
  const stop = installToolFocus(e as unknown as Engine, {
    frame: (fn) => frames.push(fn),
    cancelFrame: () => {},
  });
  const frame = () => frames.splice(0).forEach((fn) => fn());
  const key = () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  return { $, e, tools, frame, idle: () => (frame(), frame()), key, stop };
}

describe("tool focus wiring", () => {
  it("is installed in mountUi on the engine, after the canvas pick and before the keyboard", () => {
    const source = engineSource.replace(/\r/g, "");
    const mount = /export function mountUi\(e: Engine\): void \{\n([\s\S]*?)\n\}\n/.exec(source)![1]!;
    const pick = mount.indexOf("installCanvasPick(e);");
    const focus = mount.indexOf("installToolFocus(e);");
    expect(pick).toBeGreaterThanOrEqual(0);
    expect(focus).toBeGreaterThan(pick);
    expect(mount.indexOf("installKeyboard(e);")).toBeGreaterThan(focus);
    const busy = source.indexOf("Object.assign(e, createToolBusy(e));");
    expect(busy).toBeGreaterThanOrEqual(0);
    expect(busy).toBeLessThan(source.indexOf("export function mountUi"));
  });

  it("gives a Fillet started from a row back to that row, by the engine's count of a tool at work", () => {
    const t = mounted();
    t.$("row").focus();
    t.frame();
    t.key();
    t.tools.edgeFeature!.active = true;
    const box = document.body.appendChild(document.createElement("input"));
    box.focus();
    t.frame();
    t.tools.edgeFeature!.active = false;
    box.blur();
    box.remove();
    t.idle();
    expect(document.activeElement).toBe(t.$("row"));
    t.stop();
  });

  it("takes a sketch from a row to the 3D view and back to the row when it ends, a waiting Sketch first", () => {
    const t = mounted();
    t.$("row").focus();
    t.frame();
    t.key();
    t.e.planePick = true;
    t.frame();
    t.e.planePick = false;
    t.frame();
    t.e.sketch.active = true;
    t.frame();
    expect(document.activeElement).toBe(t.$("view"));
    t.e.sketch.active = false;
    t.idle();
    expect(document.activeElement).toBe(t.$("row"));
    t.stop();
  });
});
