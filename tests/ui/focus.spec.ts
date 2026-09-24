// FI-2: undo/redo (or any global shortcut) must not stay swallowed forever by
// a field that lost its reason to hold focus, hidden or removed but still
// document.activeElement for one more frame.
import { describe, expect, it, afterEach } from "vitest";
import { isLiveFocusTarget, releaseStaleFocus } from "../../src/ui/focus";

describe("isLiveFocusTarget / releaseStaleFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("a plain visible, attached input is live", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(isLiveFocusTarget(input)).toBe(true);
    releaseStaleFocus();
    expect(document.activeElement).toBe(input); // untouched
  });

  it("a hidden (display:none) but still-focused input is not live, and gets released", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.style.display = "none";
    expect(isLiveFocusTarget(input)).toBe(false);
    releaseStaleFocus();
    expect(document.activeElement).not.toBe(input);
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

  it("releaseStaleFocus is a no-op with nothing focused, or focus already on body", () => {
    expect(() => releaseStaleFocus()).not.toThrow();
    document.body.focus();
    releaseStaleFocus();
    expect(document.activeElement).toBe(document.body);
  });
});
