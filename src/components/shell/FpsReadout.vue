<script setup lang="ts">
import { onMounted, useTemplateRef } from "vue";
import { useEngine } from "../../app/engineKey";

const engine = useEngine();
const host = useTemplateRef<HTMLDivElement>("host");

// FpsMeter (owned by the Viewport, built before Vue) writes textContent every 250ms, so it gets the element and this
// renders no text a re-render could fight it over.
onMounted(() => engine.viewport.attachFpsHost(host.value!));
</script>

<template>
  <div id="fps" class="fps" ref="host"></div>
</template>
