import { describe, expect, it } from "vitest";
import { isEditableTarget, isPageSelectAll } from "../../src/ui/focus";

const input = (type: string) => {
  const el = document.createElement("input");
  el.type = type;
  return el;
};

describe("isEditableTarget", () => {
  it.each(["text", "number", "search", "email", "password", "url", "tel"])("%s inputs take typed text", (t) => {
    expect(isEditableTarget(input(t))).toBe(true);
  });

  it.each(["checkbox", "radio", "range", "button", "color", "submit", "reset"])(
    "%s inputs let sketch keys through",
    (t) => {
      expect(isEditableTarget(input(t))).toBe(false);
    },
  );

  it("still covers textarea, select and contentEditable, and ignores null and plain elements", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
    expect(isEditableTarget(div)).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("covers a Select trigger like the select it stands in for, since its typed letters search the list", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("role", "combobox");
    expect([isEditableTarget(trigger), isEditableTarget(document.createElement("button"))]).toEqual([true, false]);
  });

  it("keeps Ctrl+A on a Select trigger from selecting the whole page", () => {
    const trigger = document.createElement("button");
    trigger.setAttribute("role", "combobox");
    const e = new KeyboardEvent("keydown", { key: "a", ctrlKey: true });
    Object.defineProperty(e, "target", { value: trigger });
    expect(isPageSelectAll(e)).toBe(true);
  });
});
