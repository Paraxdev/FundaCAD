// On-canvas heads-up dimension input: tracking fields follow the cursor, typing holds, Tab locks, Enter commits.
// Values cross this boundary in MILLIMETRES; length fields show and parse the display unit, angles are degrees.

import {
  onActivate,
  setChipUnit,
  setExpanded,
  uiButton,
  uiIconButton,
  uiNumberInput,
  uiOption,
  type UiIconButtonOptions,
} from "../components/ui/dom";
import { iconElement } from "../ui/icons";
import { isEditableTarget, isHistoryKey, isMenuKey } from "../ui/focus";
import { claimEscape } from "../ui/escapeClaim";
import { onPreviewError } from "../ui/previewError";
import { getUnit, parseField } from "../ui/units";
import { commonUnits, measureError, toUnit, tryParseMeasure, unitById, type UnitDef } from "../ui/measure";
import { valueProblem, type FieldKind, type ValueRule } from "../document/numFields";
import { splitNameValue, type ExprInput } from "../params/engine";
import { replayedPress } from "../viewport/navigator/input";

/** Where the box reads parameter names from, the document store in the app. */
export interface DimDocument {
  classifyTargetExpr(boundName: string | null, pendingName: string | null, raw: string, kind: FieldKind): ExprInput;
}

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
  /** A short name shown beside a small icon ("G1"), for values whose glyphs alone read too alike. */
  text?: string;
  /** Why it cannot be picked now; greyed with this in its tooltip. `setSegmentDisabled` changes it later. */
  disabled?: string;
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
  /** A press or key on a disabled segment, with its reason, so the tool can say why nothing changed. */
  onBlocked?: (id: string, reason: string) => void;
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
  disabled: Map<string, string>;
}

