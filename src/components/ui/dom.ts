// The base set for imperative TS code (tool boxes, io): the same controls as the Vue components, built as DOM.

import { iconElement } from "../../ui/icons";
import { unitById } from "../../ui/measure";
import { tipText } from "./tip";
import { swallowDisabled } from "./useDisabled";

/** The browser file picker, for code with no component to hold a hidden input. Null when dismissed; a webview
 *  without the input's cancel event leaves a dismissed pick pending, as a hidden input in a template does. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

interface DisabledOptions {
  disabled?: boolean | undefined;
  /** The tooltip while disabled, saying why. */
  disabledReason?: string | undefined;
  /** Greyed but still answers a click, a soft block the click lifts. */
  clickable?: boolean | undefined;
}

let seq = 0;
const tips = new WeakMap<Element, string | undefined>();
const hardDisabled = new WeakSet<Element>();

function setTitle(el: Element, title: string | undefined) {
  if (title) el.setAttribute("title", title);
  else el.removeAttribute("title");
}

function blocked(el: Element): boolean {
  return hardDisabled.has(el) && el.getAttribute("aria-disabled") === "true";
}

/** useDisabled's model: aria-disabled and .is-disabled, the reason as the tooltip, its activation swallowed. */
function initDisabled(el: HTMLElement, tip: string | undefined, o: DisabledOptions) {
  tips.set(el, tip);
  if (!o.clickable) {
    hardDisabled.add(el);
    const swallow = (e: Event) => {
      if (blocked(el)) swallowDisabled(e);
    };
    el.addEventListener("click", swallow, true);
    el.addEventListener("keydown", swallow, true);
  }
  setDisabled(el, !!o.disabled, o.disabledReason);
}

/** Greys a control made here out, or frees it. */
export function setDisabled(el: HTMLElement, disabled: boolean, reason?: string): void {
  if (disabled) el.setAttribute("aria-disabled", "true");
  else el.removeAttribute("aria-disabled");
  el.classList.toggle("is-disabled", disabled);
  setTitle(el, disabled && reason ? reason : tips.get(el));
}

/** A toggle's state, as Button's `pressed` and IconButton's `active` set it. */
export function setPressed(el: HTMLElement, on: boolean): void {
  el.setAttribute("aria-pressed", String(on));
  el.classList.toggle("is-on", on);
  if (el.classList.contains("icon-btn")) el.classList.toggle("active", on);
}

/** Acts on a primary press without moving focus (a tool box keeps its field), and on a click no press led to: Enter,
 *  Space and a screen reader's activation (NVDA browse mode, VoiceOver VO+Space, Orca) send only the click. */
export function onActivate(el: HTMLElement, act: (e: Event) => void): void {
  let press: { up: number } | null = null;
  el.addEventListener("pointerdown", (e) => {
    // `> 0`, not `!== 0`: a synthetic press (tests, the harness) is a plain Event with no button.
    if (e.button > 0) return;
    e.preventDefault();
    if (blocked(el)) return;
    const p = { up: Infinity };
    press = p;
    // Registered before act, so a capture listener act adds to swallow the release cannot hide it from this one.
    const up = () => {
      p.up = performance.now();
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    act(e);
  });
  el.addEventListener("click", (e) => {
    const p = press;
    press = null;
    // A press's own click follows its release, later on touch; a release off the control sends none.
    if (p && performance.now() - p.up < 1000) return;
    act(e);
  });
}

export interface UiButtonOptions extends DisabledOptions {
  /** The visible text, and so the name. Without it the tip names the button. */
  label?: string | undefined;
  icon?: string | undefined;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "tile";
  size?: "sm" | "md";
  block?: boolean;
  pressed?: boolean | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
}

/** Button.vue as DOM. */
export function uiButton(o: UiButtonOptions = {}): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  const variant = o.variant ?? "secondary";
  b.className = `btn btn-${variant}`;
  if (variant !== "tile") b.classList.add(`btn-${o.size ?? "md"}`);
  if (o.block) b.classList.add("btn-block");
  if (o.pressed !== undefined) setPressed(b, o.pressed);
  if (o.icon) b.append(iconElement(o.icon, 14));
  const tip = tipText(o.tip, o.keys);
  if (o.label !== undefined) {
    const text = document.createElement("span");
    text.className = "btn-label";
    text.textContent = o.label;
    b.append(text);
  } else if (tip) b.setAttribute("aria-label", tip);
  initDisabled(b, tip, o);
  return b;
}

export interface UiIconButtonOptions extends DisabledOptions {
  icon: string;
  /** Required: an icon has no text, so this is its only name. */
  tip: string;
  keys?: string | undefined;
  size?: "sm" | "md" | "lg";
  variant?: "plain" | "tile" | "danger";
  active?: boolean | undefined;
  iconSize?: number | undefined;
  badge?: string | number | null;
}

