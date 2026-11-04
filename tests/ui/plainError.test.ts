import { describe, expect, it } from "vitest";
import { looksInternal, plainError } from "../../src/ui/plainError";

const FALLBACK = "That did not work.";

describe("plainError keeps text that already reads plainly", () => {
  it("passes an engine feature message through", () => {
    expect(plainError(new Error("Profile is open"), FALLBACK)).toBe("Profile is open");
  });

  it("passes a Tauri string rejection through", () => {
    expect(plainError("the bundle has no manifest", FALLBACK)).toBe("the bundle has no manifest");
  });

  it("reads the message of a plain object", () => {
    expect(plainError({ message: "Disk is full", code: 28 }, FALLBACK)).toBe("Disk is full");
  });

  it("strips an Error prefix and keeps the first line only", () => {
    expect(plainError(new Error("Error: Sketch 3 is empty\nsecond line\nthird"), FALLBACK)).toBe("Sketch 3 is empty");
    expect(plainError("Error: Error: nested", FALLBACK)).toBe("Error: nested");
  });
});

describe("plainError replaces text that looks internal", () => {
  it.each([
    ["a JS exception name", new TypeError("x is undefined")],
    ["a named exception in a string", "TypeError: x is undefined"],
    ["a reference error", new ReferenceError("foo is not defined")],
    ["a failed property read", new Error("Cannot read properties of null (reading 'id')")],
    ["a stack line", "at foo (bar.js:1:2)"],
    ["an object string", "[object Object]"],
    ["an OCCT name", new Error("Standard_ConstructionError")],
    ["an OCCT name inside a sentence", "Failed: BRepAlgoAPI_Fuse gave nothing"],
    ["a Rust panic", "thread 'main' panicked at src/lib.rs:9:1"],
    ["a Rust path", "fundacad_engine::kernel::sew failed"],
    ["an object with no message", { code: 4 }],
    ["an object with a non text message", { message: 42 }],
    ["an empty string", ""],
    ["only blank lines", "  \n  "],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
  ])("%s gives the fallback", (_name, err) => {
    expect(plainError(err, FALLBACK)).toBe(FALLBACK);
  });

  it("keeps a first line of 160 characters and replaces 161", () => {
    const at160 = "a".repeat(160);
    expect(plainError(at160, FALLBACK)).toBe(at160);
    expect(plainError("a".repeat(161), FALLBACK)).toBe(FALLBACK);
  });

  it("measures the first line only, so a long stack under a short message still reads plainly", () => {
    expect(plainError(`Hole is too close to the edge\n${"x".repeat(500)}`, FALLBACK)).toBe(
      "Hole is too close to the edge",
    );
  });

  it("drops a stack under the message", () => {
    const stacked = new Error("Sketch 2 has no closed loop" + String.fromCharCode(10) + "    at foo (src/a.ts:41:7)");
    expect(plainError(stacked, FALLBACK)).toBe("Sketch 2 has no closed loop");
  });

  it("judges the first line, so an internal name on a later line does not hide a plain message", () => {
    expect(plainError("Could not read the file\nStandard_Failure", FALLBACK)).toBe("Could not read the file");
  });
});

describe("looksInternal", () => {
  it("is true for each kind and false for plain sentences", () => {
    expect(looksInternal("RangeError: Invalid array length")).toBe(true);
    expect(looksInternal("Radius must be above 0")).toBe(false);
    expect(looksInternal("Fillet 2 failed: the edge is too short")).toBe(false);
  });
});
