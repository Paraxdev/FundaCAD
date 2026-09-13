import { describe, expect, it } from "vitest";
import { fallbackMenu } from "../../src/ui/contextMenuGuard";

describe("the right-click nobody claimed", () => {
  it("offers our own edit menu in a text field", () => {
    const input = document.createElement("input");
    input.value = "12.5";
    document.body.appendChild(input);
    input.setSelectionRange(0, 2);
    const items = fallbackMenu(input)!;
    expect(items.map((i) => i.label)).toEqual(["Cut", "Copy", "Paste", "", "Select all"]);
    expect(items.find((i) => i.label === "Copy")?.disabled).toBe(false);
    input.remove();
  });

  it("does not offer to cut or paste into a read-only field", () => {
    const input = document.createElement("input");
    input.readOnly = true;
    input.value = "x";
    const items = fallbackMenu(input)!;
    expect(items.find((i) => i.label === "Paste")?.disabled).toBe(true);
    expect(items.find((i) => i.label === "Cut")?.disabled).toBe(true);
  });

  it("shows nothing at all over anything else", () => {
    expect(fallbackMenu(document.createElement("div"))).toBeNull();
    expect(fallbackMenu(document.createElement("canvas"))).toBeNull();
  });
});
