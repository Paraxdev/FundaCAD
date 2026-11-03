// KB-4: a key a focused widget moves or types ahead with never reaches the global keymap, where an arrow turns the view
// and Home fits it; plain letters on a toolbar or tab button still start their tool.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installKeymap } from "../../src/input/keymap";
import { isMenuKey, widgetOwnsKey } from "../../src/ui/focus";

const actions: string[] = [];

function press(target: Element, key: string, init: KeyboardEventInit = {}, prevent = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  if (prevent) target.addEventListener("keydown", (ev) => ev.preventDefault(), { once: true });
  target.dispatchEvent(e);
  return e;
}

function inside(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector("[data-t]") as HTMLElement;
}

describe("the widget guard", () => {
  let off = () => {};
  beforeAll(() => {
    off = installKeymap(
      (a) => actions.push(a),
      () => "model",
    );
  });
  afterAll(() => off());
  afterEach(() => {
    actions.length = 0;
    document.body.innerHTML = "";
  });

  it.each([
    ["a menu", `<div role="menu"><div role="menuitem" tabindex="-1" data-t>Copy</div></div>`],
    ["a menubar", `<div role="menubar"><button role="menuitem" data-t>File</button></div>`],
    ["a slider", `<div role="slider" tabindex="0" aria-valuenow="2" data-t></div>`],
    ["a tablist", `<div role="tablist"><button role="tab" data-t>One</button></div>`],
    ["a radiogroup", `<div role="radiogroup"><button role="radio" data-t>Shaded</button></div>`],
    ["a native radio", `<input type="radio" data-t>`],
    ["a splitter", `<div role="separator" tabindex="0" data-t></div>`],
    ["a scrollbar", `<div role="scrollbar" tabindex="0" data-t></div>`],
    ["a toolbar", `<div role="toolbar"><button data-t>Extrude</button></div>`],
    ["a tree", `<ul role="tree"><li role="treeitem" tabindex="0" data-t>Body</li></ul>`],
    ["a listbox", `<ul role="listbox"><li role="option" tabindex="0" data-t>Steel</li></ul>`],
    ["a combobox", `<button role="combobox" data-t>Join</button>`],
    ["a range input", `<input type="range" data-t />`],
    ["a ui-menu", `<div class="ui-menu"><button data-t>Copy</button></div>`],
  ])("ArrowLeft in %s never turns the view", (_name, html) => {
    press(inside(html), "ArrowLeft");
    expect(actions).toEqual([]);
  });

  it("Home in a slider never fits the view", () => {
    press(inside(`<div role="slider" tabindex="0" data-t></div>`), "Home");
    expect(actions).toEqual([]);
  });

  it("a range input keeps its own arrow step", () => {
    const e = press(inside(`<input type="range" data-t />`), "ArrowRight");
    expect(e.defaultPrevented).toBe(false);
  });

  it("a key a widget already handled is skipped", () => {
    press(inside(`<div data-t tabindex="0"></div>`), "ArrowLeft", {}, true);
    expect(actions).toEqual([]);
  });

  it("E on a toolbar button still starts Extrude", () => {
    press(inside(`<div role="toolbar"><button data-t>Extrude</button></div>`), "e");
    expect(actions).toEqual(["extrude"]);
  });

  it("E on a tab still starts Extrude, a menu row types ahead instead", () => {
    press(inside(`<div role="tablist"><button role="tab" data-t>One</button></div>`), "e");
    expect(actions).toEqual(["extrude"]);
    actions.length = 0;
    press(inside(`<div role="menu"><div role="menuitem" tabindex="-1" data-t>Edit</div></div>`), "e");
    expect(actions).toEqual([]);
  });

  it("ArrowLeft on the page still turns the view", () => {
    press(document.body, "ArrowLeft");
    expect(actions).toEqual(["view-step-left"]);
  });

  it("Ctrl chords pass every widget", () => {
    press(inside(`<div role="menu"><div role="menuitem" tabindex="-1" data-t>Copy</div></div>`), "z", {
      ctrlKey: true,
    });
    expect(actions).toEqual(["undo"]);
  });
});

describe("isMenuKey", () => {
  function verdictOn(target: EventTarget, key: string, init: KeyboardEventInit = {}): boolean {
    let verdict: boolean | null = null;
    const listen = (e: Event) => {
      verdict = isMenuKey(e as KeyboardEvent);
    };
    window.addEventListener("keydown", listen, true);
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    window.removeEventListener("keydown", listen, true);
    return verdict!;
  }
  const heardOn = (html: string, key: string, init?: KeyboardEventInit) => {
    const verdict = verdictOn(inside(html), key, init);
    document.body.innerHTML = "";
    return verdict;
  };
  const LIST = `<div role="listbox"><div role="option" tabindex="0"><span data-t>Face 3</span></div></div>`;
  const MENU = `<div class="ui-menu"><button data-t>Copy</button></div>`;
  const OWN = ["Enter", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Tab", "f", "[", "]"];
  const NOT_OWN = ["Escape", "Delete", "Backspace", "F2", "PageDown"];

  it.each([
    ["a listbox row", LIST],
    ["a menu row", MENU],
  ])("gives %s its moving, running and typing keys, never Escape, Delete or an F key", (_name, html) => {
    expect(OWN.map((k) => heardOn(html, k))).toEqual(OWN.map(() => true));
    expect(NOT_OWN.map((k) => heardOn(html, k))).toEqual(NOT_OWN.map(() => false));
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }])("leaves %o chords to the tool", (mod) => {
    expect(heardOn(LIST, "Enter", mod)).toBe(false);
    expect(heardOn(LIST, "f", mod)).toBe(false);
  });

  it("keeps Shift and an arrow in the list, where it extends a selection", () => {
    expect(heardOn(LIST, "ArrowDown", { shiftKey: true })).toBe(true);
  });

  it.each([
    ["a plain button", `<button data-t>Fillet</button>`],
    ["an option outside a listbox", `<div role="option" tabindex="0" data-t>Face 3</div>`],
    ["a tree row", `<ul role="tree"><li role="treeitem" tabindex="0" data-t>Body</li></ul>`],
    ["a tab", `<div role="tablist"><button role="tab" data-t>Items</button></div>`],
  ])("gives nothing to %s", (_name, html) => {
    expect(heardOn(html, "Enter")).toBe(false);
  });

  it("gives nothing to the page, where a tool wants Enter", () => {
    expect(verdictOn(document.body, "Enter")).toBe(false);
  });
});

describe("widgetOwnsKey", () => {
  it("leaves Delete and Escape to the page outside a handled key", () => {
    document.body.innerHTML = `<ul role="tree"><li role="treeitem" tabindex="0" data-t>Body</li></ul>`;
    const row = document.querySelector("[data-t]") as HTMLElement;
    const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    row.dispatchEvent(del);
    expect(widgetOwnsKey(del)).toBe(false);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    tab.preventDefault();
    expect(widgetOwnsKey(tab)).toBe(true);
  });
});
