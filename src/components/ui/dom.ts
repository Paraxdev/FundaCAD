// The base set for imperative TS code (tool boxes, io): the same controls as the Vue components, built as DOM.

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
