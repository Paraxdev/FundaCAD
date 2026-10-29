// The compact value box: Tab walks the fields, options, Confirm and Cancel and then leaves, typing never resizes it,
// every option is one click, and it sits beside the point it measures, never over it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileChip } from "../../src/features/profileChip";
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
/** True when the box let the key through, so the browser moves focus on out of the box. */
const tab = (shift = false) =>
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true }),
  );
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
  it("walks the fields in order to Confirm, then lets Tab leave; Shift+Tab walks back", () => {
    dim.show(FIELDS, () => {});
    const seen = [stop()];
    for (let i = 0; i < 4; i++) {
      expect(tab()).toBe(false);
      seen.push(stop());
    }
    expect(seen).toEqual(["size", "depth", "x", "y", "confirm"]);
    expect(tab()).toBe(true);
    expect(stop()).toEqual("confirm");
    expect(tab(true)).toBe(false);
    expect(stop()).toEqual("y");
  });

  it("walks through a tool's extra control, and into its open panel, between the fields and Confirm", () => {
    const chip = new ProfileChip(0, () => {});
    const commits: unknown[] = [];
    dim.show(
      FIELDS.slice(0, 1),
      (v) => commits.push(v),
      () => {},
      undefined,
      chip.el,
    );
    const at = () => (document.activeElement as HTMLElement).className;
    expect(tab()).toBe(false);
    expect(at()).toContain("profile-chip");
    // Enter on the chip is the chip's own: the box neither commits nor prevents its click.
    expect(press("Enter")).toBe(true);
    expect(commits).toEqual([]);
    expect(tab()).toBe(false);
    expect(stop()).toBe("confirm");
    expect(tab(true)).toBe(false);
    (document.activeElement as HTMLElement).click();
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      expect(tab()).toBe(false);
      const el = document.activeElement as HTMLElement;
      seen.push(el.closest(".profile-number") ? "number" : el.closest(".profile-slider") ? "slider" : el.textContent!);
    }
    expect(seen).toEqual(["number", "Flat", "Soft", "Round", "Full", "Tight", "slider"]);
    expect(tab()).toBe(false);
    expect(stop()).toBe("confirm");
    chip.dispose();
  });

  it("lets Shift+Tab off the first field leave the box", () => {
    dim.show(FIELDS, () => {});
    expect(stop()).toEqual("size");
    expect(tab(true)).toBe(true);
    expect(stop()).toEqual("size");
  });

  it("skips a hidden field, stops once on each option, then on Confirm and Cancel, and leaves", () => {
    const { log } = showOptions();
    dim.setFieldHidden("x", true);
    const seen = [stop()];
    for (let i = 0; i < 7; i++) {
      expect(tab()).toBe(false);
      seen.push(stop());
    }
    expect(seen).toEqual(["size", "depth", "y", "kind:b", "toggle:Copy", "action:Centre", "confirm", "cancel"]);
    expect(tab()).toBe(true);
    expect(tab(true)).toBe(false);
    expect(stop()).toEqual("confirm");
    expect(tab(true)).toBe(false);
    expect(stop()).toEqual("action:Centre");
    expect(log).toEqual([]);
  });

  it("never stops on a unit chip or a choice tag", () => {
    dim.show(
      [
        {
          name: "size",
          label: "Size",
          choices: { chosen: "a", options: [{ id: "a", label: "A", word: "a" }], onChoose: () => {} },
        },
        { name: "depth", label: "Depth", kind: "length" },
      ],
      () => {},
    );
    expect(root().querySelector<HTMLElement>(".dim-choice")!.tabIndex).toBe(-1);
    expect(root().querySelector<HTMLElement>('.dim-field[data-field="depth"] .dim-unit')!.tabIndex).toBe(-1);
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
  if (el?.classList.contains("dim-ok")) return "confirm";
  if (el?.classList.contains("dim-no")) return "cancel";
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

describe("buttons from the base set", () => {
  const classes = (el: Element) => [...el.classList].sort();

  it("builds Confirm, Cancel and an option as IconButton sm plain under the dim classes, named by the bare word", () => {
    dim.show(
      FIELDS,
      () => {},
      () => {},
      [{ label: "Copy", title: "Copy", icon: "copy", initial: false, onChange: () => {} }],
    );
    const ok = root().querySelector(".dim-ok")!;
    const no = root().querySelector(".dim-no")!;
    const sw = root().querySelector(".dim-toggle")!;
    const base = ["dim-btn", "icon-btn", "icon-btn-plain", "icon-btn-sm"];
    expect(classes(ok)).toEqual([...base, "dim-end", "dim-ok"].sort());
    expect(classes(no)).toEqual([...base, "dim-no"].sort());
    expect(classes(sw)).toEqual([...base, "dim-opt", "dim-toggle"].sort());
    expect([ok, no, sw].map((b) => [b.getAttribute("aria-label"), b.getAttribute("title")])).toEqual([
      ["Confirm", "Confirm (Enter)"],
      ["Cancel", "Cancel (Esc)"],
      ["Copy", "Copy"],
    ]);
  });

  it("builds a switch with no icon as Button sm ghost showing its word, named by it", () => {
    dim.show(FIELDS, () => {}, undefined, [{ label: "Flip", title: "Flip it", initial: false, onChange: () => {} }]);
    const b = root().querySelector(".dim-toggle")!;
    expect(classes(b)).toEqual(["btn", "btn-ghost", "btn-sm", "dim-btn", "dim-opt", "dim-toggle", "dim-worded"]);
    expect([b.querySelector(".dim-word")?.textContent, b.hasAttribute("aria-label"), b.getAttribute("title")]).toEqual([
      "Flip",
      false,
      "Flip it",
    ]);
  });

  it("a screen reader's click acts once on a switch, an action and a segment", () => {
    const { log } = showOptions();
    for (const sel of [".dim-toggle", '[data-option="center"]', '.dim-segment[data-id="c"]'])
      root().querySelector<HTMLElement>(sel)!.click();
    expect(log).toEqual(["copy true", "centre", "kind c"]);
  });

  it("a press and the click its release sends act once", () => {
    const { log } = showOptions();
    const sw = root().querySelector<HTMLElement>(".dim-toggle")!;
    click(sw);
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    sw.click();
    expect(log).toEqual(["copy true"]);
  });

  it("cancels the release of a Space a switch acted on, so an engine's late click does not flip it back", () => {
    const { log } = showOptions();
    const sw = root().querySelector<HTMLElement>(".dim-toggle")!;
    sw.focus();
    press(" ");
    const up = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    sw.dispatchEvent(up);
    expect([log, up.defaultPrevented]).toEqual([["copy true"], true]);
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
