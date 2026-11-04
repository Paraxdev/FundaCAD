import { describe, expect, it } from "vitest";
import { failedText, looksInternal, plainError, SEE_CONSOLE, sketchConflictText } from "../../src/ui/plainError";
import type { Feature } from "../../src/types";

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

const JOIN =
  "Join failed: the result came out smaller than the body it started from. That usually means the two shapes touch along a surface instead of overlapping. Move the profile so it reaches a little way into the body.";
const PATTERN =
  "Pattern: the copies overlap and could not be fused into one valid solid. Space them apart, or pattern the feature that made the detail instead of the whole body.";

describe("plainError keeps the engine's long sentences and names with underscores", () => {
  it.each([
    ["a 210 character join failure", JOIN],
    ["a 161 character pattern failure", PATTERN],
    ["an unknown parameter name", 'unknown parameter "Wall_Thick"'],
    ["a sketch named with an underscore", "Sketch_Profile is open"],
    ["a word that only starts like a kernel class", "Geometry_Cut needs a body"],
    ["a quoted list inside a sentence", 'Pick one of ["Top", "Front"]'],
  ])("%s reads plainly", (_name, text) => {
    expect(plainError(new Error(text), FALLBACK)).toBe(text);
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
    ["an OCCT failure class", "StdFail_NotDone raised in sweep"],
    ["an OCCT geometry class", "Geom_BSplineSurface has no poles"],
    ["an OCCT point class", "gp_Pnt out of range"],
    ["a JSON dump", '{"code":4,"message":"bad"}'],
    ["a JSON list", '  ["e1", "e2"]'],
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

  it("judges the first line, so a long stack under a short message still reads plainly", () => {
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

describe("failedText names the failed step once", () => {
  it.each([
    ["Fillet", "Fillet failed on Box: try a smaller value", "Fillet failed on Box: try a smaller value"],
    ["Pattern", PATTERN, PATTERN],
    ["Join", "join failed: the shapes only touch", "join failed: the shapes only touch"],
    ["Fillet 2", "Fillet failed on Body 3: radius 7.5 too large", "Fillet failed on Body 3: radius 7.5 too large"],
    ["Fillet", "radius 7.5 is too large for edge 4", "Fillet failed: radius 7.5 is too large for edge 4"],
    ["Fillet", "Filleted edges meet at a corner", "Fillet failed: Filleted edges meet at a corner"],
    ["Hole", "The Hole has no face to sit on", "Hole failed: The Hole has no face to sit on"],
    ["Shell", "Shell", "Shell"],
  ])("%s with %j", (label, raw, want) => {
    expect(failedText(label, raw)).toBe(want);
  });

  it("gives the step and the console for an internal or empty message", () => {
    const fallback = `Loft failed: the engine could not build it. ${SEE_CONSOLE}`;
    expect([failedText("Loft", "StdFail_NotDone"), failedText("Loft", ""), failedText("Loft", undefined)]).toEqual([
      fallback,
      fallback,
      fallback,
    ]);
  });
});

describe("sketchConflictText names the sketch as the History does", () => {
  const sketch = (id: string, name?: string) =>
    ({ id, type: "sketch", plane: "XZ", entities: [], name }) as unknown as Feature;
  const box = { id: "f2", type: "box", length: 12.5, width: 7.25, height: 3 } as unknown as Feature;

  it.each([
    ["f1", [sketch("f1")], "Sketch 1"],
    ["f3", [sketch("f1"), box, sketch("f3")], "Sketch 2"],
    ["f3", [sketch("f1"), box, sketch("f3", "Bracket outline")], "Bracket outline"],
    ["f9", [sketch("f1"), box], "a sketch"],
    ["f9", [], "a sketch"],
  ])("%s", (id, features, name) => {
    const text = sketchConflictText(id, features);
    expect({ named: text.includes(name), id: /f\d/.test(text) }).toEqual({ named: true, id: false });
  });
});
