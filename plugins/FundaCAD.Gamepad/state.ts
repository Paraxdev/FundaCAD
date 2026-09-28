// Which pad is being read, for the settings section to show. Reactive so the
// line updates when a pad is plugged in with the preferences already open.
//
// Module-level rather than a store, for the reason the 3D mouse gives for its
// own: nothing outside this directory reads it.

import { reactive } from "vue";

export const padState = reactive({ name: null as string | null });
