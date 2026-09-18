import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileChip } from "../../src/features/profileChip";

function pointer(type: string, target: EventTarget, clientX: number, shiftKey = false) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, shiftKey });
  Object.defineProperty(e, "pointerId", { value: 1 });
  target.dispatchEvent(e);
}

let chip: ProfileChip;
const onChange = vi.fn();

function mount(initial = 0) {
  onChange.mockReset();
  chip = new ProfileChip(initial, onChange);
  document.body.appendChild(chip.el);
  return chip.el.querySelector<HTMLButtonElement>(".profile-chip")!;
}

afterEach(() => chip.dispose());

describe("ProfileChip", () => {
  it("reads Round at the circular fillet and the signed value elsewhere", () => {
    expect(mount(0).textContent).toContain("Round");
    chip.dispose();
    expect(mount(0.5).textContent).toContain("+0.500");
  });

  it("scrubs sideways and settles in the detent on the way back", () => {
    const b = mount(0);
    pointer("pointerdown", b, 100);
    pointer("pointermove", b, 165);
    expect(chip.profile).toBeGreaterThan(0.4);
    pointer("pointermove", b, 101);
    expect(chip.profile).toBe(0);
    pointer("pointerup", b, 101);
    expect(onChange).toHaveBeenCalled();
    expect(chip.el.querySelector(".profile-panel")).toBeNull();
  });

  it("a click without movement opens the presets, and a preset applies", () => {
    const b = mount(0);
    pointer("pointerdown", b, 100);
    pointer("pointerup", b, 100);
    const presets = chip.el.querySelectorAll<HTMLButtonElement>(".profile-preset");
    expect(presets.length).toBe(5);
    pointer("pointerdown", presets[0]!, 0);
    expect(chip.profile).toBe(-0.9);
    expect(presets[0]!.classList.contains("active")).toBe(true);
  });

  it("Escape closes the panel before it reaches the tool", () => {
    const b = mount(0);
    pointer("pointerdown", b, 100);
    pointer("pointerup", b, 100);
    const tool = vi.fn();
    window.addEventListener("keydown", tool);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.removeEventListener("keydown", tool);
    expect(chip.el.querySelector(".profile-panel")).toBeNull();
    expect(tool).not.toHaveBeenCalled();
  });

  it("the wheel steps and lands on zero when it crosses it", () => {
    const b = mount(0.03);
    b.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
    expect(chip.profile).toBe(0);
    b.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    expect(chip.profile).toBeCloseTo(0.05);
  });
});
