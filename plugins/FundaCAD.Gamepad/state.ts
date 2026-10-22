// Reactive so the line updates when a pad is plugged in with the preferences open. A module ref rather than a store,
// since nothing outside this directory reads it.

import { reactive } from "vue";

export const padState = reactive({ name: null as string | null });
