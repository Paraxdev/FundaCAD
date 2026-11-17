// The 3D view as a Tab stop: a keyboard reaches it, and a pointer press leaves focus where it always landed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCanvasStop } from "../../src/app/canvasPick";

let canvas: HTMLCanvasElement;
let field: HTMLInputElement;
let row: HTMLElement;

const press = (button = 0) => {
  const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button });
  canvas.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  document.body.innerHTML = `<input id="field" /><div id="row" tabindex="0" role="treeitem"></div>`;
  canvas = document.createElement("canvas");
  document.body.append(canvas);
  field = document.querySelector<HTMLInputElement>("#field")!;
  row = document.querySelector<HTMLElement>("#row")!;
  installCanvasStop(canvas);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("installCanvasStop", () => {
  it("makes the canvas one named Tab stop, a 3D view described by the hidden summary", () => {
    expect({
      tabIndex: canvas.tabIndex,
      role: canvas.getAttribute("role"),
      name: canvas.getAttribute("aria-label"),
      roleDescription: canvas.getAttribute("aria-roledescription"),
      describedBy: canvas.getAttribute("aria-describedby"),
    }).toEqual({ tabIndex: 0, role: "img", name: "Model", roleDescription: "3D view", describedBy: "view-summary" });
  });

  it("is never an application, which would switch off browse and rotor keys", () => {
    expect(canvas.closest("[role=application]")).toBeNull();
    expect(canvas.getAttribute("role")).not.toBe("application");
  });

  it.each([0, 1, 2])("a press with button %i takes focus from a field and leaves it on the body", (button) => {
    field.focus();
    expect(press(button).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("a press takes focus from a tree row and leaves it on the body", () => {
    row.focus();
    expect(press().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("a press with nothing focused stays on the body", () => {
    expect(press().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("a press keeps focus on a canvas that already has it", () => {
    canvas.focus();
    expect(press().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(canvas);
  });
});
