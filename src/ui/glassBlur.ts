// Glass without blur for software renderers: a backdrop-filter over the WebGL viewport under SwiftShader cost about
// 1.5 cores for a blinking caret. Potato mode or a software renderer sets `no-glass-blur` on <html> for _glass.scss.
// Solid panels (a11yPrefs, implied by More and Maximum contrast) sets it too, and `solid-panels` for opaque fills.

import { a11yPrefs, onA11yPrefsChange } from "./a11yPrefs";
import { contrastSetting, onContrastChange } from "./contrastSetting";
import { onRenderPrefsChange, renderPrefs, type RenderPrefs } from "./renderPrefs";

export const NO_GLASS_BLUR_CLASS = "no-glass-blur";
export const SOLID_PANELS_CLASS = "solid-panels";

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;

export function isSoftwareRendererName(name: string): boolean {
  return SOFTWARE_RENDERER.test(name);
}

let softwareRenderer = false;

export function solidPanelsOn(): boolean {
  return a11yPrefs().solidPanels || contrastSetting() !== "standard";
}

export function glassBlurOff(
  p: Readonly<RenderPrefs> = renderPrefs(),
  software = softwareRenderer,
  solid = solidPanelsOn(),
): boolean {
  return p.potatoMode || software || solid;
}

function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement.classList;
  root.toggle(NO_GLASS_BLUR_CLASS, glassBlurOff());
  root.toggle(SOLID_PANELS_CLASS, solidPanelsOn());
}

export function isSoftwareRenderer(): boolean {
  return softwareRenderer;
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
  onA11yPrefsChange(apply);
  onContrastChange(apply);
}
