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

  it("skips a hidden field, then stops once on each option and wraps", () => {
    const { log } = showOptions();
    dim.setFieldHidden("x", true);
    const seen = [stop()];
    for (let i = 0; i < 6; i++) {
      tab();
      seen.push(stop());
    }
    expect(seen).toEqual(["size", "depth", "y", "kind:b", "toggle:Copy", "action:Centre", "size"]);
    tab(true);
    expect(stop()).toEqual("action:Centre");
    expect(log).toEqual([]);
  });

  it("skips a hidden option", () => {
    showOptions();
    dim.setOptionHidden("kind", true);
    dim.focusField("y");
    tab();
    expect(stop()).toEqual("toggle:Copy");
  });
});

/** Three fields' worth of tool: a segmented group with b chosen, a switch and an action. */
function showOptions() {
  const log: string[] = [];
  const commits: Record<string, number>[] = [];
  dim.show(
    FIELDS,
    (v) => commits.push(v),
    () => {},
    [
      {
        name: "kind",
        title: "Kind",
        chosen: "b",
        onChoose: (id) => log.push(`kind ${id}`),
        segments: ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), icon: "plus" })),
      },
      { label: "Copy", title: "Copy", icon: "copy", initial: false, onChange: (on) => log.push(`copy ${on}`) },
      { name: "center", label: "Centre", icon: "faceCenter", onPress: () => log.push("centre") },
    ],
  );
  return { log, commits };
}

function stop(): string | undefined {
  const el = document.activeElement as HTMLElement | null;
  if (el?.classList.contains("dim-segment")) return `kind:${el.dataset.id}`;
  if (el?.classList.contains("dim-toggle")) return `toggle:${el.textContent}`;
  if (el?.classList.contains("dim-action")) return `action:${el.textContent}`;
  return focusedField();
}

const press = (k: string) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("options from the keyboard", () => {
  it("arrows move and pick inside a segmented group, wrapping, and the group keeps one Tab stop", () => {
    const { log } = showOptions();
    dim.focusField("y");
    tab();
    press("ArrowRight");
    expect(stop()).toEqual("kind:c");
    press("ArrowRight");
    press("ArrowLeft");
    press("ArrowLeft");
    expect(stop()).toEqual("kind:b");
    expect(log).toEqual(["kind c", "kind a", "kind c", "kind b"]);
    const tabStops = [...root().querySelectorAll<HTMLElement>(".dim-segment")].map((b) => b.tabIndex);
    expect(tabStops).toEqual([-1, 0, -1]);
  });

  it("Space and Enter press a switch and an action; Enter on a segment and in a field commits", () => {
    const { log, commits } = showOptions();
    dim.focusField("y");
    tab();
    tab();
    press(" ");
    press("Enter");
    tab();
    press("Enter");
    expect(log).toEqual(["copy true", "copy false", "centre"]);
    tab(true);
    tab(true);
    press("Enter");
    expect(commits).toHaveLength(1);
    dim.focusField("size");
    press("Enter");
    expect(commits).toHaveLength(2);
  });

  it("a disabled segment ignores a press and the arrows skip it, its reason in the tooltip", () => {
    const { log } = showOptions();
    dim.setSegmentDisabled("kind", "c", "out of reach on this edge");
    const c = root().querySelector<HTMLElement>('[data-id="c"]')!;
    expect([c.classList.contains("disabled"), c.getAttribute("aria-disabled"), c.title]).toEqual([
      true,
      "true",
      "C: out of reach on this edge",
    ]);
    click(c);
    dim.focusField("y");
    tab();
    press("ArrowRight");
    expect(stop()).toEqual("kind:a");
    dim.setSegmentDisabled("kind", "c", null);
    click(c);
    expect(log).toEqual(["kind a", "kind c"]);
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

  it("hangs the error line above a box that flipped above the point, below otherwise", () => {
    dim.show([{ name: "d", label: "D" }], () => {});
    size(200, 30);
    dim.position(100, window.innerHeight - 10);
    expect(root().classList.contains("dim-above")).toEqual(true);
    dim.position(100, 100);
    expect(root().classList.contains("dim-above")).toEqual(false);
  });

  it("clamps into a window too small for either side", () => {
    dim.show([{ name: "d", label: "D" }], () => {});
    size(window.innerWidth - 40, 30);
    dim.position(window.innerWidth / 2, 100);
    expect(root().style.left).toEqual("40px");
  });
});
