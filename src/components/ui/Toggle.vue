<script lang="ts">
import { defineComponent, h, type Component } from "vue";
import SwitchRow from "./SwitchRow.vue";

// Renamed SwitchRow.vue; this path stays so its callers keep their import. A wrapper of its own, so the
// SFC plugin's dev stamps land here and not on SwitchRow, whose hot reload keeps working.
export default defineComponent({
  name: "Toggle",
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    return () => h(SwitchRow as Component, attrs, slots);
  },
}) as unknown as typeof SwitchRow;
</script>