interface Field {
  def: DimFieldDef;
  input: HTMLInputElement;
  /** The unit this field is SHOWING: the document's at first, then whatever the user types or picks on the chip.
   *  Per field, so a value entered in inches goes on reading in inches without changing the rest of the app. */
  unit: UnitDef | null;
  /** the clickable unit chip, or null for a count (which has no unit) */
  chip: HTMLElement | null;
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
let boxCount = 0;
let chipCount = 0;
const BOX_HELP = "Enter applies, Escape cancels, Tab moves on";
const LIST_HELP = "Alt+Down opens the field's list";

/** The box holding a typed value not yet entered, or null. `confirm` enters it as Enter would, false when refused. */
export function typedDimBox(): { confirm(): boolean } | null {
  for (const box of shownBoxes) if (box.hasTyped()) return { confirm: () => box.confirmTyped() };
  return null;
}

function initialUnit(kind: DimFieldDef["kind"]): UnitDef | null {
  if (kind === "count") return null;
  return unitById(kind === "angle" ? "deg" : getUnit());
}

/** The chip's name carries the unit, and the field's input is described by it, so a reader hears name, value, unit. */
function paintChip(chip: HTMLElement, unit: UnitDef) {
  setChipUnit(chip, unit.id);
  chip.setAttribute("aria-label", `Unit, ${unit.label}`);
}

/** IconButton sm plain under the box's own .dim-btn look, named by the bare word: the tooltip carries the key. */
function boxIconButton(o: Omit<UiIconButtonOptions, "size" | "variant">, name: string): HTMLButtonElement {
  const b = uiIconButton({ ...o, size: "sm", variant: "plain" });
  b.classList.add("dim-btn");
  b.setAttribute("aria-label", name);
  return b;
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
  /** A tool's own control beside the fields, such as the fillet's profile chip. */
  private extra: HTMLElement | null = null;
  private typedProblem: string | null = null;
  private focusName: string | null = null;
  private boxNo = ++boxCount;
  private helpId = `dim-help-${this.boxNo}`;

  constructor(private doc: () => DimDocument | null = () => null) {
    this.root = document.createElement("div");
    this.root.className = "dim-input";
    this.root.style.display = "none";
    this.root.setAttribute("role", "group");
    // #prompt is the tool's banner line, so entering the box reads what the tool asks for, then the keys.
    this.root.setAttribute("aria-describedby", `prompt ${this.helpId}`);
    document.body.appendChild(this.root);
    // Field inputs stop their own keys, so this hears only the option buttons.
    this.root.addEventListener("keydown", (e) => this.onOptionKey(e));
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

  /** A tool's letter key is text in a field typed into, since names use letters. The box focuses itself, so its
   *  untouched field still lends the tool the key. */
  typesText(e: KeyboardEvent): boolean {
    if (!isEditableTarget(e.target)) return false;
    const f = this.fields.find((x) => x.input === e.target);
    return !f || f.userDriven;
  }

  ownsField(el: EventTarget | null): boolean {
    return this.fields.some((f) => f.input === el);
  }

  /** For a tool whose Tab means something else (the fillet flip): Shift+Tab from a field steps back onto Cancel. */
  focusLastStop() {
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : this.root;
    this.tabStops(from).at(-1)?.focus();
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
      // Out of the Tab order like the unit chip, or Shift+Tab off the first field would land here, not leave the box.
      if (tag instanceof HTMLButtonElement) {
        tag.type = "button";
        tag.tabIndex = -1;
        tag.setAttribute("role", "combobox");
        tag.setAttribute("aria-haspopup", "listbox");
        tag.setAttribute("aria-expanded", "false");
      }
      wrap.appendChild(tag);
      const unit = initialUnit(def.kind);
      const num = uiNumberInput({
        size: "sm",
        // NOT inputMode "decimal": that asks a touch keyboard for digits only, and
        // this field takes "1 1/2 in" and "width/2".
        inputMode: "text",
        unit: unit?.id,
        units: unit ? commonUnits(unit.dim).map((u) => u.id) : undefined,
        unitTip: "Change unit",
      });
      // NumberField's input and chip sit in the box's own flat row, the .ui-field well would repaint it.
      const input = num.input;
      wrap.appendChild(input);

      const field: Field = {
        def,
        input,
        unit,
        chip: null,
        tag,
        choice: def.choices?.chosen ?? null,
        userDriven: false,
        lastGood: null,
      };
      this.paintName(field);
      if (def.choices) this.wireAnchor(tag, field, (keys) => this.openChoiceMenu(field, keys));

      if (field.unit && num.chip) {
        // The unit is a button: clicking it changes what the field shows without retyping the number.
        const chip = num.chip;
        chip.classList.add("dim-unit");
        chip.id = `dim-unit-${++chipCount}`;
        chip.tabIndex = -1;
        paintChip(chip, field.unit);
        input.setAttribute("aria-describedby", chip.id);
        this.wireAnchor(chip, field, (keys) => this.openUnitMenu(field, keys));
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
    this.extra = extra ?? null;
    if (extra) this.root.appendChild(extra);
    // The tool's options sit ahead of confirm and cancel: they change what is about to be committed.
    const opts = options === undefined ? [] : Array.isArray(options) ? options : [options];
    if (opts.length) {
      const group = document.createElement("div");
      group.className = "dim-opts";
      for (const o of opts) group.appendChild(this.optionElement(o));
      this.root.appendChild(group);
    }
    const ok = boxIconButton({ icon: "check", tip: "Confirm", keys: "Enter", iconSize: 15 }, "Confirm");
    ok.classList.add("dim-ok", "dim-end");
    this.onEndPress(ok, () => this.commit());
    this.root.appendChild(ok);
    if (this.onCancel) {
      const no = boxIconButton({ icon: "close", tip: "Cancel", keys: "Esc", iconSize: 15 }, "Cancel");
      no.classList.add("dim-no");
      this.onEndPress(no, () => this.onCancel?.());
      this.root.appendChild(no);
    }
    // Hidden, yet read: an element aria-describedby points at directly is described even when hidden.
    const help = document.createElement("span");
    help.id = this.helpId;
    help.hidden = true;
    help.textContent = this.fields.some((f) => f.chip || f.def.choices) ? `${BOX_HELP}, ${LIST_HELP}` : BOX_HELP;
    this.root.appendChild(help);
    this.nameGroup();
    // show() is often called from a pointerdown, and the browser moves focus to the click target after it returns,
    // so focus again next frame too or typing and Tab go nowhere. A field that took focus by then, such as a rename in
    // the Items tree after a selection raised Move, keeps it: losing it would close that field. The box's own field
    // still goes through focus(), since a value seeded after show lost its selection and typing would append to it.
    this.focus();
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (this.ownsField(now) || !isEditableTarget(now)) this.focus();
    });
    // Subscribed per showing, or a tool would inherit the last tool's refusal. onPreviewError fires at once, so a box
    // opening onto an already failing preview shows it.
    this.unsubscribeError = onPreviewError((m) => this.setProblem(m));
    if (this.segmented.some((g) => g.def.segments.some((x) => x.key)))
      window.addEventListener("keydown", this.boundSegmentKey, true);
  }

  /** Confirm and Cancel act on the press, which never blurs the field, and on the click Enter, Space or a screen
   *  reader sends. The box often goes with the press, so its release must not land on the canvas behind. */
  private onEndPress(b: HTMLButtonElement, act: () => void) {
    onActivate(b, (e) => {
      if (e.type === "pointerdown") swallowRelease((e as PointerEvent).pointerId);
      act();
    });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  private optionElement(o: DimOption): HTMLElement {
    if (isSegmented(o)) {
      const el = document.createElement("div");
      el.className = "dim-seg";
      el.dataset.option = o.name;
      el.setAttribute("role", "radiogroup");
      el.setAttribute("aria-label", o.title);
      el.title = o.title;
      const g: Segmented = { def: o, el, chosen: o.chosen, disabled: new Map() };
      for (const seg of o.segments) {
        const b = this.optionButton(seg.icon, seg.label, "", seg.text);
        b.classList.add("dim-segment");
        b.dataset.id = seg.id;
        b.setAttribute("role", "radio");
        this.onPress(b, () => this.pickSegment(g, seg.id));
        el.appendChild(b);
        if (seg.disabled) g.disabled.set(seg.id, seg.disabled);
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
      this.presses.set(b, o.onPress);
      return b;
    }
    const b = this.optionButton(o.icon, o.label, o.title);
    b.classList.add("dim-toggle");
    b.classList.toggle("on", o.initial);
    b.setAttribute("aria-pressed", String(o.initial));
    const flip = () => {
      this.setToggle(!this.toggleOn);
      o.onChange(this.toggleOn);
    };
    this.onPress(b, flip);
    this.presses.set(b, flip);
    // The first switch is the one setToggle and its kin address.
    if (!this.toggleBtn) {
      this.toggleBtn = b;
      this.toggleOn = o.initial;
    }
    return b;
  }

  /** The word stays in the button for screen readers and text checks; it shows only when there is no icon. */
  private optionButton(icon: string | undefined, label: string, title: string, text?: string): HTMLButtonElement {
    if (!icon) {
      // clickable: the box keeps its own disabled model, a greyed segment still takes the arrows and Enter.
      const b = uiButton({ label, variant: "ghost", size: "sm", tip: title || undefined, clickable: true });
      b.classList.add("dim-btn", "dim-opt", "dim-worded");
      b.querySelector(".btn-label")!.classList.add("dim-word");
      return b;
    }
    const b = boxIconButton({ icon, tip: title || label, iconSize: text ? 12 : 16, clickable: true }, label);
    b.classList.add("dim-opt");
    if (text) {
      b.classList.add("dim-texted");
      const t = document.createElement("span");
      t.className = "dim-seg-text";
      t.textContent = text;
      t.setAttribute("aria-hidden", "true");
      b.appendChild(t);
    }
    const word = document.createElement("span");
    word.className = "dim-word";
    word.textContent = label;
    b.appendChild(word);
    return b;
  }

  /** Acts on the press, never blurring the field, and on a screen reader's click. Space and Enter act on their
   *  keydown in onOptionKey, which cancels Enter's click; some engines still click on a handled Space's release. */
  private onPress(b: HTMLElement, act: () => void) {
    onActivate(b, () => act());
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("keyup", (e) => {
      if (e.key === " ") e.preventDefault();
    });
  }

  private segmented: Segmented[] = [];
  /** What Space or Enter does on a switch or an action, the same as a press. */
  private presses = new Map<HTMLElement, () => void>();

  /** Roving tabindex: the chosen segment is the group's one Tab stop. */
  private paintSegmented(g: Segmented) {
    for (const b of g.el.querySelectorAll<HTMLElement>(".dim-segment")) {
      const id = b.dataset.id!;
      const seg = g.def.segments.find((x) => x.id === id)!;
      const on = id === g.chosen;
      const why = g.disabled.get(id);
      b.classList.toggle("on", on);
      b.classList.toggle("disabled", !!why);
      b.setAttribute("aria-checked", String(on));
      if (why) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
      b.tabIndex = on ? 0 : -1;
      const name = seg.key ? `${seg.label} (${seg.key})` : seg.label;
      b.title = why ? `${name}: ${why}` : name;
    }
  }

  /** Greys a segment out with the reason in its tooltip, or frees it with null. Clicks and keys skip it. */
  setSegmentDisabled(name: string, id: string, reason: string | null) {
    const g = this.segmented.find((x) => x.def.name === name);
    if (!g) return;
    if (reason) g.disabled.set(id, reason);
    else g.disabled.delete(id);
    this.paintSegmented(g);
  }

  private pickSegment(g: Segmented, id: string) {
    const why = g.disabled.get(id);
    if (why) g.def.onBlocked?.(id, why);
    if (g.chosen === id || why) return;
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
    if (!this.active || e.ctrlKey || e.metaKey || e.repeat || isMenuKey(e)) return;
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
      const expr = this.typedExpr(f);
      if (expr && !expr.ok)
        return `${f.def.label}: ${expr.error.replace(/^unknown parameter /, "no parameter named ")}`;
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
    const v = this.parseMeasure(f);
    if (v !== null) return v;
    const expr = this.typedExpr(f);
    return expr?.ok ? expr.value : null;
  }

  private parseMeasure(f: Field): number | null {
    const text = this.numberText(f);
    // Parsed against THIS field's unit: a field the user put into inches reads a bare "2" as two inches.
    if (!f.unit) return parseField(text, f.def.kind);
    return tryParseMeasure(text, f.unit)?.value ?? null;
  }

  /** Text that names a parameter, judged as the History rows judge it: canonical units, bare numbers in mm. Null when
   *  there is no document or the field's own parser reads it or fails for another reason ("1,000" stays ambiguous). */
  private typedExpr(f: Field): ExprInput | null {
    const doc = this.doc();
    const text = this.numberText(f).trim();
    if (!doc || !text || this.parseMeasure(f) !== null) return null;
    const err = measureError(text, f.unit);
    if (!(err && /unknown parameter/.test(err)) && !splitNameValue(text)) return null;
    return doc.classifyTargetExpr(null, null, text, f.def.kind ?? "length");
  }

  /** The typed parameter expression a tool binds the feature field to, with the new name of a `name = expr`; null for
   *  a number, plain maths or text that does not read. */
  exprOf(name: string): { expr: string; name?: string } | null {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f || f.hidden || !f.userDriven) return null;
    const r = this.typedExpr(f);
    if (!r?.ok) return null;
    return r.name ? { expr: r.expr, name: r.name } : { expr: r.expr };
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
    this.nameGroup();
  }

  private nameGroup() {
    const labels = this.fields.filter((f) => !f.hidden).map((f) => f.def.label);
    this.root.setAttribute("aria-label", labels.join(", ") || "Values");
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
    if (f.def.choices) {
      tag.appendChild(iconElement("caretDown", 10));
      const word = f.def.choices.options.find((o) => o.id === f.choice)?.word ?? f.def.label;
      tag.setAttribute("aria-label", `Measure, ${word}`);
    }
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
    this.nameGroup();
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
      field.userDriven = true; // Tab locks the current field
      const problem = this.fieldProblem(field);
      if (problem) this.setTypedProblem(problem);
      if (this.moveFocus(field.input, e.shiftKey)) e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.commit();
    } else if (e.key === "Escape" && this.menu) {
      // The open list claimed this Escape, so the tool left it.
      e.preventDefault();
      this.closeMenu();
    } else if (e.key === "ArrowDown" && e.altKey && (field.chip || field.def.choices)) {
      e.preventDefault();
      if (field.chip) this.openUnitMenu(field, true);
      else this.openChoiceMenu(field, true);
    }
    // Escape is otherwise handled by the owning tool's capture-phase keydown listener.
    e.stopPropagation(); // never let drawing shortcuts fire while typing
  }

  /** The shown fields in order, the tool's extra controls, one stop per shown option (the chosen segment of a group,
   *  or the button), then Confirm and Cancel. */
  private tabStops(current: HTMLElement): HTMLElement[] {
    const fields = this.fields.filter((f) => !f.hidden || f.input === current).map((f) => f.input);
    const extra = [...(this.extra?.querySelectorAll<HTMLElement>("button, input") ?? [])].filter(
      (el) => el.tabIndex >= 0 && !el.closest("[hidden]"),
    );
    const options: HTMLElement[] = [];
    for (const el of this.root.querySelectorAll<HTMLElement>(".dim-opts > *")) {
      if (el.style.display === "none") continue;
      if (!el.classList.contains("dim-seg")) options.push(el);
      else {
        const stop = el.querySelector<HTMLElement>('.dim-segment[tabindex="0"]') ?? el.querySelector(".dim-segment");
        if (stop) options.push(stop);
      }
    }
    const ends = [...this.root.querySelectorAll<HTMLElement>(".dim-ok, .dim-no")];
    return [...fields, ...extra, ...options, ...ends];
  }

  /** False off either end: there Tab stays the browser's and leaves the box, which never traps the keyboard. */
  private moveFocus(from: HTMLElement, back: boolean): boolean {
    const stops = this.tabStops(from);
    const next = stops[stops.indexOf(from) + (back ? -1 : 1)];
    if (!next) return false;
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
    return true;
  }

  private onOptionKey(e: KeyboardEvent) {
    const b = e.target;
    if (b instanceof HTMLElement && this.extra?.contains(b)) {
      // The extra control answers its own keys; the box only walks Tab through it.
      if (e.key === "Tab" && this.moveFocus(b, e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
      } else if (b instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) e.stopPropagation();
      return;
    }
    if (!(b instanceof HTMLButtonElement) || !this.root.contains(b)) return;
    const group = b.classList.contains("dim-segment") ? this.segmented.find((g) => g.el.contains(b)) : undefined;
    const arrows: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    if (e.key === "Tab") {
      if (!this.moveFocus(b, e.shiftKey)) return;
    } else if (b.classList.contains("dim-ok") || b.classList.contains("dim-no")) {
      // Their own click acts on Enter and Space. This stops the bubble listeners; capture ones ask isBoxButtonKey.
      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      return;
    } else if (group && e.key in arrows) {
      const segs = [...group.el.querySelectorAll<HTMLElement>(".dim-segment")].filter(
        (x) => !group.disabled.has(x.dataset.id!),
      );
      const from = segs.indexOf(b);
      const next = segs[(from + arrows[e.key]! + segs.length) % segs.length];
      if (!next) return;
      this.pickSegment(group, next.dataset.id!);
      next.focus();
    } else if (group && e.key === " ") {
      this.pickSegment(group, b.dataset.id!);
    } else if (group && e.key === "Enter") {
      this.commit();
    } else if (!group && (e.key === " " || e.key === "Enter")) {
      this.presses.get(b)?.();
    } else return;
    e.preventDefault();
    e.stopPropagation();
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
    if (f.chip) paintChip(f.chip, m.unit);
  }

  private adoptTypedChoice(f: Field) {
    const got = f.def.choices?.read?.(f.input.value);
    if (got) this.choose(f, got.choice, true);
  }

  /** A unit picked from the chip CONVERTS the value: 10 mm shown as inches is 0.3937 in, not 10 in. */
  private openUnitMenu(f: Field, keys: boolean) {
    if (!f.unit || !f.chip) return;
    this.openMenu(
      f.chip,
      "Unit",
      keys,
      commonUnits(f.unit.dim).map((u) => ({
        label: u.label,
        active: u.id === f.unit?.id,
        pick: () => {
          const current = tryParseMeasure(this.numberText(f), f.unit);
          f.unit = u;
          if (f.chip) paintChip(f.chip, u);
          if (current) f.input.value = String(toUnit(current.value, u));
          this.sizeToContent(f);
          f.input.focus();
        },
      })),
    );
  }

  /** The tool rewrites the value in the new terms. */
  private openChoiceMenu(f: Field, keys: boolean) {
    const choices = f.def.choices;
    if (!choices) return;
    this.openMenu(
      f.tag,
      "Measure",
      keys,
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

  /** The unit chip and the choice tag. A press opens the list and leaves the field focused; a click (Enter, Space,
   *  a screen reader) or a key opens it with the focus on the anchor, which drives it by aria-activedescendant. */
  private wireAnchor(anchor: HTMLElement, f: Field, open: (keys: boolean) => void) {
    let spaceAt = -Infinity;
    const afterSpace = () => performance.now() - spaceAt < 500;
    onActivate(anchor, (e) => {
      e.stopPropagation();
      if (e.type !== "click") return open(false);
      // Some engines still click a button on the release of a Space its keydown already handled.
      if (afterSpace()) return;
      if (this.menuAnchor === anchor) this.closeMenu();
      else open(true);
    });
    anchor.addEventListener("keydown", (e) => {
      if (this.onAnchorKey(e, f, anchor) && e.key === " ") spaceAt = performance.now();
    });
    anchor.addEventListener("keyup", (e) => {
      if (e.key === " " && afterSpace()) e.preventDefault();
    });
  }

  private onAnchorKey(e: KeyboardEvent, f: Field, anchor: HTMLElement): boolean {
    const k = e.key;
    const chip = anchor === f.chip;
    const open = () => (chip ? this.openUnitMenu(f, true) : this.openChoiceMenu(f, true));
    if (k === "Tab") {
      this.closeMenu();
      // Neither is a stop: the tag sits before its input and the chip after it.
      if (chip === e.shiftKey) {
        f.input.focus();
        f.input.select();
        e.preventDefault();
      } else if (this.moveFocus(f.input, e.shiftKey)) e.preventDefault();
      e.stopPropagation();
      return true;
    }
    if (e.ctrlKey || e.metaKey) return false;
    if (this.menuAnchor !== anchor) {
      if (k !== "Enter" && k !== " " && k !== "ArrowDown" && k !== "ArrowUp") return false;
      open();
    } else if (k === "Escape") {
      this.closeMenu();
      f.input.focus();
    } else if (k === "Enter" || k === " " || (k === "ArrowUp" && e.altKey)) {
      this.menuRows[this.menuActive]?.pick();
    } else if (k === "ArrowDown" || k === "ArrowUp") {
      this.setMenuActive(this.menuActive + (k === "ArrowDown" ? 1 : -1));
    } else if (k === "Home" || k === "End") {
      this.setMenuActive(k === "Home" ? 0 : this.menuRows.length - 1);
    } else if (k === (chip ? "ArrowLeft" : "ArrowRight") && (chip ? f.def.choices : f.chip)) {
      // Left and Right step between the field's two lists, the tag's on the left and the unit's on the right.
      if (chip) this.openChoiceMenu(f, true);
      else this.openUnitMenu(f, true);
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  private openMenu(
    anchor: HTMLElement,
    label: string,
    keys: boolean,
    rows: { label: string; active: boolean; pick: () => void }[],
  ) {
    this.closeMenu();
    this.menuAnchor = anchor;
    const menu = document.createElement("div");
    menu.className = "dim-unit-menu";
    menu.id = `dim-menu-${this.boxNo}`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", label);
    this.menuRows = rows.map((r, i) => {
      const row = uiOption({ id: `${menu.id}-${i}`, label: r.label, selected: r.active, bare: true });
      row.classList.add("dim-unit-item");
      row.classList.toggle("active", r.active);
      const pick = () => {
        this.closeMenu();
        r.pick();
      };
      onActivate(row, (e) => {
        e.stopPropagation();
        pick();
      });
      menu.appendChild(row);
      return { el: row, pick };
    });
    const at = anchor.getBoundingClientRect();
    menu.style.left = `${at.left}px`;
    menu.style.top = `${at.bottom + 2}px`;
    document.body.appendChild(menu);
    this.menu = menu;
    setExpanded(anchor, true, menu.id);
    // Tools that ask escapeClaimed() leave the next Escape to the list, which closes back to the field.
    this.releaseEscape = claimEscape();
    if (keys) {
      anchor.focus();
      this.setMenuActive(
        Math.max(
          0,
          rows.findIndex((r) => r.active),
        ),
      );
    }
    // One dismissal path, on the next press anywhere else.
    this.menuTimer = setTimeout(
      () => window.addEventListener("pointerdown", this.boundCloseMenu, { once: true, capture: true }),
      0,
    );
  }

  private menu: HTMLDivElement | null = null;
  private menuAnchor: HTMLElement | null = null;
  private menuRows: { el: HTMLElement; pick: () => void }[] = [];
  private menuActive = -1;
  private menuTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseEscape: (() => void) | null = null;
  private boundCloseMenu = () => this.closeMenu();

  private setMenuActive(i: number) {
    const anchor = this.menuAnchor;
    if (!anchor || !this.menuRows.length) return;
    this.menuActive = Math.min(this.menuRows.length - 1, Math.max(0, i));
    this.menuRows.forEach((r, k) => r.el.classList.toggle("is-active", k === this.menuActive));
    const row = this.menuRows[this.menuActive]!.el;
    anchor.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView?.({ block: "nearest" });
  }

  private closeMenu() {
    clearTimeout(this.menuTimer);
    window.removeEventListener("pointerdown", this.boundCloseMenu, true);
    this.menu?.remove();
    this.menu = null;
    this.menuRows = [];
    this.menuActive = -1;
    if (this.menuAnchor) {
      setExpanded(this.menuAnchor, false);
      this.menuAnchor.removeAttribute("aria-activedescendant");
    }
    this.menuAnchor = null;
    this.releaseEscape?.();
    this.releaseEscape = null;
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
      this.markInvalid([]);
      return;
    }
    this.root.classList.add("dim-bad");
    if (!this.problem) {
      this.problem = document.createElement("div");
      this.problem.className = "dim-problem";
      this.problem.id = `dim-problem-${this.boxNo}`;
      this.root.appendChild(this.problem);
    }
    this.problem.textContent = message;
    const shown = this.fields.filter((f) => !f.hidden);
    const typed = this.typedProblem ? shown.filter((f) => this.fieldProblem(f)) : [];
    this.markInvalid(typed.length ? typed : shown);
  }

  private markInvalid(bad: Field[]) {
    for (const f of this.fields) {
      const on = bad.includes(f) && this.problem;
      const describedBy = [f.chip?.id, on ? this.problem!.id : ""].filter(Boolean).join(" ");
      if (describedBy) f.input.setAttribute("aria-describedby", describedBy);
      else f.input.removeAttribute("aria-describedby");
      if (on) {
        f.input.setAttribute("aria-invalid", "true");
        f.input.setAttribute("aria-errormessage", this.problem!.id);
      } else {
        f.input.removeAttribute("aria-invalid");
        f.input.removeAttribute("aria-errormessage");
      }
    }
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

  /** Below right of the point, flipped to its other side where the window ends, never over it; clamped into a
   *  window too small for either side. The error line hangs on the side away from the point. */
  position(screenX: number, screenY: number) {
    const { w, h } = this.naturalSize();
    const side = (at: number, size: number, room: number) => {
      const after = at + CURSOR_GAP;
      const before = at - CURSOR_GAP - size;
      if (after + size <= room) return { pos: after, flipped: false };
      if (before >= 0) return { pos: before, flipped: true };
      return { pos: Math.max(0, Math.min(after, room - size)), flipped: false };
    };
    const x = side(screenX, w, window.innerWidth);
    const y = side(screenY, h, window.innerHeight);
    this.root.style.left = `${Math.round(x.pos)}px`;
    this.root.style.top = `${Math.round(y.pos)}px`;
    this.root.classList.toggle("dim-above", y.flipped);
  }

  /** `dir` is the arrow from base to tip on screen; the box is kept inside `bounds`. */
  positionPast(tip: ScreenPoint, dir: ScreenPoint, bounds: ScreenRect) {
    const p = this.problem;
    const size = {
      w: Math.max(this.root.offsetWidth, p ? p.offsetLeft + p.offsetWidth : 0),
      h: Math.max(this.root.offsetHeight, p ? p.offsetTop + p.offsetHeight : 0),
    };
    const at = pastTip(tip, dir, size, bounds);
    this.root.classList.remove("dim-above");
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
    this.root.classList.remove("dim-above");
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
    this.presses.clear();
    this.root.classList.remove("dim-above");
    window.removeEventListener("keydown", this.boundSegmentKey, true);
    this.active = false;
    shownBoxes.delete(this);
    this.closeMenu();
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.problem = null; // innerHTML below takes the element with it
    this.extra = null;
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
