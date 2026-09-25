// FI-2: undo/redo (or any global shortcut) must not stay swallowed by a field
// that no longer holds the typing: hidden, removed, or put away mid-keystroke.
import { describe, expect, it, afterEach } from "vitest";
import { isLiveFocusTarget } from "../../src/ui/focus";

describe("isLiveFocusTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("a plain visible, attached input is live", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(isLiveFocusTarget(input)).toBe(true);
  });

  it("an input that let go of focus is not live", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.blur();
    expect(isLiveFocusTarget(input)).toBe(false);
  });

  it("a hidden (display:none) but still-focused input is not live", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.style.display = "none";
    expect(isLiveFocusTarget(input)).toBe(false);
  });

  it("visibility:hidden is treated the same as display:none", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.style.visibility = "hidden";
    expect(isLiveFocusTarget(input)).toBe(false);
  });

  it("a detached (removed) element is never live", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.remove();
    expect(isLiveFocusTarget(input)).toBe(false);
  });
});
