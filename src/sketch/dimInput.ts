// On-canvas heads-up dimension input: tracking fields follow the cursor, typing holds, Tab locks, Enter commits.
// Values cross this boundary in MILLIMETRES; length fields show and parse the display unit, angles are degrees.

import { iconElement } from "../ui/icons";
import { isHistoryKey } from "../ui/focus";
import { onPreviewError } from "../ui/previewError";
import { getUnit, parseField } from "../ui/units";
import { commonUnits, measureError, toUnit, tryParseMeasure, unitById, type UnitDef } from "../ui/measure";
import { valueProblem, type ValueRule } from "../document/numFields";
import { replayedPress } from "../viewport/navigator/input";

export interface DimFieldDef extends ValueRule {
  name: string;
  /** a short word, or the tooltip when `icon` is given */
  label: string;
  icon?: string;
  /** A letter shown after the icon, the axis of "Spacing X", or instead of a long label. */
  tag?: string;
  kind?: "length" | "angle" | "count"; // default length; count = raw number, no unit
  /** The tool reads the raw text itself (a size name, a parameter expression), so the box does not judge it. */
  free?: boolean;
  /** Words the tool reads itself besides a number ("through"): not judged, and getValue is null for them. */
  words?: RegExp;
  /** What the field reads, picked from a menu on its name; `label` and `icon` are the chosen one's. */
  choices?: DimChoices;
}

export interface DimChoice {
  id: string;
  /** the name tag, or its tooltip when `icon` is given */
  label: string;
  icon?: string;
  word: string;
}

/** The tool owns the choice, as with the toggle: this reports a pick, and `setChoice` follows other changes. */
export interface DimChoices {
  options: DimChoice[];
  chosen: string;
  /** Splits a choice written ahead of the number ("r2.5") from the number's text, null when the text names none. */
  read?: (raw: string) => { choice: string; text: string } | null;
  /** `typed` when the text picked it, so the tool leaves the text as it is. */
  onChoose: (id: string, typed: boolean) => void;
}

/** A switch for a mode the tool must offer while the value is set (Extrude's Symmetric): the focused field takes
 *  "1 1/2 in" and unit names, so no bare letter is free. The tool owns the state and syncs it with `setToggle`. */
export interface DimToggleDef {
  label: string;
  title: string;
  initial: boolean;
  onChange: (on: boolean) => void;
  /** Drawn as an icon switch whose label is its tooltip; without one the label is shown. */
  icon?: string;
}

export interface DimSegment {
  id: string;
  label: string;
  icon: string;
  /** Picks it while the tool runs; inside a value field it takes Alt, there the bare key is part of the number. */
  key?: string;
}

/** A choice of a few named values, each one click away. The tool owns the state, as with the toggle. */
export interface DimSegmentedDef {
  name: string;
  title: string;
  segments: DimSegment[];
  chosen: string;
  onChoose: (id: string) => void;
}

/** A one off verb beside the value, such as moving a hole to the face centre. */
export interface DimActionDef {
  name: string;
  label: string;
  icon: string;
  onPress: () => void;
}

export type DimOption = DimToggleDef | DimSegmentedDef | DimActionDef;

const isSegmented = (o: DimOption): o is DimSegmentedDef => "segments" in o;
const isAction = (o: DimOption): o is DimActionDef => "onPress" in o;

interface Segmented {
  def: DimSegmentedDef;
  el: HTMLElement;
  chosen: string;
}

interface Field {
  def: DimFieldDef;
  input: HTMLInputElement;
  /** The unit this field is SHOWING: the document's at first, then whatever the user types or picks on the chip.
   *  Per field, so a value entered in inches goes on reading in inches without changing the rest of the app. */
  unit: UnitDef | null;
  /** the clickable unit chip, or null for a count (which has no unit) */
  chip: HTMLButtonElement | null;
  tag: HTMLElement;
  choice: string | null;
  userDriven: boolean;
  /** In mm, the last valid value TYPED, never a seed: text that is no value reads as this one. */
  lastGood: number | null;
  /** Set only by a keystroke: an edit tool seeds and locks every field before the user touches any. */
  typed?: boolean;
  hidden?: boolean;
}

const shownBoxes = new Set<DimInput>();

/** The box holding a typed value not yet entered, or null. `confirm` enters it as Enter would, false when refused. */
export function typedDimBox(): { confirm(): boolean } | null {
  for (const box of shownBoxes) if (box.hasTyped()) return { confirm: () => box.confirmTyped() };
  return null;
}

function initialUnit(kind: DimFieldDef["kind"]): UnitDef | null {
  if (kind === "count") return null;
  return unitById(kind === "angle" ? "deg" : getUnit());
}

