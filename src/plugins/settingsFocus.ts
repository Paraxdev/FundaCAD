// Which plugin's settings Preferences should open on, cleared once shown. A
// plain ref rather than a store field, so the Plugins pane mounts without Pinia.

import { ref } from "vue";

export const pluginFocus = ref<string | null>(null);
