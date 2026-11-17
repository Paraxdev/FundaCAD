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

  describe("the saved language", () => {
    const startSafe = (saved: Record<string, string>) => {
      const real = window.localStorage;
      for (const [k, v] of Object.entries(saved)) real.setItem(k, v);
      try {
        new Function(script)();
        return { real, safe: window.localStorage };
      } catch (e) {
        for (const k of Object.keys(saved)) real.removeItem(k);
        throw e;
      }
    };
    const restore = (real: Storage, saved: Record<string, string>) => {
      Object.defineProperty(window, "localStorage", { value: real, configurable: true });
      for (const k of Object.keys(saved)) real.removeItem(k);
    };

    it.each(["de", "system", "zh-TW", "es-419", "fil"])("keeps the saved pick %s", (code) => {
      const saved = { "fundacad.language": code, "fundacad.theme": "light", "fundacad.sidebar": '{"a":3}' };
      const { real, safe } = startSafe(saved);
      try {
        expect(safe.getItem("fundacad.language")).toBe(code);
        expect(safe.getItem("fundacad.theme")).toBeNull();
        expect(safe.getItem("fundacad.sidebar")).toBeNull();
        expect(safe.length).toBe(1);
        expect(safe.key(0)).toBe("fundacad.language");
      } finally {
        restore(real, saved);
      }
    });

    it("starts empty when no language was saved", () => {
      const saved = { "fundacad.theme": "light" };
      const { real, safe } = startSafe(saved);
      try {
        expect(safe.getItem("fundacad.language")).toBeNull();
        expect(safe.length).toBe(0);
      } finally {
        restore(real, saved);
      }
    });

    it.each([
      ["long text", "de".repeat(500)],
      ["a long code", "deutsch"],
      ["a lower case region", "de-at"],
      ["a region of one digit", "es-4"],
      ["JSON", '{"language":"de"}'],
      ["a script", "de<script>alert(1)</script>"],
      ["a path", "../../etc/de"],
      ["a trailing line", "de\n"],
      ["an empty value", ""],
      ["a capital code", "DE"],
    ])("does not copy a hostile value, %s", (_name, value) => {
      const saved = { "fundacad.language": value };
      const { real, safe } = startSafe(saved);
      try {
        expect(safe.getItem("fundacad.language")).toBeNull();
        expect(safe.length).toBe(0);
      } finally {
        restore(real, saved);
      }
    });

    it("copies no drop-in key", () => {
      const saved = {
        "fundacad.language": "pl",
        "fundacad.language.dropin.pl": '{"a":"b"}',
        "fundacad.language.dropin.de": "de",
      };
      const { real, safe } = startSafe(saved);
      try {
        expect(safe.getItem("fundacad.language.dropin.pl")).toBeNull();
        expect(safe.getItem("fundacad.language.dropin.de")).toBeNull();
        expect(safe.length).toBe(1);
      } finally {
        restore(real, saved);
      }
    });

    it("keeps writes in memory, including a changed language", () => {
      const saved = { "fundacad.language": "de", "fundacad.theme": "light" };
      const { real, safe } = startSafe(saved);
      try {
        safe.setItem("fundacad.language", "fr");
        safe.setItem("fundacad.other", "x");
        safe.removeItem("fundacad.language");
        safe.clear();
        expect(real.getItem("fundacad.language")).toBe("de");
        expect(real.getItem("fundacad.theme")).toBe("light");
        expect(real.getItem("fundacad.other")).toBeNull();
      } finally {
        restore(real, saved);
      }
    });
  });
});
