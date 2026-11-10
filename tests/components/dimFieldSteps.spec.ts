// Up and Down in a value box step the number as typing it would, so a value can be nudged without a pointer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimInput, stepValue, type DimFieldDef } from "../../src/sketch/dimInput";
import { setUnit } from "../../src/ui/units";
import { parseSizeText } from "../../src/features/sizeQuantity";

const said = vi.hoisted(() => [] as { text: string; priority: string }[]);
vi.mock("../../src/ui/announce", async (load) => ({
  ...(await load<typeof import("../../src/ui/announce")>()),
  announce: (text: string, priority = "polite") => said.push({ text, priority }),
}));

let dim: DimInput;

beforeEach(() => {
  setUnit("mm");
  said.length = 0;
  dim = new DimInput();
});
afterEach(() => {
  dim.dispose();
  setUnit("mm");
});

const root = () => document.querySelector<HTMLElement>(".dim-input")!;
const input = (i = 0) => root().querySelectorAll<HTMLInputElement>("input")[i]!;
const type = (text: string, i = 0) => {
  input(i).value = text;
  input(i).dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (k: string, mods: KeyboardEventInit = {}, i = 0) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  input(i).dispatchEvent(e);
  return e.defaultPrevented;
};
const stepped = (def: Partial<DimFieldDef> = {}) => {
  const commits: Record<string, number>[] = [];
  dim.show([{ name: "d", label: "Distance", step: (fine) => (fine ? 0.1 : 1), ...def }], (v) => commits.push(v));
  input().focus();
  return commits;
};

describe("stepValue", () => {
  it("moves a whole number of steps along the step's lattice", () => {
    expect([stepValue(12, 1, 1), stepValue(12, 1, -1), stepValue(5, 1, 10), stepValue(5, 1, -10)]).toEqual([
      13, 11, 15, -5,
    ]);
  });

  it("lands a value between steps on the next one, in the way of the key", () => {
    expect([stepValue(12.3, 1, 1), stepValue(12.3, 1, -1), stepValue(-2.5, 1, 1), stepValue(-2.5, 1, -1)]).toEqual([
      13, 12, -2, -3,
    ]);
  });

  it("is not thrown off a step by binary fractions", () => {
    expect([stepValue(0.3, 0.1, 1), stepValue(0.3, 0.1, -1), stepValue(0.7, 0.1, 1)]).toEqual([0.4, 0.2, 0.8]);
  });
});

