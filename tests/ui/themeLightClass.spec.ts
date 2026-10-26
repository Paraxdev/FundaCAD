import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, setTheme } from "../../src/ui/theme";

const light = () => document.documentElement.classList.contains("theme-light");

afterEach(() => setTheme(DEFAULT_THEME_ID));

describe("light theme class", () => {
  it("marks the document while a light palette is on, so the paper cards apply", () => {
    setTheme("solarized-light");
    expect(light()).toBe(true);
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("clears it for a dark palette and for the built-in theme", () => {
    setTheme("solarized-light");
    setTheme("dracula");
    expect(light()).toBe(false);
    setTheme("solarized-light");
    setTheme(DEFAULT_THEME_ID);
    expect(light()).toBe(false);
  });
});
