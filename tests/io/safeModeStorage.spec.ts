import { describe, expect, it } from "vitest";
import script from "../../src-tauri/src/safe_mode_storage.js?raw";

describe("the safe mode localStorage", () => {
  it("reads defaults and never writes to the saved preferences", () => {
    const real = window.localStorage;
    real.setItem("fundacad.theme", "saved");
    try {
      new Function(script)();
      expect(window.localStorage).not.toBe(real);
      expect(localStorage.getItem("fundacad.theme")).toBeNull();
      localStorage.setItem("fundacad.theme", "safe");
      expect(localStorage.getItem("fundacad.theme")).toBe("safe");
      expect(localStorage.length).toBe(1);
      expect(localStorage.key(0)).toBe("fundacad.theme");
      localStorage.clear();
      expect(real.getItem("fundacad.theme")).toBe("saved");
    } finally {
      Object.defineProperty(window, "localStorage", { value: real, configurable: true });
      real.removeItem("fundacad.theme");
    }
  });
});
