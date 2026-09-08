// Whether this capability's settings window is open.
//
// A ref in the capability's own directory, not a field on the app's dialog
// store. The app used to carry `dialogs.spaceMouse` beside `dialogs.welcome`
// and `dialogs.preferences`, which meant the core held one piece of state for
// every capability that might want a window, and a fourth capability would have
// meant a fourth field in a file that has nothing to do with any of them.
//
// A plain `ref` rather than a Pinia store because nothing outside this directory
// reads it, there is no devtools value in a store with one boolean in it, and a
// module-level ref works in the headless suite without a Pinia instance.

import { ref } from "vue";

export const settingsOpen = ref(false);

export function openSettings() {
  settingsOpen.value = true;
}

export function closeSettings() {
  settingsOpen.value = false;
}
