// Shared reads for the plugin panel accessibility specs: the name a screen reader gives a control, and the raw
// controls a panel still draws past the base set.

export const CONTROLS =
  "input, select, textarea, button, [role=combobox], [role=switch], [role=radio], [role=checkbox], [role=slider]";

export function textOf(ids: string | null): string {
  return (ids ?? "")
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent?.trim() ?? "") : ""))
    .join(" ")
    .trim();
}

export function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const by = textOf(el.getAttribute("aria-labelledby"));
  if (by) return by;
  if (el.id) {
    const text = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim();
    if (text) return text;
  }
  const wrapping = el.closest("label")?.textContent?.trim();
  if (wrapping) return wrapping;
  return el.tagName === "BUTTON" || el.getAttribute("role") === "radio" ? (el.textContent?.trim() ?? "") : "";
}

export const describedBy = (el: Element) => textOf(el.getAttribute("aria-describedby"));
export const controlsOf = (root: Element) => [...root.querySelectorAll(CONTROLS)];
export const unnamed = (root: Element) =>
  controlsOf(root)
    .filter((el) => !nameOf(el))
    .map((el) => el.outerHTML.slice(0, 120));

export function rawControls(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("select, textarea, input")) {
    const type = el.getAttribute("type");
    if (el.tagName === "SELECT") out.push("select");
    else if (type === "range" && !el.closest(".ui-slider")) out.push("range");
    else if (type === "checkbox" && !el.closest(".ui-checkbox, .ui-switch")) out.push("checkbox");
    else if (type !== "range" && type !== "checkbox" && !el.closest(".ui-field")) out.push(`input[${type}]`);
  }
  for (const el of root.querySelectorAll("button")) {
    if (!/\b(btn|ui-[\w-]+|select-trigger)\b/.test(el.className)) out.push(`button.${el.className || "plain"}`);
  }
  return out;
}

export const byName = <T extends Element>(root: Element, sel: string, name: string | RegExp) =>
  [...root.querySelectorAll<T>(sel)].find((el) =>
    typeof name === "string" ? nameOf(el) === name : name.test(nameOf(el)),
  );

export function stubResizeObserver(stub: (name: string, value: unknown) => void) {
  stub(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
