// Modify → Parameters: a facade over components/overlays/ParamsDialog.vue for app/actions.ts and the menubar.

import { usePanelsStore } from "../stores/panels";

export function openParamsDialog(): void {
  usePanelsStore().params = true;
}
