// No right-click anywhere in the app opens the webview's own menu. A handler
// that opens one of ours prevents the default first; whatever reaches the window
// unclaimed is stopped here. Text fields and selected text get our own
// Cut / Copy / Paste / Select all, since the native menu was the only way to
// paste into them with the mouse.

import { contextMenu, type CtxItem } from "./menu";

type TextField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

function textField(t: EventTarget | null): TextField | null {
  if (t instanceof HTMLTextAreaElement) return t;
  if (t instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(t.type)) return t;
  return null;
}

function editableHost(t: EventTarget | null): HTMLElement | null {
  return t instanceof HTMLElement ? t.closest<HTMLElement>("[contenteditable='true'], [contenteditable='']") : null;
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    document.execCommand("copy");
  }
}

async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function announce(field: TextField) {
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function fieldMenu(field: TextField): CtxItem[] {
  // `number` inputs have no selection API, so they take whole-value copy and paste.
  const ranged = field.selectionStart !== null;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? field.value.length;
  const picked = ranged ? field.value.slice(start, end) : field.value;
  const readOnly = field.readOnly || field.disabled;
  const replace = (text: string) => {
    field.focus();
    if (ranged) field.setRangeText(text, start, end, "end");
    else field.value = text;
    announce(field);
  };
  return [
    { label: "Cut", shortcut: "Ctrl+X", disabled: readOnly || !picked, onClick: () => { void writeClipboard(picked); replace(""); } },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !picked, onClick: () => void writeClipboard(picked) },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      disabled: readOnly,
      onClick: () => void readClipboard().then((text) => { if (text !== null) replace(text); }),
    },
    { separator: true, label: "" },
    { label: "Select all", shortcut: "Ctrl+A", disabled: !field.value, onClick: () => { field.focus(); field.select(); } },
  ];
}

function editableMenu(host: HTMLElement): CtxItem[] {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const picked = sel?.toString() ?? "";
  const restore = () => {
    host.focus();
    if (range && sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };
  return [
    { label: "Cut", shortcut: "Ctrl+X", disabled: !picked, onClick: () => { void writeClipboard(picked); restore(); document.execCommand("delete"); } },
    { label: "Copy", shortcut: "Ctrl+C", disabled: !picked, onClick: () => void writeClipboard(picked) },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      onClick: () => void readClipboard().then((text) => {
        if (text === null) return;
        restore();
        document.execCommand("insertText", false, text);
      }),
    },
    { separator: true, label: "" },
    {
      label: "Select all",
      shortcut: "Ctrl+A",
      onClick: () => {
        host.focus();
        const r = document.createRange();
        r.selectNodeContents(host);
        sel?.removeAllRanges();
        sel?.addRange(r);
      },
    },
  ];
}

/** The menu a right-click nobody else claimed gets, or null for none at all. */
export function fallbackMenu(target: EventTarget | null): CtxItem[] | null {
  const field = textField(target);
  if (field) return fieldMenu(field);
  const host = editableHost(target);
  if (host) return editableMenu(host);
  const sel = window.getSelection();
  const picked = sel?.toString() ?? "";
  if (picked.trim() && target instanceof Node && sel?.containsNode(target, true)) return [{ label: "Copy", shortcut: "Ctrl+C", onClick: () => void writeClipboard(picked) }];
  return null;
}

export function installContextMenuGuard(): void {
  window.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    // Developers still reach the inspector with Ctrl+Shift+right-click in dev.
    if (import.meta.env.DEV && e.ctrlKey && e.shiftKey) return;
    e.preventDefault();
    const items = fallbackMenu(e.target);
    if (items) contextMenu(e.clientX, e.clientY, items);
  });
}
