// The picker's thumbnails: the same pixels the viewport samples, painted once
// per style onto a small canvas.

import { matcapPixels } from "../viewport/matcap";
import type { MatcapStyle } from "./renderPrefs";

const SIZE = 64;
const urls = new Map<MatcapStyle, string>();

export function matcapSwatchUrl(style: MatcapStyle): string {
  let url = urls.get(style);
  if (url !== undefined) return url;
  url = "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(matcapPixels(style, SIZE)), SIZE, SIZE), 0, 0);
      url = canvas.toDataURL();
    }
  } catch {
    /* no canvas (headless): the swatch just shows its label */
  }
  urls.set(style, url);
  return url;
}
