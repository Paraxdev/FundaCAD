import { afterEach, describe, expect, it } from "vitest";
import { inputModality, setInputModalityForTest, trackInputModality } from "../../src/ui/inputModality";

const click = (detail: number) => new CustomEvent("click", { detail });

describe("inputModality", () => {
  afterEach(() => setInputModalityForTest("pointer"));

  it("starts at pointer, so a popup opened before any input keeps today's focus", () => {
    expect(inputModality()).toBe("pointer");
  });

  it("follows the last keydown or pointer press on the tracked target", () => {
    const t = new EventTarget();
    const stop = trackInputModality(t);
    t.dispatchEvent(new Event("keydown"));
    expect(inputModality()).toBe("keyboard");
    t.dispatchEvent(new Event("pointerdown"));
    expect(inputModality()).toBe("pointer");
    t.dispatchEvent(new Event("keydown"));
    t.dispatchEvent(new Event("mousedown"));
    expect(inputModality()).toBe("pointer");
    stop();
  });

  it("counts a click with no press count as keyboard, and a real click as no change", () => {
    const t = new EventTarget();
    const stop = trackInputModality(t);
    t.dispatchEvent(new Event("pointerdown"));
    t.dispatchEvent(click(1));
    expect(inputModality()).toBe("pointer");
    t.dispatchEvent(click(0));
    expect(inputModality()).toBe("keyboard");
    stop();
  });

  it("tracks a target once, and stops listening when stopped", () => {
    const t = new EventTarget();
    const stop = trackInputModality(t);
    const again = trackInputModality(t);
    again();
    t.dispatchEvent(new Event("keydown"));
    expect(inputModality()).toBe("keyboard");
    stop();
    t.dispatchEvent(new Event("pointerdown"));
    expect(inputModality()).toBe("keyboard");
  });
});
