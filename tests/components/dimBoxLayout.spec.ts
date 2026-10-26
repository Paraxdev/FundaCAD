// The compact value box: Tab walks the fields only, typing never resizes it, every option is one click, and it
// sits beside the point it measures, never over it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DimInput, type DimOption } from "../../src/sketch/dimInput";

let dim: DimInput;
beforeEach(() => {
  dim = new DimInput();
});
afterEach(() => {
  dim.dispose();
  document.body.innerHTML = "";
});

const root = () => document.querySelector<HTMLElement>(".dim-input")!;
const inputOf = (name: string) => root().querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;
const focusedField = () =>
  (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".dim-field")?.dataset.field;
const tab = (shift = false) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true }));
const click = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
function type(name: string, text: string) {
  const i = inputOf(name);
  i.value = text;
  i.dispatchEvent(new Event("input", { bubbles: true }));
}

const FIELDS = [
  { name: "size", label: "Size" },
  { name: "depth", label: "Depth" },
  { name: "x", label: "X" },
  { name: "y", label: "Y" },
];

describe("Tab order", () => {
  it("walks the fields in order and wraps, Shift+Tab walks back", () => {
    dim.show(FIELDS, () => {});
    const seen = [focusedField()];
    for (let i = 0; i < 4; i++) {
      tab();
      seen.push(focusedField());
    }
    expect(seen).toEqual(["size", "depth", "x", "y", "size"]);
    tab(true);
    expect(focusedField()).toEqual("y");
  });

  it("skips a hidden field and never lands on an option button", () => {
    dim.show(
      FIELDS,
      () => {},
      () => {},
      [
        {
          name: "kind",
          title: "Kind",
          chosen: "a",
          onChoose: () => {},
          segments: [{ id: "a", label: "A", icon: "plus" }],
        },
      ],
    );
    dim.setFieldHidden("x", true);
    const seen = [focusedField()];
    for (let i = 0; i < 3; i++) {
      tab();
      seen.push(focusedField());
    }
    expect(seen).toEqual(["size", "depth", "y", "size"]);
    const options = [...root().querySelectorAll<HTMLButtonElement>(".dim-opt")];
    expect(options.map((b) => b.tabIndex)).toEqual([-1]);
  });
});

describe("box size while typing", () => {
  it("keeps each field's width from the first digit to a signed decimal", () => {
    dim.show([{ name: "d", label: "D" }], () => {});
    dim.updateFromCursor({ d: 5 });
    const widths = ["1", "12", "12.5", "-12.75", ""].map((text) => {
      type("d", text);
      return inputOf("d").style.width;
    });
    expect(new Set(widths).size).toEqual(1);
  });
});

describe("every option one click away", () => {
  const segs = ["simple", "counterbore", "countersink", "insert"].map((id) => ({ id, label: id, icon: "plus" }));

  it("each segment is picked by one press from any other", () => {
    const picked: string[] = [];
    const options: DimOption[] = [
      { name: "type", title: "Type", chosen: "simple", segments: segs, onChoose: (id) => picked.push(id) },
    ];
    dim.show([{ name: "d", label: "D" }], () => {}, undefined, options);
    const button = (id: string) => root().querySelector(`[data-option="type"] [data-id="${id}"]`)!;
    for (const from of segs)
      for (const to of segs) {
        if (from.id === to.id) continue;
        dim.setOption("type", from.id);
        picked.length = 0;
        click(button(to.id));
        expect(picked).toEqual([to.id]);
        expect(dim.optionOf("type")).toEqual(to.id);
        expect(button(to.id).getAttribute("aria-checked")).toEqual("true");
      }
  });

  it("a switch and an action answer one press, with an icon and the name in the tooltip", () => {
    const seen: string[] = [];
    dim.show([{ name: "d", label: "D" }], () => {}, undefined, [
      {
        label: "Symmetric",
        title: "Both ways",
        icon: "symmetric",
        initial: false,
        onChange: (on) => seen.push(`sym ${on}`),
      },
      { name: "center", label: "Centre it", icon: "faceCenter", onPress: () => seen.push("center") },
    ]);
    const sw = root().querySelector<HTMLElement>(".dim-toggle")!;
    const act = root().querySelector<HTMLElement>('[data-option="center"]')!;
    click(sw);
    click(act);
    expect(seen).toEqual(["sym true", "center"]);
    expect([sw.title, act.title]).toEqual(["Both ways", "Centre it"]);
    expect([!!sw.querySelector("svg.icon"), !!act.querySelector("svg.icon")]).toEqual([true, true]);
    expect(sw.textContent).toEqual("Symmetric");
  });
});

describe("placement beside the cursor", () => {
  const size = (w: number, h: number) => {
    Object.defineProperty(root(), "offsetWidth", { configurable: true, value: w });
    Object.defineProperty(root(), "offsetHeight", { configurable: true, value: h });
  };

  it("sits below right of the point, and flips at the window's edges", () => {
    dim.show([{ name: "d", label: "D" }], () => {});
    size(200, 30);
    dim.position(100, 100);
    expect([root().style.left, root().style.top]).toEqual(["116px", "116px"]);
    dim.position(window.innerWidth - 50, window.innerHeight - 10);
    expect([root().style.left, root().style.top]).toEqual([
      `${window.innerWidth - 50 - 16 - 200}px`,
      `${window.innerHeight - 10 - 16 - 30}px`,
    ]);
  });
});
