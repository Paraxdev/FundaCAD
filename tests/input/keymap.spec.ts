// FI-2: a ghost field (hidden/detached but still document.activeElement)
// must not swallow Ctrl+Z/Ctrl+Y or any other shortcut forever; a genuinely
// live one still should, so ordinary typing is never hijacked.
import { describe, expect, it, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { installKeymap } from "../../src/input/keymap";
import ChoiceRow from "../../src/components/shell/ChoiceRow.vue";

function ctrlZ(target: EventTarget) {
  const e = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: target });
  window.dispatchEvent(e);
}

describe("installKeymap", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("a live, visible input still blocks the shortcut (normal typing is safe)", () => {
    const actions: string[] = [];
    installKeymap(
      (a) => actions.push(a),
      () => "model",
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    ctrlZ(input);
    expect(actions).toEqual([]);
  });

  it("a hidden ghost input is released and the shortcut still fires", () => {
    const actions: string[] = [];
    installKeymap(
      (a) => actions.push(a),
      () => "model",
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.style.display = "none"; // the tool that owned it hid it without removing it
    ctrlZ(input);
    expect(actions).toEqual(["undo"]);
    expect(document.activeElement).not.toBe(input); // and it let go of focus
  });

  it("a detached ghost input is released and the shortcut still fires", () => {
    const actions: string[] = [];
    installKeymap(
      (a) => actions.push(a),
      () => "model",
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.remove();
    ctrlZ(input);
    expect(actions).toEqual(["undo"]);
  });
  it("a focused choice row's typed letters search its list and start no tool", async () => {
    const actions: string[] = [];
    installKeymap(
      (a) => actions.push(a),
      () => "model",
    );
    const w = mount(ChoiceRow, {
      props: {
        label: "Operation",
        value: "join",
        options: [
          { value: "join", label: "Join" },
          { value: "cut", label: "Cut" },
        ],
        commit: () => {},
      },
      attachTo: document.body,
    });
    const trigger = w.get("[role=combobox]");
    (trigger.element as HTMLElement).focus();
    for (const key of ["j", "e", "c", "f", "Delete"]) await trigger.trigger("keydown", { key });
    expect([actions, trigger.attributes("aria-expanded")]).toEqual([[], "true"]);
    w.unmount();
  });
});
