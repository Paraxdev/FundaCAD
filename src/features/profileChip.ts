// The fillet's section shape, as a control that lives in the heads-up row
// beside the radius instead of floating in the viewport where the row could
// cover it. The chip draws the section it will build: drag it sideways to
// scrub, turn the wheel over it to step, click it for presets and a track.

import {
  PROFILE_DETENT,
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

function glyph(size: number): { svg: SVGSVGElement; set: (p: number) => void } {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("profile-glyph");
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
    this.chip = document.createElement("button");
    this.chip.type = "button";
    this.chip.className = "dim-btn profile-chip";
    this.chipGlyph = glyph(20);
    this.readout = document.createElement("span");
    this.readout.className = "profile-chip-value";
    this.chip.append(this.chipGlyph.svg, this.readout);
    this.el.appendChild(this.chip);
    this.wireScrub(this.chip, SCRUB_PX, () => this.toggleOpen());
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
    this.chip.title = `Profile ${formatProfile(this.value)}, ${describeProfile(this.value)}. Drag sideways or scroll to change, click for presets`;
    this.panelSync?.();
  }

  /** Drag on `target` moves the profile by fraction of `px` pixels; a press that
   *  never moved is a click. `start` lets the track jump to where it was pressed. */
  private wireScrub(
    target: HTMLElement,
    px: number,
    click: (() => void) | null,
    start?: (e: PointerEvent) => void,
  ) {
    target.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      hold(e);
      target.setPointerCapture(e.pointerId);
      start?.(e);
      const x0 = e.clientX;
      let f0 = fractionFromProfile(this.value);
      let moved = !!start;
      let last = x0;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        if (!moved) {
          moved = true;
          target.classList.add("scrubbing");
        }
        const dx = ev.clientX - last;
        last = ev.clientX;
        f0 += dx / (ev.shiftKey ? px * 4 : px);
        f0 = Math.max(0, Math.min(1, f0));
        this.change(profileFromFraction(f0));
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        target.classList.remove("scrubbing");
        if (!moved) click?.();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
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
    panel.addEventListener("pointerdown", hold);

    const head = document.createElement("div");
    head.className = "profile-panel-head";
    const title = document.createElement("span");
    title.textContent = "Profile";
    const val = document.createElement("span");
    val.className = "profile-panel-value";
    head.append(title, val);

    const presets = document.createElement("div");
    presets.className = "profile-presets";
    const buttons = PRESETS.map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "profile-preset";
      const g = glyph(28);
      g.set(p.value);
      const l = document.createElement("span");
      l.textContent = p.label;
      b.append(g.svg, l);
      b.title = `${p.label}, profile ${formatProfile(p.value)}`;
      b.addEventListener("pointerdown", (e) => {
        hold(e);
        this.change(p.value);
      });
      presets.appendChild(b);
      return { b, value: p.value };
    });

    const track = document.createElement("div");
    track.className = "profile-track";
    track.style.width = `${TRACK_PX}px`;
    const fill = document.createElement("div");
    fill.className = "profile-track-fill";
    const notch = document.createElement("div");
    notch.className = "profile-track-notch";
    const knob = document.createElement("div");
    knob.className = "profile-track-knob";
    track.append(fill, notch, knob);
    this.wireScrub(track, TRACK_PX, null, (e) => {
      const r = track.getBoundingClientRect();
      this.change(profileFromFraction((e.clientX - r.left) / r.width));
    });
    track.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    const ends = document.createElement("div");
    ends.className = "profile-track-ends";
    ends.innerHTML = "<span>chord</span><span>circle</span><span>sharp</span>";

    panel.append(head, presets, track, ends);
    this.el.appendChild(panel);
    this.panel = panel;
    this.chip.classList.add("open");

    this.panelSync = () => {
      val.textContent = `${formatProfile(this.value)} · ${describeProfile(this.value)}`;
      const f = fractionFromProfile(this.value);
      knob.style.left = `${f * 100}%`;
      fill.style.left = `${Math.min(f, 0.5) * 100}%`;
      fill.style.width = `${Math.abs(f - 0.5) * 100}%`;
      for (const { b, value } of buttons) {
        b.classList.toggle("active", Math.abs(value - this.value) < PROFILE_DETENT / 2);
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
      this.close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", esc, true);
    this.offDoc = () => {
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
    this.chip.classList.remove("open");
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
