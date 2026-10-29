// The fillet's section shape as a chip in the heads-up row beside the radius, where the row cannot cover it.

import {
  onActivate,
  setExpanded,
  setInvalid,
  setPressed,
  uiButton,
  uiNumberInput,
  uiSlider,
} from "../components/ui/dom";
import { claimEscape } from "../ui/escapeClaim";
import {
  PROFILE_DETENT,
  PROFILE_MAX,
  PROFILE_MIN,
  describeProfile,
  formatProfile,
  fractionFromProfile,
  profileFromFraction,
  sectionPath,
  snapProfile,
} from "./profileArcMath";

const SVG = "http://www.w3.org/2000/svg";

const PRESETS: { label: string; value: number }[] = [
  { label: "Flat", value: -0.9 },
  { label: "Soft", value: -0.5 },
  { label: "Round", value: 0 },
  { label: "Full", value: 0.5 },
  { label: "Tight", value: 0.9 },
];

/** Pixels of scrub for the whole range, Shift is four times finer. */
const SCRUB_PX = 260;
const TRACK_PX = 196;
/** Above the detent, so a key step off the circular fillet is not snapped back onto it. */
const SLIDER_STEP = 0.025;

let panels = 0;

/** The track runs -1..1 with the circular fillet at its centre and the profile's limits at its ends, as the old drag
 *  track did; a step lands on three decimals, which is all a profile shows. */
const toTrack = (p: number) => fractionFromProfile(p) * 2 - 1;
const fromTrack = (t: number) => Number(profileFromFraction((t + 1) / 2).toFixed(3));

function glyph(size: number): { svg: SVGSVGElement; set: (p: number) => void } {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("profile-glyph");
  svg.setAttribute("aria-hidden", "true");
  const corner = document.createElementNS(SVG, "path");
  corner.setAttribute("d", "M4 4 L20 4 L20 20");
  corner.classList.add("profile-glyph-corner");
  const solid = document.createElementNS(SVG, "path");
  solid.classList.add("profile-glyph-solid");
  const edge = document.createElementNS(SVG, "path");
  edge.classList.add("profile-glyph-edge");
  svg.append(corner, solid, edge);
  return {
    svg,
    set(p) {
      const d = sectionPath(p);
      edge.setAttribute("d", d);
      solid.setAttribute("d", `${d} L1 23 Z`);
    },
  };
}

function hold(e: Event) {
  e.preventDefault(); // keeps focus in the radius field, Enter still commits
  e.stopPropagation();
}

function name(p: number): string {
  return `Profile ${formatProfile(p)}, ${describeProfile(p)}`;
}

export class ProfileChip {
  readonly el: HTMLElement;
  private chip: HTMLButtonElement;
  private chipGlyph: ReturnType<typeof glyph>;
  private readout: HTMLElement;
  private panel: HTMLElement | null = null;
  private panelSync: (() => void) | null = null;
  private value = 0;
  private offDoc: (() => void) | null = null;

  constructor(
    initial: number,
    private onChange: (p: number) => void,
  ) {
    this.value = snapProfile(initial);
    this.el = document.createElement("div");
    this.el.className = "profile-chip-wrap";
    this.chip = uiButton({ variant: "ghost", size: "sm", label: "" });
    this.chip.classList.add("dim-btn", "profile-chip");
    setExpanded(this.chip, false);
    this.chipGlyph = glyph(20);
    this.readout = this.chip.querySelector(".btn-label")!;
    this.readout.classList.add("profile-chip-value");
    this.chip.prepend(this.chipGlyph.svg);
    this.el.appendChild(this.chip);
    this.wireScrub();
    this.chip.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.render();
  }

  get profile() {
    return this.value;
  }

  set(p: number) {
    const v = snapProfile(p);
    if (v === this.value) return;
    this.value = v;
    this.render();
  }

  private change(p: number) {
    const v = snapProfile(p);
    if (v === this.value) return;
    this.value = v;
    this.render();
    this.onChange(v);
  }

  private render() {
    this.chipGlyph.set(this.value);
    this.readout.textContent = this.value === 0 ? "Round" : formatProfile(this.value);
    this.chip.classList.toggle("on", this.value !== 0);
    this.chip.setAttribute("aria-label", name(this.value));
    this.chip.title = `${name(this.value)}. Drag sideways or scroll to change, click for presets`;
    this.panelSync?.();
  }

