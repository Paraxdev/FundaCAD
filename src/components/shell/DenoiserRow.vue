<script setup lang="ts">
import { onMounted } from "vue";
import { denoiserState as s, describeDenoiser, downloadDenoiser, refreshDenoiser, sizeLabel } from "../../viewport/pathtrace/denoiser";

defineProps<{ hintClass: string; buttonClass: string }>();
onMounted(() => { void refreshDenoiser(); });
</script>

<template>
  <div v-if="s.info" class="denoiser-row" :data-denoiser="s.info.active">
    <p :class="hintClass">{{ describeDenoiser(s) }}</p>
    <button
      v-if="s.info.active !== 'oidn' && s.info.offered"
      type="button"
      :class="buttonClass"
      data-denoiser-download
      :disabled="s.downloading"
      @click="downloadDenoiser()"
    >High quality denoise ({{ sizeLabel(s.info.bytes) }})</button>
  </div>
</template>
