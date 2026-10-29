import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileChip } from "../../src/features/profileChip";
import { escapeClaimed } from "../../src/ui/escapeClaim";

function pointer(type: string, target: EventTarget, clientX: number, shiftKey = false) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, shiftKey });
  Object.defineProperty(e, "pointerId", { value: 1 });
  target.dispatchEvent(e);
}

let chip: ProfileChip;
const onChange = vi.fn();

const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const panel = () => chip.el.querySelector<HTMLElement>(".profile-panel");
const slider = () => chip.el.querySelector<HTMLInputElement>(".profile-slider input[type=range]")!;
const field = () => chip.el.querySelector<HTMLInputElement>(".profile-number input")!;

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

  it("names its value and its open state, and the panel is a named group", () => {
    const b = mount(0.5);
    expect(b.getAttribute("aria-label")).toBe("Profile +0.500, fuller");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    b.click();
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(b.getAttribute("aria-controls")).toBe(panel()!.id);
    expect(panel()!.getAttribute("role")).toBe("group");
    expect(panel()!.getAttribute("aria-label")).toBe("Profile");
    const full = [...chip.el.querySelectorAll(".profile-preset")].find((p) => p.textContent === "Full")!;
    expect(full.getAttribute("aria-pressed")).toBe("true");
    expect(chip.el.querySelector(".profile-glyph")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("a click with no press opens and closes the panel, a press's own click does not toggle it again", () => {
    const b = mount(0);
    b.click();
    expect(panel()).not.toBeNull();
    b.click();
    expect(panel()).toBeNull();
    pointer("pointerdown", b, 100);
    pointer("pointerup", b, 100);
    b.click();
    expect(panel()).not.toBeNull();
  });

  it("a preset applies from the keyboard or a screen reader's click", () => {
    mount(0).click();
    const soft = [...chip.el.querySelectorAll<HTMLButtonElement>(".profile-preset")].find(
      (p) => p.textContent === "Soft",
    )!;
    soft.click();
    expect(chip.profile).toBe(-0.5);
    expect(soft.getAttribute("aria-pressed")).toBe("true");
  });

  it("the slider steps by keys off the detent and speaks the value with its shape", () => {
    mount(0).click();
    expect(slider().getAttribute("aria-label")).toBe("Profile");
    expect(slider().getAttribute("aria-valuetext")).toBe("0, circular");
    key(slider(), "ArrowRight");
    expect(chip.profile).toBe(0.024);
    expect(onChange).toHaveBeenLastCalledWith(chip.profile);
    expect(slider().getAttribute("aria-valuetext")).toBe("+0.024, fuller");
    key(slider(), "Home");
    expect(chip.profile).toBe(-0.99);
    expect(slider().getAttribute("aria-valuetext")).toBe("-0.990, nearly a chamfer");
    key(slider(), "End");
    expect(chip.profile).toBe(0.95);
  });

  it("the slider's ends are the profile's limits, so End and Home put the thumb on the track's ends", () => {
    mount(0).click();
    const thumb = () => ({
      value: slider().value,
      from: slider().style.getPropertyValue("--profile-from"),
      to: slider().style.getPropertyValue("--profile-to"),
    });
    const centre = thumb();
    key(slider(), "End");
    const end = { profile: chip.profile, ...thumb() };
    key(slider(), "ArrowLeft");
    const stepBack = chip.profile;
    key(slider(), "Home");
    const home = { profile: chip.profile, ...thumb() };
    expect({ centre, end, stepBack, home }).toEqual({
      centre: { value: "0", from: "50%", to: "50%" },
      end: { profile: 0.95, value: "1", from: "50%", to: "100%" },
      stepBack: 0.926,
      home: { profile: -0.99, value: "-1", from: "0%", to: "50%" },
    });
  });

  it("the number field takes an exact value on Enter, clamps it, and refuses text", () => {
    mount(0).click();
    expect(field().getAttribute("aria-label")).toBe("Profile value");
    field().value = "0.3";
    expect(key(field(), "Enter")).toBe(false);
    expect(chip.profile).toBe(0.3);
    expect(field().value).toBe("+0.300");
    field().value = "2";
    key(field(), "Enter");
    expect(chip.profile).toBe(0.95);
    field().value = "round";
    key(field(), "Enter");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(chip.profile).toBe(0.95);
  });

  it("claims Escape while open, so a tool that asks leaves it, and gives focus back to the chip", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await tick(); // an earlier case's release lands after its event
    const b = mount(0);
    expect(escapeClaimed()).toBe(false);
    b.click();
    expect(escapeClaimed()).toBe(true);
    field().focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(b);
    await tick();
    expect(escapeClaimed()).toBe(false);
  });

  it("Escape after a pointer open leaves the focus where it was", () => {
    const b = mount(0);
    const other = document.body.appendChild(document.createElement("input"));
    other.focus();
    pointer("pointerdown", b, 100);
    pointer("pointerup", b, 100);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});
