// What the panel and the Items rows read. Module refs rather than fields on an
// app store: nothing outside this directory reads them.

import { ref, shallowRef } from "vue";
import type { V2 } from "./calibrate";
import type { RefImageTool } from "./tool";

/** The image the panel shows, null when the panel is closed. */
export const selected = ref<string | null>(null);

export type CalibrateStep =
  | { id: string; stage: "first" }
  | { id: string; stage: "second"; a: V2 }
  | { id: string; stage: "distance"; a: V2; b: V2 };

export const calibrating = shallowRef<CalibrateStep | null>(null);

/** Bumped when an image is found missing, so the rows say so. */
export const missingTick = ref(0);

/** The running tool, while the plugin is on. */
export const tool = shallowRef<RefImageTool | null>(null);