  /** Drag on the chip moves the profile; a press that never moved opens the panel, as does a click no press led to
   *  (Enter, Space, a screen reader). */
  private wireScrub() {
    const target = this.chip;
    // Set here as well as in the stylesheet, so a finger scrub never pans the page.
    target.style.touchAction = "none";
    let released = -Infinity;
    target.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      hold(e);
      target.setPointerCapture(e.pointerId);
      released = Infinity;
      const x0 = e.clientX;
      let f0 = fractionFromProfile(this.value);
      let moved = false;
      let last = x0;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        if (!moved) {
          moved = true;
          target.classList.add("scrubbing");
        }
        const dx = ev.clientX - last;
        last = ev.clientX;
        f0 += dx / (ev.shiftKey ? SCRUB_PX * 4 : SCRUB_PX);
        f0 = Math.max(0, Math.min(1, f0));
        this.change(profileFromFraction(f0));
      };
      const end = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", end);
        target.classList.remove("scrubbing");
        released = performance.now();
      };
      // Only a real release is a click; a cancelled pointer (the browser took the touch) opens nothing.
      const up = () => {
        end();
        if (!moved) this.toggleOpen();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", end);
    });
    target.addEventListener("click", () => {
      const pressed = performance.now() - released < 1000;
      released = -Infinity;
      if (!pressed) this.toggleOpen();
    });
  }

  private onWheel(e: WheelEvent) {
    hold(e);
    const step = e.shiftKey ? 0.01 : 0.05;
    const next = this.value + (e.deltaY < 0 ? step : -step);
    // Stepping across zero lands on it, the detent is too narrow to hit by steps.
    this.change(Math.sign(next) !== Math.sign(this.value) && this.value !== 0 ? 0 : next);
  }

  private toggleOpen() {
    if (this.panel) this.close();
    else this.open();
  }

  private open() {
    const panel = document.createElement("div");
    panel.className = "profile-panel";
    panel.id = `profile-panel-${++panels}`;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Profile");

    const head = document.createElement("div");
    head.className = "profile-panel-head";
    const title = document.createElement("span");
    title.className = "profile-panel-title";
    title.textContent = "Profile";
    const word = document.createElement("span");
    word.className = "profile-panel-value";
    word.id = `${panel.id}-word`;
    // Text, not decimal: a phone's decimal keypad has no minus key.
    const num = uiNumberInput({ tip: "Profile value", size: "sm", inputMode: "text", widthCh: 6 });
    num.root.classList.add("profile-number");
    num.input.setAttribute("aria-describedby", word.id);
    head.append(title, num.root, word);
    const typed = () => {
      const text = num.input.value.trim();
      const v = Number(text);
      if (!text || !Number.isFinite(v)) {
        setInvalid(num, `Type a profile from ${formatProfile(PROFILE_MIN)} to ${formatProfile(PROFILE_MAX)}`);
        return;
      }
      setInvalid(num, null);
      this.change(v);
      num.input.value = formatProfile(this.value);
    };
    num.input.addEventListener("change", typed);
    num.input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // The profile only: the radius box commits on its own field's Enter.
      e.preventDefault();
      e.stopPropagation();
      typed();
      num.input.select();
    });

    const presets = document.createElement("div");
    presets.className = "profile-presets";
    const buttons = PRESETS.map((p) => {
      const tip = `${p.label}, profile ${formatProfile(p.value)}`;
      const b = uiButton({ variant: "tile", label: p.label, pressed: false, tip });
      b.classList.add("profile-preset");
      const g = glyph(28);
      g.set(p.value);
      b.prepend(g.svg);
      onActivate(b, () => this.change(p.value));
      presets.appendChild(b);
      return { b, value: p.value };
    });

    const slider = uiSlider({
      value: toTrack(this.value),
      min: -1,
      max: 1,
      step: SLIDER_STEP,
      tip: "Profile",
      valueText: (t) => {
        const p = snapProfile(fromTrack(t));
        return `${formatProfile(p)}, ${describeProfile(p)}`;
      },
      onValue: (t) => this.change(fromTrack(t)),
    });
    slider.root.classList.add("profile-slider");
    slider.root.style.width = `${TRACK_PX}px`;
    slider.root.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    const ends = document.createElement("div");
    ends.className = "profile-track-ends";
    ends.setAttribute("aria-hidden", "true");
    ends.innerHTML = "<span>chord</span><span>circle</span><span>sharp</span>";

    // The slider and the field take focus and their own drag; a press anywhere else keeps the radius field's.
    panel.addEventListener("pointerdown", (e) => {
      const t = e.target as Node;
      if (slider.root.contains(t) || num.root.contains(t)) e.stopPropagation();
      else hold(e);
    });
    panel.append(head, presets, slider.root, ends);
    this.el.appendChild(panel);
    this.panel = panel;
    setExpanded(this.chip, true, panel.id);

    this.panelSync = () => {
      word.textContent = describeProfile(this.value);
      if (document.activeElement !== num.input) {
        num.input.value = formatProfile(this.value);
        setInvalid(num, null);
      }
      slider.set(toTrack(this.value));
      const at = fractionFromProfile(this.value) * 100;
      slider.input.style.setProperty("--profile-from", `${Math.min(at, 50)}%`);
      slider.input.style.setProperty("--profile-to", `${Math.max(at, 50)}%`);
      for (const { b, value } of buttons) {
        const on = Math.abs(value - this.value) < PROFILE_DETENT / 2;
        setPressed(b, on);
        b.classList.toggle("active", on);
      }
    };
    this.panelSync();

    const outside = (e: PointerEvent) => {
      if (!this.el.contains(e.target as Node)) this.close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the panel first, a second Esc cancels the tool as usual.
      e.preventDefault();
      e.stopImmediatePropagation();
      const within = this.el.contains(document.activeElement);
      this.close();
      if (within) this.chip.focus();
    };
    // Tools attached earlier hear the key first and ask escapeClaimed() before cancelling.
    const release = claimEscape();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", esc, true);
    this.offDoc = () => {
      release();
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", esc, true);
    };
  }

  close() {
    this.offDoc?.();
    this.offDoc = null;
    this.panel?.remove();
    this.panel = null;
    this.panelSync = null;
    setExpanded(this.chip, false);
  }

  setVisible(on: boolean) {
    if (this.el.hidden === !on) return;
    if (!on) this.close();
    this.el.hidden = !on;
  }

  dispose() {
    this.close();
    this.el.remove();
  }
}