/** Confirm and cancel act on the press and the box goes with it, so the release landed on the canvas and selected
 *  the body under the button. That one release and its click go nowhere. */
export function swallowRelease(pointerId: number | undefined): void {
  const opts = { capture: true } as const;
  const stop = (ev: Event) => {
    const id = (ev as Partial<PointerEvent>).pointerId;
    if (ev.type === "pointerup" && typeof id === "number" && typeof pointerId === "number" && id !== pointerId) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    if (ev.type === "pointerup") setTimeout(done, 0);
    else done();
  };
  const done = () => {
    window.removeEventListener("pointerup", stop, opts);
    window.removeEventListener("click", stop, opts);
    window.removeEventListener("pointercancel", done, opts);
    window.removeEventListener("pointerdown", done, opts);
  };
  window.addEventListener("pointerup", stop, opts);
  window.addEventListener("click", stop, opts);
  // A release that never comes must not take the next press's with it.
  window.addEventListener("pointercancel", done, opts);
  window.addEventListener("pointerdown", done, opts);
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** px */
const PAST_GAP = 10;
/** px, from the cursor to the box's near corner */
const CURSOR_GAP = 16;
/** Holds "-12.75" with room to spare, so typing a usual number never resizes the box. */
const MIN_FIELD_CH = 7;

/** Past the tip along the arrow, else beside the tip, else behind the base, whichever first fits in `bounds`,
 *  clamped when none does. `dir` runs from base to tip in px. */
export function pastTip(
  tip: ScreenPoint,
  dir: ScreenPoint,
  size: { w: number; h: number },
  bounds: ScreenRect,
  gap = PAST_GAP,
): { left: number; top: number } {
  const n = Math.hypot(dir.x, dir.y);
  // An arrow end on to the view has no direction on screen, so the box goes where the cursor's would.
  const [dx, dy] = n > 1 ? [dir.x / n, dir.y / n] : [Math.SQRT1_2, Math.SQRT1_2];
  const { w, h } = size;
  // Out along the arrow only until the nearest edge clears the tip by `gap`, so a wide box does not slide far off.
  const place = (from: ScreenPoint, sx: number, sy: number) => {
    const reach = Math.min(
      Math.abs(sx) > 1e-9 ? (w / 2 + gap) / Math.abs(sx) : Infinity,
      Math.abs(sy) > 1e-9 ? (h / 2 + gap) / Math.abs(sy) : Infinity,
    );
    return { left: from.x + sx * reach - w / 2, top: from.y + sy * reach - h / 2 };
  };
  const base = { x: tip.x - (n > 1 ? dir.x : 0), y: tip.y - (n > 1 ? dir.y : 0) };
  const tries = [place(tip, dx, dy), place(tip, -dy, dx), place(tip, dy, -dx), place(base, -dx, -dy)];
  const fits = (p: { left: number; top: number }) =>
    p.left >= bounds.left && p.top >= bounds.top && p.left + w <= bounds.right && p.top + h <= bounds.bottom;
  const first = tries[0]!;
  return (
    tries.find(fits) ?? {
      left: Math.max(bounds.left, Math.min(first.left, bounds.right - w)),
      top: Math.max(bounds.top, Math.min(first.top, bounds.bottom - h)),
    }
  );
}

/** Past the model's right side, else left, else above, else below, whichever first fits, clamped when none does.
 *  The face under the box is where the next click goes, so over the model is the last resort. */
export function placeBeside(
  model: ScreenRect,
  anchor: ScreenPoint,
  size: { w: number; h: number },
  bounds: ScreenRect,
  gap = PAST_GAP,
): { left: number; top: number } {
  const { w, h } = size;
  const clampX = (x: number) => Math.max(bounds.left, Math.min(x, bounds.right - w));
  const clampY = (y: number) => Math.max(bounds.top, Math.min(y, bounds.bottom - h));
  const row = clampY(anchor.y - h / 2);
  const tries = [
    { left: model.right + gap, top: row },
    { left: model.left - gap - w, top: row },
    { left: clampX(anchor.x - w / 2), top: model.top - gap - h },
    { left: clampX(anchor.x - w / 2), top: model.bottom + gap },
  ];
  const fits = (p: { left: number; top: number }) =>
    p.left >= bounds.left && p.top >= bounds.top && p.left + w <= bounds.right && p.top + h <= bounds.bottom;
  return tries.find(fits) ?? { left: clampX(tries[0]!.left), top: row };
}

export class DimInput {
  private root: HTMLDivElement;
  private fields: Field[] = [];
  private onCommit: ((values: Record<string, number>) => void) | null = null;
  private onCancel: (() => void) | null = null;
  /** Fired on every keystroke, for a tool whose preview only refreshes on a pointer move and would go stale. */
  private onInput: (() => void) | null = null;
  private active = false;
  /** The kernel's refusal, drawn under the boxes: a tooltip needs a hover the hand cannot spare mid-drag. */
  private problem: HTMLDivElement | null = null;
  private unsubscribeError: (() => void) | null = null;
  /** The kernel's or tool's complaint; the box's own about typed text is shown first, the user can act on it. */
  private external: string | null = null;
  private typedProblem: string | null = null;
  private focusName: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "dim-input";
    this.root.style.display = "none";
    document.body.appendChild(this.root);
    window.addEventListener("pointerdown", this.boundForeignDown, true);
  }

  /** Takes the box out of hit testing during a drag that began elsewhere: the box is a sibling of the canvas, so
   *  crossing it stole pointermove from the tool. Keyed on where the press landed, so no tool has to opt in. */
  private boundForeignDown = (e: PointerEvent) => this.onForeignPress(e);
  private boundForeignUp = () => this.endForeignPress();
  private clickThrough = false;
  private foreignPress = false;

  private onForeignPress(e: PointerEvent) {
    // Not gated on `active`: the press that arms a tool also drags it, and shows the box after this listener ran.
    if (this.foreignPress) return;
    // A finger tap is replayed after it lifted, so no release would end it.
    if (replayedPress(e) === "tap") return;
    if (this.ownsTarget(e.target)) return;
    this.foreignPress = true;
    this.applyHitTesting();
    window.addEventListener("pointerup", this.boundForeignUp, true);
    window.addEventListener("pointercancel", this.boundForeignUp, true);
  }

  private endForeignPress() {
    window.removeEventListener("pointerup", this.boundForeignUp, true);
    window.removeEventListener("pointercancel", this.boundForeignUp, true);
    this.foreignPress = false;
    this.applyHitTesting();
  }

  private applyHitTesting() {
    this.root.style.pointerEvents = this.clickThrough || this.foreignPress ? "none" : "";
  }

  /** Frees the window listeners; tools keep one DimInput for life, so this is for tests and document teardown. */
  dispose() {
    this.hide();
    this.endForeignPress();
    window.removeEventListener("pointerdown", this.boundForeignDown, true);
    this.root.remove();
  }

  get isActive() {
    return this.active;
  }

  /** Lets the owning tool's capture-phase handler take Escape for its own box, not from other editors. */
  ownsTarget(el: EventTarget | null): boolean {
    return el instanceof Node && this.root.contains(el);
  }

  /** While a tool decides where to drop something, a click aimed at the canvas must pass through the box rather than
   *  hit confirm. Keystrokes are unaffected. Turn it off after the placing click, or confirm and cancel go dead. */
  setClickThrough(on: boolean) {
    this.clickThrough = on;
    this.applyHitTesting();
  }

  /** Outlives show() and hide(), for a box whose owner is drawn hidden. */
  setHidden(hidden: boolean) {
    this.root.style.visibility = hidden ? "hidden" : "";
  }

  show(
    defs: DimFieldDef[],
    onCommit: (values: Record<string, number>) => void,
    onCancel?: () => void,
    options?: DimOption | DimOption[],
    extra?: HTMLElement,
    onInput?: () => void,
  ) {
    this.hide();
    this.focusName = null;
    this.onInput = onInput ?? null;
    this.setClickThrough(false); // every other tool wants a clickable box
    this.onCommit = onCommit;
    this.onCancel = onCancel ?? null;
    this.active = true;
    shownBoxes.add(this);
    this.root.style.display = "flex";
    this.fields = defs.map((def) => {
      const wrap = document.createElement("label");
      wrap.className = "dim-field";
      wrap.dataset.field = def.name;
      const tag = document.createElement(def.choices ? "button" : "span");
      tag.className = def.choices ? "dim-name dim-unit dim-choice" : "dim-name";
      if (tag instanceof HTMLButtonElement) tag.type = "button";
      wrap.appendChild(tag);
      const input = document.createElement("input");
      input.type = "text";
      // NOT inputMode "decimal": that asks a touch keyboard for digits only, and
      // this field takes "1 1/2 in" and "width/2".
      input.inputMode = "text";
      input.autocomplete = "off";
      wrap.appendChild(input);

      const field: Field = {
        def,
        input,
        unit: initialUnit(def.kind),
        chip: null,
        tag,
        choice: def.choices?.chosen ?? null,
        userDriven: false,
        lastGood: null,
      };
      this.paintName(field);
      if (def.choices) {
        tag.addEventListener("pointerdown", (e) => {
          e.preventDefault(); // never blur the input to open the menu
          e.stopPropagation();
          this.openChoiceMenu(field);
        });
      }

      if (field.unit) {
        // The unit is a button: clicking it changes what the field shows without retyping the number.
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "dim-unit";
        chip.title = "Change unit";
        chip.textContent = field.unit.label;
        chip.addEventListener("pointerdown", (e) => {
          e.preventDefault(); // never blur the input to open the menu
          e.stopPropagation();
          this.openUnitMenu(field);
        });
        wrap.appendChild(chip);
        field.chip = chip;
      }

      this.root.appendChild(wrap);

      input.addEventListener("keydown", (e) => this.onKey(e, field));
      // A click into a value the tool wrote selects it, so typing replaces it; the release would drop the selection.
      let keepSelection = false;
      input.addEventListener("pointerdown", () => {
        keepSelection = !field.userDriven && document.activeElement !== input;
      });
      input.addEventListener("focus", () => {
        if (keepSelection) input.select();
      });
      input.addEventListener("mouseup", (e) => {
        if (keepSelection) e.preventDefault();
        keepSelection = false;
      });
      input.addEventListener("input", () => {
        field.userDriven = true; // typing freezes the field from cursor tracking
        field.typed = true;
        wrap.classList.add("typed");
        this.sizeToContent(field);
        this.adoptTypedUnit(field);
        this.adoptTypedChoice(field);
        const v = this.parse(field);
        if (v !== null && !this.rangeProblem(field.def, v)) field.lastGood = v;
        this.setTypedProblem(
          this.fieldProblem(field) ?? this.fields.map((x) => this.fieldProblem(x)).find(Boolean) ?? null,
        );
        this.onInput?.();
      });
      this.sizeToContent(field);
      return field;
    });
    if (extra) this.root.appendChild(extra);
    // The tool's options sit ahead of confirm and cancel: they change what is about to be committed.
    const opts = options === undefined ? [] : Array.isArray(options) ? options : [options];
    if (opts.length) {
      const group = document.createElement("div");
      group.className = "dim-opts";
      for (const o of opts) group.appendChild(this.optionElement(o));
      this.root.appendChild(group);
    }
    // Visible confirm and cancel for mouse-first work; pointerdown with preventDefault so they never blur the input.
    const ok = document.createElement("button");
    ok.className = "dim-btn dim-ok dim-end";
    ok.title = "Confirm (Enter)";
    ok.setAttribute("aria-label", "Confirm");
    ok.appendChild(iconElement("check", 15));
    ok.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      swallowRelease(e.pointerId);
      this.commit();
    });
    this.root.appendChild(ok);
    if (this.onCancel) {
      const no = document.createElement("button");
      no.className = "dim-btn dim-no";
      no.title = "Cancel (Esc)";
      no.setAttribute("aria-label", "Cancel");
      no.appendChild(iconElement("close", 15));
      no.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        swallowRelease(e.pointerId);
        this.onCancel?.();
      });
      this.root.appendChild(no);
    }
    // show() is often called from a pointerdown, and the browser moves focus to the click target after it returns,
    // so focus again next frame too or typing and Tab go nowhere.
    this.focus();
    requestAnimationFrame(() => this.focus());
    // Subscribed per showing, or a tool would inherit the last tool's refusal. onPreviewError fires at once, so a box
    // opening onto an already failing preview shows it.
    this.unsubscribeError = onPreviewError((m) => this.setProblem(m));
    if (this.segmented.some((g) => g.def.segments.some((x) => x.key)))
      window.addEventListener("keydown", this.boundSegmentKey, true);
  }

  private optionElement(o: DimOption): HTMLElement {
    if (isSegmented(o)) {
      const el = document.createElement("div");
      el.className = "dim-seg";
      el.dataset.option = o.name;
      el.setAttribute("role", "radiogroup");
      el.setAttribute("aria-label", o.title);
      el.title = o.title;
      const g: Segmented = { def: o, el, chosen: o.chosen };
      for (const seg of o.segments) {
        const b = this.optionButton(seg.icon, seg.label, seg.key ? `${seg.label} (${seg.key})` : seg.label);
        b.classList.add("dim-segment");
        b.dataset.id = seg.id;
        b.setAttribute("role", "radio");
        this.onPress(b, () => this.pickSegment(g, seg.id));
        el.appendChild(b);
      }
      this.segmented.push(g);
      this.paintSegmented(g);
      return el;
    }
    if (isAction(o)) {
      const b = this.optionButton(o.icon, o.label, o.label);
      b.classList.add("dim-action");
      b.dataset.option = o.name;
      this.onPress(b, o.onPress);
      return b;
    }
    const b = this.optionButton(o.icon, o.label, o.title);
    b.classList.add("dim-toggle");
    b.classList.toggle("on", o.initial);
    b.setAttribute("aria-pressed", String(o.initial));
    this.onPress(b, () => {
      this.setToggle(!this.toggleOn);
      o.onChange(this.toggleOn);
    });
    // The first switch is the one setToggle and its kin address.
    if (!this.toggleBtn) {
      this.toggleBtn = b;
      this.toggleOn = o.initial;
    }
    return b;
  }

  /** The word stays in the button for screen readers and text checks; it shows only when there is no icon. */
  private optionButton(icon: string | undefined, label: string, title: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dim-btn dim-opt";
    b.title = title;
    b.tabIndex = -1;
    if (icon) {
      b.setAttribute("aria-label", label);
      b.appendChild(iconElement(icon, 16));
    } else b.classList.add("dim-worded");
    const word = document.createElement("span");
    word.className = "dim-word";
    word.textContent = label;
    b.appendChild(word);
    return b;
  }

  private onPress(b: HTMLElement, act: () => void) {
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // never blur the input to press it
      e.stopPropagation();
      act();
    });
  }

  private segmented: Segmented[] = [];

  private paintSegmented(g: Segmented) {
    for (const b of g.el.querySelectorAll<HTMLElement>(".dim-segment")) {
      const on = b.dataset.id === g.chosen;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  private pickSegment(g: Segmented, id: string) {
    if (g.chosen === id) return;
    g.chosen = id;
    this.paintSegmented(g);
    g.def.onChoose(id);
  }

  /** Sets a segmented option without picking it. Does NOT call back, as with setToggle. */
  setOption(name: string, id: string) {
    const g = this.segmented.find((x) => x.def.name === name);
    if (!g) return;
    g.chosen = id;
    this.paintSegmented(g);
  }

  optionOf(name: string): string | null {
    return this.segmented.find((x) => x.def.name === name)?.chosen ?? null;
  }

  /** For an option that applies only to some picks, such as the direction on a hole's face. */
  setOptionHidden(name: string, hidden: boolean) {
    const el = this.root.querySelector<HTMLElement>(`[data-option="${name}"]`);
    if (el) el.style.display = hidden ? "none" : "";
  }

  private boundSegmentKey = (e: KeyboardEvent) => this.onSegmentKey(e);

  private onSegmentKey(e: KeyboardEvent) {
    if (!this.active || e.ctrlKey || e.metaKey || e.repeat) return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    if (typing ? !(e.altKey && this.ownsTarget(t)) : e.altKey) return;
    // Alt turns e.key into another character on some layouts; the code still names the key.
    const key = /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key;
    for (const g of this.segmented) {
      const seg = g.def.segments.find((x) => x.key === key);
      if (!seg || g.el.style.display === "none") continue;
      e.preventDefault();
      e.stopPropagation();
      this.pickSegment(g, seg.id);
      return;
    }
  }

  /** Judged only once the user has typed: a value the cursor wrote is the tool's own. */
  private fieldProblem(f: Field): string | null {
    if (f.hidden || !f.userDriven || f.def.free) return null;
    const raw = this.numberText(f).trim();
    if (!raw || f.def.words?.test(raw)) return null;
    const v = this.parse(f);
    if (v === null) {
      const err = measureError(raw, f.unit);
      if (err === null) return `${f.def.label} takes a plain number, no unit`;
      return `${f.def.label}: ${/unknown parameter/.test(err) ? `"${raw}" is not a number` : err}`;
    }
    return this.rangeProblem(f.def, v);
  }

  private rangeProblem(def: DimFieldDef, v: number): string | null {
    return valueProblem(def.label, def, v);
  }

  /** Judges the field as Tab and Enter do, for a tool that acts on a key before the box sees it. */
  accepts(name: string): boolean {
    const f = this.fields.find((x) => x.def.name === name);
    const problem = f ? this.fieldProblem(f) : null;
    if (!problem) return true;
    this.setTypedProblem(problem);
    f!.input.focus();
    f!.input.select();
    return false;
  }

  private parse(f: Field): number | null {
    const text = this.numberText(f);
    // Parsed against THIS field's unit: a field the user put into inches reads a bare "2" as two inches.
    if (!f.unit) return parseField(text, f.def.kind);
    return tryParseMeasure(text, f.unit)?.value ?? null;
  }

  private numberText(f: Field): string {
    return f.def.choices?.read?.(f.input.value)?.text ?? f.input.value;
  }

  /** Refuses the confirm with the tool's own reason (a distance with no direction). Cleared by the next keystroke. */
  flag(message: string) {
    this.setTypedProblem(message);
  }

  private setTypedProblem(message: string | null) {
    this.typedProblem = message;
    this.renderProblem();
  }

  private toggleBtn: HTMLButtonElement | null = null;
  private toggleOn = false;

  /** Sets the switch without pressing it. Does NOT call back: the caller already knows and it would loop. */
  setToggle(on: boolean) {
    this.toggleOn = on;
    this.toggleBtn?.classList.toggle("on", on);
    this.toggleBtn?.setAttribute("aria-pressed", String(on));
  }

  /** For a switch that steps through several states rather than two. */
  setToggleLabel(label: string) {
    const word = this.toggleBtn?.querySelector(".dim-word");
    if (word) word.textContent = label;
  }

  /** For a switch that applies only once the tool learns more, such as an engine answer that lands later. */
  setToggleHidden(hidden: boolean) {
    if (this.toggleBtn) this.toggleBtn.style.display = hidden ? "none" : "";
  }

  /** Keeps what is typed; problems name the field by this label too. */
  setFieldLabel(name: string, label: string, icon?: string) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f || (f.def.label === label && f.def.icon === icon)) return;
    const { icon: _old, ...rest } = f.def;
    f.def = icon ? { ...rest, label, icon } : { ...rest, label };
    this.paintName(f);
  }

  /** Sets a field's choice without picking it. Does NOT call back, as with setToggle. */
  setChoice(name: string, id: string) {
    const f = this.fields.find((x) => x.def.name === name);
    const c = f?.def.choices?.options.find((o) => o.id === id);
    if (!f || !c) return;
    f.choice = id;
    this.setFieldLabel(name, c.label, c.icon);
  }

  choiceOf(name: string): string | null {
    return this.fields.find((x) => x.def.name === name)?.choice ?? null;
  }

  private paintName(f: Field) {
    const tag = f.tag;
    tag.replaceChildren();
    if (f.def.icon) {
      tag.appendChild(iconElement(f.def.icon, 14));
      if (f.def.tag) tag.append(f.def.tag);
      tag.title = f.def.label;
    } else {
      tag.textContent = f.def.tag ?? f.def.label;
      if (f.def.tag) tag.title = f.def.label;
      else tag.removeAttribute("title");
    }
    if (f.def.choices) tag.appendChild(iconElement("caretDown", 10));
    f.input.setAttribute("aria-label", f.def.label);
  }

  private choose(f: Field, id: string, typed: boolean) {
    if (id === f.choice) return;
    this.setChoice(f.def.name, id);
    f.def.choices?.onChoose(id, typed);
  }

  /** Hides a field without rebuilding the box, so what is typed in the others survives. */
  setFieldHidden(name: string, hidden: boolean) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    f.hidden = hidden;
    const wrap = f.input.closest("label");
    if (wrap) wrap.style.display = hidden ? "none" : "";
  }

  /** show() calls it; a tool that keeps clicking the canvas with the box open must call it after each click,
   *  since the click blurs the input and typing would go nowhere. */
  focus() {
    const f = this.fields.find((x) => x.def.name === this.focusName && !x.hidden) ?? this.fields[0];
    if (f && this.active) {
      f.input.focus();
      f.input.select();
    }
  }

  focusField(name: string) {
    this.focusName = name;
    this.focus();
  }

  private onKey(e: KeyboardEvent, field: Field) {
    if (isHistoryKey(e)) {
      // Undo and redo belong to the document: put the tool away and let the key reach the window keymap.
      // Stopped here, a box swallowed every Ctrl+Z and Ctrl+Y after it (FI-2).
      this.onCancel?.();
      field.input.blur();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      field.userDriven = true; // Tab locks the current field
      const problem = this.fieldProblem(field);
      if (problem) this.setTypedProblem(problem);
      const shown = this.fields.filter((f) => !f.hidden || f === field);
      const step = e.shiftKey ? shown.length - 1 : 1;
      const next = shown[(shown.indexOf(field) + step) % shown.length];
      if (next) {
        next.input.focus();
        next.input.select();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.commit();
    }
    // Escape is handled by the owning tool's capture-phase keydown listener.
    e.stopPropagation(); // never let drawing shortcuts fire while typing
  }

  /** Grows with its content so a formula fits; floored so it neither collapses empty nor twitches on short values. */
  private sizeToContent(f: Field) {
    f.input.style.width = `${Math.max(MIN_FIELD_CH, f.input.value.length + 1)}ch`;
  }

  /** A unit in the text changes what the field shows: type "1 inch" into a mm field and the chip moves, the number
   *  stays exactly as typed. */
  private adoptTypedUnit(f: Field) {
    if (!f.unit) return;
    const m = tryParseMeasure(this.numberText(f), f.unit);
    if (!m?.unit || m.unit === f.unit) return;
    f.unit = m.unit;
    if (f.chip) f.chip.textContent = m.unit.label;
  }

  private adoptTypedChoice(f: Field) {
    const got = f.def.choices?.read?.(f.input.value);
    if (got) this.choose(f, got.choice, true);
  }

  /** A unit picked from the chip CONVERTS the value: 10 mm shown as inches is 0.3937 in, not 10 in. */
  private openUnitMenu(f: Field) {
    if (!f.unit || !f.chip) return;
    this.openMenu(
      f.chip,
      commonUnits(f.unit.dim).map((u) => ({
        label: u.label,
        active: u.id === f.unit?.id,
        pick: () => {
          const current = tryParseMeasure(this.numberText(f), f.unit);
          f.unit = u;
          if (f.chip) f.chip.textContent = u.label;
          if (current) f.input.value = String(toUnit(current.value, u));
          this.sizeToContent(f);
          f.input.focus();
        },
      })),
    );
  }

  /** The tool rewrites the value in the new terms. */
  private openChoiceMenu(f: Field) {
    const choices = f.def.choices;
    if (!choices) return;
    this.openMenu(
      f.tag,
      choices.options.map((c) => ({
        label: c.word,
        active: c.id === f.choice,
        pick: () => {
          this.choose(f, c.id, false);
          this.sizeToContent(f);
          f.input.focus();
          f.input.select();
        },
      })),
    );
  }

  private openMenu(anchor: HTMLElement, rows: { label: string; active: boolean; pick: () => void }[]) {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "dim-unit-menu";
    for (const r of rows) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dim-unit-item" + (r.active ? " active" : "");
      row.textContent = r.label;
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu();
        r.pick();
      });
      menu.appendChild(row);
    }
    const at = anchor.getBoundingClientRect();
    menu.style.left = `${at.left}px`;
    menu.style.top = `${at.bottom + 2}px`;
    document.body.appendChild(menu);
    this.menu = menu;
    // One dismissal path, on the next press anywhere else.
    setTimeout(() => window.addEventListener("pointerdown", this.boundCloseMenu, { once: true, capture: true }), 0);
  }

  private menu: HTMLDivElement | null = null;
  private boundCloseMenu = () => this.closeMenu();

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  /** values in MM; only tracking fields accept them */
  updateFromCursor(values: Record<string, number>) {
    for (const f of this.fields) {
      const v = values[f.def.name];
      if (!f.userDriven && v != null) {
        f.input.value = String(f.def.kind === "count" ? Math.round(v) : toUnit(v, f.unit));
        this.sizeToContent(f);
        // Keep the live value selected while it tracks the cursor, so typing replaces it instead of appending.
        if (document.activeElement === f.input) f.input.select();
      }
    }
  }

  /** Fills and locks a field so cursor tracking cannot clobber it, for a saved value on re-opening a feature. */
  seed(name: string, value: number) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    f.input.value = String(f.def.kind === "count" ? Math.round(value) : toUnit(value, f.unit));
    f.lastGood = null;
    f.userDriven = true;
    this.sizeToContent(f);
  }

  /** `seed` for a value that is not a number, such as a size name. */
  seedText(name: string, text: string) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    f.input.value = text;
    f.lastGood = null;
    f.userDriven = true;
    this.sizeToContent(f);
  }

  /** A drag on the handle that owns the field takes it back from the keyboard: it is as explicit as typing and more
   *  recent, and otherwise the number beside the moving handle would go on reading the stale typed value. */
  takeOver(name: string) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    f.userDriven = false;
    f.lastGood = null;
  }

  /** Every field turns red, not one: the engine refuses a feature, not a field (pitch and angle together), and the
   *  user knows which one they would rather move. */
  private setProblem(message: string | null) {
    if (!this.active) return;
    this.external = message;
    this.renderProblem();
  }

  private renderProblem() {
    if (!this.active) return;
    const message = this.typedProblem ?? this.external;
    if (!message) {
      this.problem?.remove();
      this.problem = null;
      this.root.classList.remove("dim-bad");
      return;
    }
    this.root.classList.add("dim-bad");
    if (!this.problem) {
      this.problem = document.createElement("div");
      this.problem.className = "dim-problem";
      this.root.appendChild(this.problem);
    }
    this.problem.textContent = message;
  }

  /** For a tool that judges its own values: the preview channel only hears about values sent to the kernel. */
  showOwnProblem(message: string | null) {
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.setProblem(message);
  }

  isUserDriven(name: string): boolean {
    const f = this.fields.find((x) => x.def.name === name);
    return !!f && f.userDriven;
  }

  /** in MM (length fields converted from the display unit). Null for an empty box or one of the field's words; typed
   *  text that is no value reads as the last valid value typed, null when there is none. */
  getValue(name: string): number | null {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return null;
    const v = this.parse(f);
    if (v !== null && !(f.userDriven && this.rangeProblem(f.def, v))) return v;
    return this.fieldProblem(f) ? f.lastGood : null;
  }

  /** Null for a count. */
  unitOf(name: string): UnitDef | null {
    return this.fields.find((x) => x.def.name === name)?.unit ?? null;
  }

  /** The RAW text, for callers using the expression evaluator that must tell "empty" from "unparseable"; "" when
   *  there is no such field. */
  getRaw(name: string): string {
    return this.fields.find((x) => x.def.name === name)?.input.value ?? "";
  }

  /** Below right of the point, flipped to its other side where the window ends, never over it. */
  position(screenX: number, screenY: number) {
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const right = screenX + CURSOR_GAP;
    const below = screenY + CURSOR_GAP;
    const flipX = right + w > window.innerWidth && screenX - CURSOR_GAP - w >= 0;
    const flipY = below + h > window.innerHeight && screenY - CURSOR_GAP - h >= 0;
    this.root.style.left = `${Math.round(flipX ? screenX - CURSOR_GAP - w : right)}px`;
    this.root.style.top = `${Math.round(flipY ? screenY - CURSOR_GAP - h : below)}px`;
  }

  /** `dir` is the arrow from base to tip on screen; the box is kept inside `bounds`. */
  positionPast(tip: ScreenPoint, dir: ScreenPoint, bounds: ScreenRect) {
    const p = this.problem;
    const size = {
      w: Math.max(this.root.offsetWidth, p ? p.offsetLeft + p.offsetWidth : 0),
      h: Math.max(this.root.offsetHeight, p ? p.offsetTop + p.offsetHeight : 0),
    };
    const at = pastTip(tip, dir, size, bounds);
    this.root.style.left = `${Math.round(at.left)}px`;
    this.root.style.top = `${Math.round(at.top)}px`;
  }

  fitToWindow() {
    this.root.classList.add("fits-window");
  }

  /** The size at natural width, which is what it has wherever there is room. */
  naturalSize(): { w: number; h: number } {
    this.root.style.left = "0px";
    return { w: this.root.offsetWidth, h: this.root.offsetHeight };
  }

  positionBeside(model: ScreenRect, anchor: ScreenPoint, bounds: ScreenRect) {
    const at = placeBeside(model, anchor, this.naturalSize(), bounds);
    this.root.style.left = `${Math.round(at.left)}px`;
    this.root.style.top = `${Math.round(at.top)}px`;
  }

  // Centred on the drawing itself, so the placing click can land under it: it must not take that click.
  positionCentred(screenX: number, screenY: number) {
    this.setClickThrough(true);
    this.root.style.left = `${Math.round(screenX - this.root.offsetWidth / 2)}px`;
    this.root.style.top = `${Math.round(screenY - this.root.offsetHeight / 2)}px`;
  }

  hasTyped(): boolean {
    return this.active && this.fields.some((f) => f.typed && !f.hidden);
  }

  /** Not the user's confirm, so text that is no value refuses it even where Enter would fall back. */
  confirmTyped(): boolean {
    return this.commit(false);
  }

  /** On Enter or the confirm button a field whose text is no value commits its last typed valid value, still marked;
   *  with none, or on any other confirm, it refuses. */
  private commit(explicit = true): boolean {
    let marked: string | null = null;
    for (const f of this.fields) {
      const problem = this.fieldProblem(f);
      if (!problem) continue;
      marked ??= problem;
      if (explicit && f.lastGood !== null) continue;
      this.setTypedProblem(problem);
      f.input.focus();
      f.input.select();
      return false;
    }
    if (marked) this.setTypedProblem(marked);
    const out: Record<string, number> = {};
    for (const f of this.fields) {
      const v = this.getValue(f.def.name); // already mm-converted
      if (v != null) out[f.def.name] = v;
      f.typed = false;
    }
    this.onCommit?.(out);
    return true;
  }

  hide() {
    // The button belongs to one showing, or the next tool would toggle a mode nobody is in. innerHTML is cleared below,
    // so this drops the pointer, not the DOM.
    this.toggleBtn = null;
    this.toggleOn = false;
    this.segmented = [];
    window.removeEventListener("keydown", this.boundSegmentKey, true);
    this.active = false;
    shownBoxes.delete(this);
    this.closeMenu();
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.problem = null; // innerHTML below takes the element with it
    this.external = null;
    this.typedProblem = null;
    this.root.classList.remove("dim-bad");
    this.root.style.display = "none";
    this.root.innerHTML = "";
    this.fields = [];
    this.onCommit = null;
    this.onCancel = null;
    this.onInput = null;
  }
}
