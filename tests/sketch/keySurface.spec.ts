import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeySurface } from "../../src/sketch/keySurface";
import { keyTargetFree } from "../../src/ui/focus";

const all = () => [...document.querySelectorAll<HTMLElement>("[data-key-surface]")];

beforeEach(() => {
  document.body.innerHTML = `<main id="main"><button id="b">B</button></main><span id="prompt">Prompt</span>`;
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("KeySurface", () => {
  it("is nothing until mounted, then one named application element in the Model area that reads the prompt", () => {
    const s = new KeySurface();
    expect(all()).toEqual([]);
    s.mount();
    const [el] = all();
    expect(all().length).toBe(1);
    expect(el!.parentElement?.id).toBe("main");
    expect(el!.getAttribute("role")).toBe("application");
    expect(el!.getAttribute("aria-label")).toBeTruthy();
    expect(el!.getAttribute("aria-describedby")).toBe("prompt");
    expect(el!.classList.contains("sr-only")).toBe(true);
  });

  it("mounting twice keeps one element", () => {
    const s = new KeySurface();
    s.mount();
    s.mount();
    expect(all().length).toBe(1);
  });

  it("falls back to the body when there is no Model area", () => {
    document.body.innerHTML = "";
    new KeySurface().mount();
    expect(all()[0]!.parentElement).toBe(document.body);
  });

  it("is a Tab stop only while told to be, before and after mounting, and focus is refused otherwise", () => {
    const s = new KeySurface();
    expect(s.focus()).toBe(false);
    s.setStop(true);
    s.mount();
    const el = all()[0]!;
    expect(el.tabIndex).toBe(0);
    s.setStop(false);
    expect(el.tabIndex).toBe(-1);
    expect(s.focus()).toBe(false);
    expect(document.activeElement).toBe(document.body);
    s.setStop(true);
    expect(s.focus()).toBe(true);
    expect(document.activeElement).toBe(el);
  });

  it("leaves no element behind, and a second mount after dispose is the only one", () => {
    const s = new KeySurface();
    s.mount();
    const first = all()[0]!;
    s.dispose();
    expect(all()).toEqual([]);
    expect(s.focus()).toBe(false);
    s.mount();
    expect(all().length).toBe(1);
    expect(all()[0]).not.toBe(first);
  });

  it("counts as the page for the key gate, a control beside it does not", () => {
    const s = new KeySurface();
    s.setStop(true);
    s.mount();
    expect(keyTargetFree(all()[0]!)).toBe(true);
    expect(keyTargetFree(document.getElementById("b"))).toBe(false);
  });
});