describe("DimInput steps a value from the keyboard", () => {
  it("steps by one with Up and Down, by ten with Page Up and Page Down, and finer with Shift", () => {
    const commits = stepped();
    type("12");
    const seen: string[] = [];
    for (const [k, shift] of [
      ["ArrowUp", false],
      ["ArrowDown", false],
      ["PageUp", false],
      ["PageDown", false],
      ["ArrowUp", true],
      ["ArrowDown", true],
    ] as const) {
      expect(key(k, { shiftKey: shift })).toBe(true);
      seen.push(input().value);
    }
    expect(seen).toEqual(["13", "12", "22", "12", "12.1", "12"]);
    key("Enter");
    expect(commits).toEqual([{ d: 12 }]);
  });

  it("says each new value in words, and minus as a word", () => {
    stepped();
    type("0.5");
    key("ArrowUp");
    key("ArrowDown");
    key("ArrowDown");
    expect(said).toEqual([
      { text: "1 millimetre", priority: "polite" },
      { text: "0 millimetres", priority: "polite" },
      { text: "minus 1 millimetre", priority: "polite" },
    ]);
  });

  it("steps an empty field from 0", () => {
    stepped();
    expect(key("ArrowUp")).toBe(true);
    expect(input().value).toBe("1");
  });

  it("tells the tool as typing does, and the value counts as typed", () => {
    const heard: string[] = [];
    const commits: Record<string, number>[] = [];
    dim.show(
      [{ name: "d", label: "Distance", step: () => 1 }],
      (v) => commits.push(v),
      undefined,
      undefined,
      undefined,
      () => heard.push(input().value),
    );
    input().focus();
    key("ArrowUp");
    expect(heard).toEqual(["1"]);
    expect(dim.getValue("d")).toBe(1);
  });

  it("keeps Ctrl+Z after a step for the field, where the browser takes the step back", () => {
    let cancelled = 0;
    dim.show(
      [{ name: "d", label: "Distance", step: () => 1 }],
      () => {},
      () => cancelled++,
    );
    input().focus();
    key("ArrowUp");
    const heard: string[] = [];
    const hear = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", hear);
    key("z", { ctrlKey: true });
    window.removeEventListener("keydown", hear);
    expect({ cancelled, heard }).toEqual({ cancelled: 0, heard: [] });
  });

  it("refuses a step out of the field's range out loud and keeps the value", () => {
    stepped({ positive: true });
    type("1");
    expect(key("ArrowDown")).toBe(true);
    expect(input().value).toBe("1");
    expect(said).toEqual([{ text: "Distance must be more than 0", priority: "assertive" }]);
  });

  it("steps an inch field by an inch step, niced in inches", () => {
    setUnit("in");
    stepped({ step: (fine) => (fine ? 0.05 : 0.5) });
    type("1");
    key("ArrowUp");
    expect(input().value).toBe("1.02");
    key("ArrowUp", { shiftKey: true });
    expect(input().value).toBe("1.022");
  });

  describe("on a round face's size, whose typed prefix picks R, diameter or offset", () => {
    const size = () =>
      dim.show(
        [
          {
            name: "size",
            label: "R",
            step: () => 1,
            choices: {
              options: [
                { id: "radius", label: "R", word: "radius" },
                { id: "diameter", label: "Diameter", word: "diameter" },
                { id: "offset", label: "Offset", word: "offset" },
              ],
              chosen: "radius",
              read: (raw) => {
                const got = parseSizeText(raw);
                return got && { choice: got.quantity, text: got.text };
              },
              onChoose: () => {},
            },
          },
        ],
        () => {},
      );

    it("keeps the prefix and steps the number", () => {
      size();
      const seen: string[] = [];
      for (const typed of ["d5", "r2.5", "+0.5"]) {
        type(typed);
        key("ArrowUp");
        seen.push(input().value);
      }
      expect(seen).toEqual(["d6", "r3", "+1"]);
      key("ArrowDown");
      key("ArrowDown");
      expect(input().value).toBe("-1");
    });

    it("refuses to step a radius below 0, where the bare number would read as an offset", () => {
      size();
      type("1");
      key("ArrowDown");
      expect(input().value).toBe("0");
      expect(key("ArrowDown")).toBe(true);
      expect(input().value).toBe("0");
      expect(said.at(-1)).toEqual({ text: "R must be at least 0", priority: "assertive" });
    });
  });

  it("control: leaves a parameter expression, a free field and a field with no step alone", () => {
    stepped();
    type("width");
    expect(key("ArrowUp")).toBe(false);
    expect(input().value).toBe("width");
    dim.show([{ name: "s", label: "Size", free: true, step: () => 1 }], () => {});
    type("M6");
    expect(key("ArrowUp")).toBe(false);
    dim.show([{ name: "n", label: "Count", kind: "count" }], () => {});
    type("3");
    expect(key("ArrowUp")).toBe(false);
    expect(input().value).toBe("3");
    expect(said).toEqual([]);
  });

  it("control: leaves Up and Down with Ctrl or Alt to the box's other keys", () => {
    stepped();
    type("5");
    key("ArrowUp", { ctrlKey: true });
    expect(input().value).toBe("5");
    expect(key("ArrowDown", { altKey: true })).toBe(true);
    expect(document.querySelector(".dim-unit-menu")).not.toBeNull();
    expect(input().value).toBe("5");
  });
});

describe("DimInput names its step keys", () => {
  const hintOf = (i = 0) => {
    const ids = input(i).getAttribute("aria-describedby")!.split(" ");
    return document.getElementById(ids.at(-1)!)!;
  };

  it("describes a stepped field by its unit, then the keys and the steps they take", () => {
    stepped();
    const [chip, hint] = input().getAttribute("aria-describedby")!.split(" ");
    expect(chip).toMatch(/^dim-unit-\d+$/);
    expect(hint).toMatch(/^dim-steps-\d+$/);
    expect(hintOf().hidden).toBe(true);
    expect(hintOf().textContent).toBe(
      "Up and Down change it by 1 millimetre, by 0.1 millimetres with Shift, Page Up and Page Down by 10 millimetres",
    );
  });

  it("keeps the step keys after the reason a value is refused", () => {
    stepped({ positive: true });
    const [chip, hint] = input().getAttribute("aria-describedby")!.split(" ");
    type("-2");
    const problem = root().querySelector(".dim-problem")!.id;
    expect(input().getAttribute("aria-describedby")).toBe(`${chip} ${problem} ${hint}`);
    type("2");
    expect(input().getAttribute("aria-describedby")).toBe(`${chip} ${hint}`);
  });

  it("control: a field with no step is described by its unit alone", () => {
    dim.show([{ name: "r", label: "R" }], () => {});
    expect(input().getAttribute("aria-describedby")).toMatch(/^dim-unit-\d+$/);
  });
});
