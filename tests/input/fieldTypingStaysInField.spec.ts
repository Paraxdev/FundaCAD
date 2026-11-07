// mcbc01y5: a body selection raises Move, whose value box takes focus. Ctrl+F from there never reached the
// command search, so the search text went into Move's box, and a raise while typing in another field took the
// rest of the typing.
import { afterEach, describe, expect, it } from "vitest";
import { DimInput, sparingFieldFocus } from "../../src/sketch/dimInput";

const FIELDS = [{ name: "move", label: "Move", kind: "length" as const }];
const off: (() => void)[] = [];

function press(target: EventTarget, key: string, mods: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(ev);
  return ev;
}
function typeInto(input: HTMLInputElement, text: string) {
  for (const ch of text) {
    if (document.activeElement !== input) return;
    press(input, ch);
    input.value += ch;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
  }
}
function raiseMove() {
  const dim = new DimInput();
  dim.show(
    FIELDS,
    () => {},
    () => dim.hide(),
  );
  return { dim, box: document.querySelector<HTMLInputElement>(".dim-input input")! };
}
function raiseMoveAsASelectionDoes() {
  let raised!: ReturnType<typeof raiseMove>;
  sparingFieldFocus(() => (raised = raiseMove()));
  return raised;
}
function field(name: string) {
  const input = document.createElement("input");
  input.setAttribute("aria-label", name);
  document.body.appendChild(input);
  input.focus();
  return input;
}
function heard() {
  const keys: string[] = [];
  const onKey = (e: KeyboardEvent) => keys.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.metaKey ? "Cmd+" : ""}${e.key}`);
  window.addEventListener("keydown", onKey);
  off.push(() => window.removeEventListener("keydown", onKey));
  return keys;
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("typing in a field never feeds a tool's value box", () => {
  afterEach(() => {
    off.splice(0).forEach((f) => f());
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const el of document.querySelectorAll(".dim-input, body > input")) el.remove();
  });

  it("Ctrl+F and Ctrl+K in Move's box reach the window, where the command search opens", () => {
    const { box } = raiseMove();
    expect(document.activeElement).toBe(box);
    const keys = heard();
    press(box, "f", { ctrlKey: true });
    press(box, "k", { ctrlKey: true });
    press(box, "f", { metaKey: true });
    expect(keys).toEqual(["Ctrl+f", "Ctrl+k", "Cmd+f"]);
  });

  it("a letter typed into Move's box still stays out of the shortcuts", () => {
    const { box } = raiseMove();
    const keys = heard();
    press(box, "e");
    expect(keys).toEqual([]);
  });

  it("a Parameters value keeps the typing when a selection raises Move", async () => {
    const value = field("width value");
    typeInto(value, "4");
    const { box } = raiseMoveAsASelectionDoes();
    expect(document.activeElement).toBe(value);
    await nextFrame();
    await nextFrame();
    typeInto(value, "2 mm");
    expect(value.value).toBe("42 mm");
    expect(box.value).not.toContain("2 mm");
  });

  it("a rename in the Items tree keeps the typing when a selection raises Move", async () => {
    const rename = field("Rename Box 1");
    const { box } = raiseMoveAsASelectionDoes();
    await nextFrame();
    typeInto(rename, "Lid");
    expect(rename.value).toBe("Lid");
    expect(document.activeElement).toBe(rename);
    expect(box.value).not.toContain("Lid");
  });

  it("Move started by hand still takes focus from a field", () => {
    field("width value");
    const { box } = raiseMove();
    expect(document.activeElement).toBe(box);
  });

  it("a raise with focus on the page still focuses Move's box", () => {
    const { box } = raiseMoveAsASelectionDoes();
    expect(document.activeElement).toBe(box);
  });
});