/** IconButton.vue as DOM. */
export function uiIconButton(o: UiIconButtonOptions): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  const size = o.size ?? "lg";
  b.className = `icon-btn icon-btn-${o.variant ?? "tile"} icon-btn-${size}`;
  if (o.active !== undefined) setPressed(b, o.active);
  const tip = tipText(o.tip, o.keys)!;
  const badged = o.badge !== undefined && o.badge !== null && o.badge !== "";
  b.setAttribute("aria-label", badged ? `${tip}, ${o.badge}` : tip);
  b.append(iconElement(o.icon, o.iconSize ?? (size === "lg" ? 20 : 14)));
  if (badged) {
    const badge = document.createElement("span");
    badge.className = "chip chip-error chip-xs icon-btn-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = String(o.badge);
    b.append(badge);
  }
  initDisabled(b, tip, o);
  return b;
}

export interface UiUnitChipOptions extends DisabledOptions {
  /** A ui/measure unit id shows its label ("deg" as °), any other text shows as written. */
  unit: string;
  /** Unit ids to pick from. Without them the chip is a caption. */
  options?: readonly string[] | undefined;
  /** The picker's name, and the caption's title. */
  tip?: string | undefined;
  keys?: string | undefined;
}

const unitLabel = (id: string) => unitById(id)?.label ?? id;

/** UnitChip.vue as DOM: a caption span, or with options the closed Select chip trigger. The caller owns the menu
 *  and marks it with setExpanded. */
export function uiUnitChip(o: UiUnitChipOptions): HTMLElement {
  if (!o.options?.length) {
    const caption = document.createElement("span");
    caption.className = "ui-unit-chip";
    setTitle(caption, o.tip);
    caption.textContent = unitLabel(o.unit);
    return caption;
  }
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "combobox");
  b.className = "ui-unit-chip is-picker ui-select-sm";
  const tip = tipText(o.tip ?? "Unit", o.keys)!;
  b.setAttribute("aria-label", tip);
  b.setAttribute("aria-haspopup", "listbox");
  b.setAttribute("aria-expanded", "false");
  const value = document.createElement("span");
  value.className = "select-value";
  b.append(value);
  setChipUnit(b, o.unit);
  initDisabled(b, tip, o);
  return b;
}

/** The unit a chip shows. */
export function setChipUnit(chip: HTMLElement, unit: string): void {
  if (chip.getAttribute("role") !== "combobox") {
    chip.textContent = unitLabel(unit);
    return;
  }
  chip.dataset.value = unit;
  chip.querySelector(".select-value")!.textContent = unitLabel(unit);
}

/** A picker trigger's open state, with the id of the list it opened. */
export function setExpanded(trigger: HTMLElement, open: boolean, listId?: string): void {
  trigger.setAttribute("aria-expanded", String(open));
  trigger.classList.toggle("open", open);
  trigger.classList.toggle("is-open", open);
  if (open && listId) trigger.setAttribute("aria-controls", listId);
  else trigger.removeAttribute("aria-controls");
}

export interface UiNumberInputOptions extends DisabledOptions {
  /** The name, and the title. */
  tip?: string | undefined;
  keys?: string | undefined;
  size?: "sm" | "md";
  /** "text" for a field that takes fractions and expressions such as "1 1/2 in" or "width/2". */
  inputMode?: "decimal" | "text" | "numeric";
  value?: string | undefined;
  unit?: string | null | undefined;
  units?: readonly string[] | undefined;
  unitTip?: string | undefined;
  widthCh?: number | undefined;
  placeholder?: string | undefined;
}

export interface UiNumberInput {
  root: HTMLSpanElement;
  input: HTMLInputElement;
  /** The unit chip, null without a unit. */
  chip: HTMLElement | null;
}

/** NumberField.vue's markup as DOM; the caller reads and commits the text. */
export function uiNumberInput(o: UiNumberInputOptions = {}): UiNumberInput {
  const root = document.createElement("span");
  root.className = `ui-field ui-number-field ui-field-${o.size ?? "md"}`;
  if (o.disabled) root.classList.add("is-disabled");
  if (o.widthCh !== undefined) {
    root.classList.add("has-ch");
    root.style.setProperty("--field-ch", String(o.widthCh));
  }
  const input = document.createElement("input");
  input.type = "text";
  input.setAttribute("inputmode", o.inputMode ?? "decimal");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  if (o.placeholder !== undefined) input.placeholder = o.placeholder;
  if (o.disabled) input.readOnly = true;
  const tip = tipText(o.tip, o.keys);
  if (tip) input.setAttribute("aria-label", tip);
  input.value = o.value ?? "";
  initDisabled(input, tip, o);
  root.append(input);
  root.addEventListener("mousedown", (e) => {
    if (e.target !== root) return;
    e.preventDefault();
    input.focus();
  });
  const chip = o.unit
    ? uiUnitChip({ unit: o.unit, options: o.units, tip: o.unitTip, disabled: o.disabled, clickable: o.clickable })
    : null;
  if (chip) root.append(chip);
  return { root, input, chip };
}

