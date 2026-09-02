// On-canvas heads-up dimension input — the signature mainstream MCAD interaction.
// A small floating cluster of <input>s positioned near the cursor. Fields that
// are "tracking" update live from the cursor; typing makes a field hold your
// value; Tab locks the field and moves to the next; Enter commits everything.
//
// Values cross this boundary in MILLIMETRES (the tools work in mm); length
// fields are shown/parsed in the user's display unit, angles always in degrees.

import { iconElement } from "../ui/icons";
import { onPreviewError } from "../ui/previewError";
import { getUnit, parseField } from "../ui/units";
import { commonUnits, toUnit, tryParseMeasure, unitById, type UnitDef } from "../ui/measure";

export interface DimFieldDef {
  name: string;
  label: string;
  kind?: "length" | "angle" | "count"; // default length; count = raw number, no unit
}

interface Field {
  def: DimFieldDef;
  input: HTMLInputElement;
  /** The unit this field is SHOWING. Starts at the document's, follows the user
   *  if they type one, and can be picked from the chip. Per field rather than
   *  global: a value the user chose to enter in inches should go on reading in
   *  inches without changing what every other field in the app shows. */
  unit: UnitDef | null;
  /** the clickable unit chip, or null for a count (which has no unit) */
  chip: HTMLButtonElement | null;
  // false = follows the cursor; true = holds the user's typed/locked value
  userDriven: boolean;
}

/** The unit a field opens in. */
function initialUnit(kind: DimFieldDef["kind"]): UnitDef | null {
  if (kind === "count") return null;
  return unitById(kind === "angle" ? "deg" : getUnit());
}

export class DimInput {
  private root: HTMLDivElement;
  private fields: Field[] = [];
  private onCommit: ((values: Record<string, number>) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private active = false;
  /** The kernel's refusal of what the boxes currently say, drawn under them.
   *  Its own element rather than a title attribute: a tooltip needs a hover the
   *  hand cannot spare mid-drag, and the whole point is that the answer be
   *  where the eye already is. */
  private problem: HTMLDivElement | null = null;
  private unsubscribeError: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "dim-input";
    this.root.style.display = "none";
    document.body.appendChild(this.root);
    // Capture phase, on the window, for the lifetime of the box — see
    // onForeignPress for what it is protecting.
    window.addEventListener("pointerdown", this.boundForeignDown, true);
  }

  /** Drop the box out of hit testing for the duration of a drag that began
   *  somewhere else.
   *
   *  The box hangs over the canvas near what is being dragged, and it is a
   *  sibling of the canvas rather than a child — so the moment the cursor
   *  crossed it, pointermove went to the box and the tool listening on the
   *  canvas simply stopped hearing about the drag. It read as the model sticking
   *  and then jumping, and on a short drag as the value refusing to move at all.
   *
   *  Keyed on where the press LANDED rather than on any tool state: a press on
   *  the box is someone using the box, a press anywhere else is a gesture the
   *  box has no business intercepting, and that rule needs nothing from the
   *  eleven tools that show one. */
  private boundForeignDown = (e: PointerEvent) => this.onForeignPress(e);
  private boundForeignUp = () => this.endForeignPress();
  /** Tool-driven, via setClickThrough. */
  private clickThrough = false;
  /** A drag that started outside the box is in flight. */
  private foreignPress = false;

