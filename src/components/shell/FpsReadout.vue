<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";

const engine = useEngine();
const host = useTemplateRef<HTMLDivElement>("host");

// FpsMeter writes textContent + title on a 250ms interval and is owned by the
// Viewport, which is constructed before Vue exists. So the element is handed to
// it rather than looked up by id, and this component deliberately renders no
// text of its own, a re-render must never fight the meter for the node.
onMounted(() => engine.viewport.attachFpsHost(host.value!));
</script>

<template>
  <div id="fps" class="fps" ref="host"></div>
</template>