/** A number input's refusal, or null once it reads. */
export function setInvalid(f: UiNumberInput, reason: string | null): void {
  if (reason) f.input.setAttribute("aria-invalid", "true");
  else f.input.removeAttribute("aria-invalid");
  f.root.classList.toggle("is-error", !!reason);
  setTitle(f.input, reason ?? tips.get(f.input));
}

export interface UiSliderOptions extends DisabledOptions {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string | undefined;
  showValue?: boolean;
  unit?: string | undefined;
  /** The spoken value in place of the readout, such as "0.7, rounded". */
  valueText?: ((value: number) => string) | undefined;
  tip?: string | undefined;
  keys?: string | undefined;
  /** Every move; `committed` once a drag is released or a key stepped it. */
  onValue?: ((value: number, committed: boolean) => void) | undefined;
}

export interface UiSlider {
  root: HTMLDivElement;
  input: HTMLInputElement;
  /** Shows a value from outside without calling back. */
  set(value: number): void;
}

/** Slider.vue as DOM, keys stepped by hand so a press is one update in every engine. */
export function uiSlider(o: UiSliderOptions): UiSlider {
  const min = o.min ?? 0;
  const max = o.max ?? 100;
  const step = o.step ?? 1;
  const decimals = (String(step).split(".")[1] ?? "").length;
  const id = `ui-dom-${++seq}`;
  const root = document.createElement("div");
  root.className = "ui-slider";
  const tip = tipText(o.tip, o.keys);
  if (o.label) {
    const label = document.createElement("span");
    label.id = `${id}-label`;
    label.className = "ui-slider-label";
    label.textContent = o.label;
    root.append(label);
  }
  const input = document.createElement("input");
  input.type = "range";
  input.className = "ui-slider-input";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  if (o.label) input.setAttribute("aria-labelledby", `${id}-label`);
  else if (tip) input.setAttribute("aria-label", tip);
  if (o.disabled) input.setAttribute("aria-disabled", "true");
  root.append(input);
  const output = o.showValue ? document.createElement("output") : null;
  if (output) {
    output.className = "ui-slider-value";
    root.append(output);
  }
  const readout = (v: number) => (!o.unit ? String(v) : o.unit === "%" ? `${v}%` : `${v} ${o.unit}`);
  let model = o.value;
  const paint = (v: number) => {
    input.value = String(v);
    const span = max - min;
    const fill = span > 0 ? `${((Math.min(Math.max(v, min), max) - min) / span) * 100}%` : "0%";
    input.style.setProperty("--ui-slider-fill", fill);
    const spoken = o.valueText?.(v) ?? (o.unit ? readout(v) : undefined);
    if (spoken) input.setAttribute("aria-valuetext", spoken);
    if (output) output.textContent = readout(v);
  };
  const isOff = () => root.getAttribute("aria-disabled") === "true";
  const take = (v: number, committed: boolean) => {
    model = v;
    paint(v);
    o.onValue?.(v, committed);
  };
  input.addEventListener("input", () => (isOff() ? paint(model) : take(Number(input.value), false)));
  input.addEventListener("change", () => (isOff() ? paint(model) : take(Number(input.value), true)));
  const snap = (v: number) => {
    const s = Math.min(Math.max(min + Math.round((v - min) / step) * step, min), max);
    return Number(s.toFixed(decimals));
  };
  input.addEventListener("keydown", (e) => {
    const big = Math.max(step, (max - min) / 10);
    const to: Record<string, (v: number) => number> = {
      ArrowRight: (v) => v + step,
      ArrowUp: (v) => v + step,
      ArrowLeft: (v) => v - step,
      ArrowDown: (v) => v - step,
      PageUp: (v) => v + big,
      PageDown: (v) => v - big,
      Home: () => min,
      End: () => max,
    };
    const move = to[e.key];
    if (!move || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (isOff()) return;
    const v = snap(move(model));
    if (v !== model) take(v, true);
  });
  paint(model);
  initDisabled(root, tip, o);
  return {
    root,
    input,
    set: (v) => {
      model = v;
      paint(v);
    },
  };
}