  private onForeignPress(e: PointerEvent) {
    // Deliberately NOT gated on `active`. The press that arms a tool is the same
    // press that drags it — the box is shown from inside that pointerdown, long
    // after this capture listener has already run — so a gate here would miss
    // the one gesture that needs it most, the grab-the-handle-and-pull entry.
    if (this.foreignPress) return;
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

  /** Free the window listeners. Tools hold one DimInput for their own lifetime
   *  and never disposed one before, so this exists for tests and for any future
   *  tool that is torn down with the document. */
  dispose() {
    this.hide();
    this.endForeignPress();
    window.removeEventListener("pointerdown", this.boundForeignDown, true);
    this.root.remove();
  }

  get isActive() {
    return this.active;
  }

  /** true when `el` is one of THIS dim box's inputs — lets the owning tool's
   *  capture-phase key handler act on Escape for its own box without stealing
   *  Esc from other editors (e.g. a dimension label's inline value input). */
  ownsTarget(el: EventTarget | null): boolean {
    return el instanceof Node && this.root.contains(el);
  }

  /** While a tool is still deciding WHERE to drop something, the box is a
   *  heads-up readout sitting over the canvas, not a widget — a click aimed at
   *  the canvas underneath must reach it instead of hitting confirm. Typing is
   *  unaffected: keystrokes go to the focused input regardless of pointer-events.
   *  Turn it back off once the click-to-place is done, or confirm/cancel become unclickable. */
  setClickThrough(on: boolean) {
    this.clickThrough = on;
    this.applyHitTesting();
  }

  show(
    defs: DimFieldDef[],
    onCommit: (values: Record<string, number>) => void,
    onCancel?: () => void,
  ) {
    this.hide();
    this.setClickThrough(false); // every other tool wants a clickable box
    this.onCommit = onCommit;
    this.onCancel = onCancel ?? null;
    this.active = true;
    this.root.style.display = "flex";
    this.fields = defs.map((def) => {
      const wrap = document.createElement("label");
      wrap.className = "dim-field";
      const name = document.createElement("span");
      name.className = "dim-name";
      name.textContent = def.label;
      wrap.appendChild(name);
      const input = document.createElement("input");
      input.type = "text";
      // NOT inputMode "decimal": that asks a touch keyboard for digits only, and
      // this field takes "1 1/2 in" and "width/2".
      input.inputMode = "text";
      input.autocomplete = "off";
      wrap.appendChild(input);

      const field: Field = { def, input, unit: initialUnit(def.kind), chip: null, userDriven: false };

      if (field.unit) {
        // The unit is a BUTTON, not a caption: clicking it is how you change
        // what the field is showing without retyping the number.
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
      input.addEventListener("input", () => {
        field.userDriven = true; // typing freezes the field from cursor tracking
        wrap.classList.add("typed");
        this.sizeToContent(field);
        this.adoptTypedUnit(field);
      });
      this.sizeToContent(field);
      return field;
    });
    // Visible confirm/cancel — Enter/Esc equivalents for mouse-first work (the
    // Enter-only flow read as "no way to confirm"). pointerdown+preventDefault
    // so pressing them never blurs the input first.
    const ok = document.createElement("button");
    ok.className = "dim-btn dim-ok";
    ok.title = "Confirm (Enter)";
    ok.appendChild(iconElement("check", 13));
    ok.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.commit();
    });
    this.root.appendChild(ok);
    if (this.onCancel) {
      const no = document.createElement("button");
      no.className = "dim-btn dim-no";
      no.title = "Cancel (Esc)";
      no.appendChild(iconElement("close", 13));
      no.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onCancel?.();
      });
      this.root.appendChild(no);
    }
    // focus first field so typing goes straight to it. show() is often called from
    // a pointerdown handler (e.g. extrude's pick→drag), where the browser moves
    // focus to the click target AFTER this handler returns — so re-focus next frame
    // too, or the field silently never holds focus and typing/Tab do nothing.
    this.focus();
    requestAnimationFrame(() => this.focus());
    // Subscribed per showing, not once for the life of the box: a tool that
    // opens while a previous preview is still refused would otherwise inherit
    // the last tool's complaint. onPreviewError fires immediately, so a box
    // that opens onto an already-failing preview shows it rather than waiting
    // for a build that may never be asked for.
    this.unsubscribeError = onPreviewError((m) => this.setProblem(m));
  }

  /** Focus + select the first field. show() calls it; tools whose flow keeps
   *  clicking the canvas while the box stays open must call it again after each
   *  click (the click blurs the input, and typing would silently go nowhere). */
  focus() {
    const f = this.fields[0];
    if (f && this.active) { f.input.focus(); f.input.select(); }
  }

  private onKey(e: KeyboardEvent, field: Field) {
    if (e.key === "Tab") {
      e.preventDefault();
      field.userDriven = true; // Tab locks the current field
      const i = this.fields.indexOf(field);
      const next = this.fields[(i + 1) % this.fields.length];
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

  /** The field grows with what is in it, so a formula is not typed into a box
   *  sized for three digits. Floored so the box does not collapse while empty
   *  and does not twitch on every keystroke of a short value. */
  private sizeToContent(f: Field) {
    f.input.style.width = `${Math.max(5, f.input.value.length + 1)}ch`;
  }

  /** A unit in the TEXT changes what the field is showing. This is the whole
   *  point of the field being unit agnostic: it says mm, you type "1 inch", and
   *  it should not answer by showing you 25.4 mm. The number is left exactly as
   *  typed — only the chip moves. */
  private adoptTypedUnit(f: Field) {
    if (!f.unit) return;
    const m = tryParseMeasure(f.input.value, f.unit);
    if (!m?.unit || m.unit === f.unit) return;
    f.unit = m.unit;
    if (f.chip) f.chip.textContent = m.unit.label;
  }

  /** The chip's menu: pick a unit and the value is CONVERTED, not reinterpreted.
   *  10 mm shown as inches is 0.3937 in, not 10 in. */
  private openUnitMenu(f: Field) {
    if (!f.unit || !f.chip) return;
    this.closeUnitMenu();
    const dim = f.unit.dim;
    const menu = document.createElement("div");
    menu.className = "dim-unit-menu";
    for (const u of commonUnits(dim)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dim-unit-item" + (u.id === f.unit.id ? " active" : "");
      row.textContent = u.label;
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = tryParseMeasure(f.input.value, f.unit);
        f.unit = u;
        if (f.chip) f.chip.textContent = u.label;
        if (current) f.input.value = String(toUnit(current.value, u));
        this.sizeToContent(f);
        this.closeUnitMenu();
        f.input.focus();
      });
      menu.appendChild(row);
    }
    const r = f.chip.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 2}px`;
    document.body.appendChild(menu);
    this.unitMenu = menu;
    // One dismissal path, on the next press anywhere else.
    setTimeout(() => window.addEventListener("pointerdown", this.boundCloseMenu, { once: true, capture: true }), 0);
  }

  private unitMenu: HTMLDivElement | null = null;
  private boundCloseMenu = () => this.closeUnitMenu();

  private closeUnitMenu() {
    this.unitMenu?.remove();
    this.unitMenu = null;
  }

  /** tool pushes cursor-derived values in MM; only tracking fields accept them */
  updateFromCursor(values: Record<string, number>) {
    for (const f of this.fields) {
      const v = values[f.def.name];
      if (!f.userDriven && v != null) {
        f.input.value = String(f.def.kind === "count" ? Math.round(v) : toUnit(v, f.unit));
        this.sizeToContent(f);
        // Keep the live value SELECTED while it tracks the cursor (Fusion-style), so
        // typing a number at any moment replaces it instead of appending.
        if (document.activeElement === f.input) f.input.select();
      }
    }
  }

  /** Pre-fill a field AND lock it (userDriven) so cursor tracking can't clobber
   *  the value — used when re-opening a feature for editing, where the saved
   *  value must hold until the user deliberately retypes or drags a handle. */
  seed(name: string, value: number) {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return;
    f.input.value = String(f.def.kind === "count" ? Math.round(value) : toUnit(value, f.unit));
    f.userDriven = true;
    this.sizeToContent(f);
  }

  /** A DRAG takes a field back from the keyboard.
   *
   *  Typing freezes a field against cursor tracking, and `seed` freezes it from
   *  the start, which is what stops a hand that happens to be moving from
   *  overwriting a value somebody meant. A deliberate drag on the handle that
   *  OWNS the field is the exception `seed` already promises in as many words:
   *  it is every bit as explicit as typing and it is more recent, so the box
   *  follows it.
   *
   *  Without this the handle moves, the geometry follows, and the number beside
   *  it goes on reading what was typed a moment ago, which is the one
   *  arrangement where the user has no way to tell which of the two is true. */
  takeOver(name: string) {
    const f = this.fields.find((x) => x.def.name === name);
    if (f) f.userDriven = false;
  }

  /** Say that what the boxes read cannot be built, or take it back.
   *
   *  Every field turns, not just one, because the sidecar refuses a FEATURE and
   *  not a field: "the profile is 3 mm tall but climbs only 1 mm each turn" is
   *  about the pitch and the angle together, and reddening whichever box was
   *  touched last would point at the wrong number half the time. The user is the
   *  one who knows which of the two they would rather move. */
  private setProblem(message: string | null) {
    if (!this.active) return;
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

  isUserDriven(name: string): boolean {
    const f = this.fields.find((x) => x.def.name === name);
    return !!f && f.userDriven;
  }

  /** returns the field value in MM (length fields converted from display unit) */
  getValue(name: string): number | null {
    const f = this.fields.find((x) => x.def.name === name);
    if (!f) return null;
    // Parsed against THIS field's unit, not the document's: a field the user put
    // into inches must read a bare "2" as two inches.
    if (!f.unit) return parseField(f.input.value, f.def.kind);
    return tryParseMeasure(f.input.value, f.unit)?.value ?? null;
  }

  /** The unit a field is currently showing, so a tool can label its own prompt
   *  with it. Null for a count. */
  unitOf(name: string): UnitDef | null {
    return this.fields.find((x) => x.def.name === name)?.unit ?? null;
  }

  /** the field's RAW text, untouched — for callers that route input through the
   *  expression evaluator (`w/2`, `name=expr`) instead of a bare parseField, and
   *  that must be able to tell "empty" from "unparseable". "" when there is no
   *  such field. */
  getRaw(name: string): string {
    return this.fields.find((x) => x.def.name === name)?.input.value ?? "";
  }

  position(screenX: number, screenY: number) {
    this.root.style.left = `${screenX + 16}px`;
    this.root.style.top = `${screenY + 16}px`;
  }

  private commit() {
    const out: Record<string, number> = {};
    for (const f of this.fields) {
      const v = this.getValue(f.def.name); // already mm-converted
      if (v != null) out[f.def.name] = v;
    }
    this.onCommit?.(out);
  }

  hide() {
    this.active = false;
    this.closeUnitMenu();
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.problem = null; // innerHTML below takes the element with it
    this.root.classList.remove("dim-bad");
    this.root.style.display = "none";
    this.root.innerHTML = "";
    this.fields = [];
    this.onCommit = null;
    this.onCancel = null;
  }
}
