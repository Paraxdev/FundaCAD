// Whether the setup panel is open. A module ref rather than a field on the
// app's panel store, for the reason plugins/FundaCAD.Printing/state.ts gives:
// nothing outside this directory reads it.

import { ref } from "vue";

export const setupOpen = ref(false);
