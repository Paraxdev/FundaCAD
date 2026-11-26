// The desktop app refuses a dropped or picked panorama in English (src-tauri/src/panorama_read.rs and the checks of
// src-tauri/src/doc_paths.rs it runs). Each form is kept as the Rust format string, so a test holds it to the source.

import { t, type MessageKey } from "../i18n";
import { shownMessage } from "./wordedError";

export interface PanoramaForm {
  rust: string;
  key: MessageKey;
}

export const PANORAMA_REFUSALS: readonly PanoramaForm[] = [
  { rust: "{raw} is not an .hdr or .exr panorama, so it was not read.", key: "render.hdr.notPanoramaFile" },
  { rust: "{raw} was not dropped or picked in this session, so it was not read.", key: "render.hdr.notHandedOver" },
  { rust: "{raw} names a Windows device or a file stream, so it was not read.", key: "render.hdr.deviceOrStream" },
  { rust: "{raw} is not a file", key: "render.hdr.notAFile" },
  { rust: "{raw} is larger than {} MB, too big to use as an environment.", key: "render.hdr.fileTooLarge" },
];

/** Passed on as the Rust wrote them: an OS error after the path. */
export const PANORAMA_PASSED_ON: readonly string[] = ["{raw}: {e}"];

let patterns: { key: MessageKey; re: RegExp }[] | null = null;

function compile({ rust, key }: PanoramaForm) {
  const source = rust
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace("\\{raw\\}", "(.+)")
    .replace("\\{\\}", "([0-9]+)");
  return { key, re: new RegExp(`^${source}$`) };
}

/** Why the desktop app would not hand the panorama over, in the chosen language when it is one of its refusals. */
export function panoramaRefusalText(err: unknown): string {
  const message = shownMessage(err);
  for (const { key, re } of (patterns ??= PANORAMA_REFUSALS.map(compile))) {
    const m = re.exec(message);
    if (m) return t(key, { path: m[1]!, mb: Number(m[2] ?? 0) });
  }
  return message;
}
