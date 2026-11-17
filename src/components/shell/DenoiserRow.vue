<script setup lang="ts">
import { onMounted } from "vue";
import Button from "../ui/Button.vue";
import {
  denoiserState as s,
  describeDenoiser,
  downloadDenoiser,
  refreshDenoiser,
} from "../../viewport/pathtrace/denoiser";
import { t } from "../../i18n";

// buttonClass is declared only so Preferences' button-class does not fall through onto the row.
withDefaults(defineProps<{ hintClass: string; buttonClass?: string; size?: "sm" | "md" }>(), { size: "md" });
onMounted(() => {
  void refreshDenoiser();
});
</script>

<template>
  <div v-if="s.info" class="denoiser-row" :data-denoiser="s.info.active">
    <p :class="hintClass">{{ describeDenoiser(s) }}</p>
    <Button
      v-if="s.info.active !== 'oidn' && s.info.offered"
      :size="size"
      data-denoiser-download
      :disabled="s.downloading"
      @click="downloadDenoiser()"
      >{{ t("render.denoiser.download", { mb: Math.round(s.info.bytes / 1e6) }) }}</Button
    >
  </div>
</template>
