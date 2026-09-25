// Glass without the blur, for machines that draw in software.
//
// A backdrop-filter re-blurs whatever is behind the panel on every repaint of
// that panel, and over a WebGL viewport a software rasteriser (SwiftShader in a
// VM) pays for it on the CPU: a caret blinking in a dialog cost about 1.5 cores.
// So potato mode, or a detected software renderer, puts `no-glass-blur` on <html>
// and _glass.scss drops every backdrop-filter and makes the fills opaque.

import { onRenderPrefsChange, renderPrefs, type RenderPrefs } from "./renderPrefs";

export const NO_GLASS_BLUR_CLASS = "no-glass-blur";

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;

export function isSoftwareRendererName(name: string): boolean {
  return SOFTWARE_RENDERER.test(name);
}

let softwareRenderer = false;

export function glassBlurOff(p: Readonly<RenderPrefs> = renderPrefs(), software = softwareRenderer): boolean {
  return p.potatoMode || software;
}

function apply() {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(NO_GLASS_BLUR_CLASS, glassBlurOff());
}

/** Recorded by the viewport once it has a WebGL context and knows the renderer's name. */
export function setSoftwareRenderer(v: boolean): void {
  if (v === softwareRenderer) return;
  softwareRenderer = v;
  apply();
}

let installed = false;

export function installGlassBlurSwitch(): void {
  if (installed) return;
  installed = true;
  apply();
  onRenderPrefsChange(apply);
}
