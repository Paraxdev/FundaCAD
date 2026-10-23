import { describe, expect, it } from "vitest";
import { isEditableTarget } from "../../src/ui/focus";

const input = (type: string) => {
  const el = document.createElement("input");
  el.type = type;
  return el;
};

describe("isEditableTarget", () => {
  it.each(["text", "number", "search", "email", "password", "url", "tel"])("%s inputs take typed text", (t) => {
    expect(isEditableTarget(input(t))).toBe(true);
  });

  it.each(["checkbox", "radio", "range", "button", "color", "submit", "reset"])("%s inputs let sketch keys through", (t) => {
    expect(isEditableTarget(input(t))).toBe(false);
  });

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
});
