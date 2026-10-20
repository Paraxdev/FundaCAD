<script setup lang="ts">
import { onUnmounted, reactive } from "vue";
import { RenderChoices, RenderSection, RenderSlider, RenderSwitch } from "fundacad/ui";
import { DIRECTIONS, LIMITS } from "./look";
import { settings } from "./settings";

const v = reactive(settings.all());
const off = settings.onChange(() => Object.assign(v, settings.all()));
onUnmounted(off);

const options = DIRECTIONS.map((d) => ({ id: d.id, label: d.label }));
const set = (key: string, value: unknown) => settings.set(key, value);
</script>

<template>
  <RenderSection title="Printed look" hint="Draws layer lines in the Realtime view only. The model is unchanged.">
    <RenderSwitch label="Layer lines" :value="v.layerLines as boolean" @update="set('layerLines', $event)" />
    <template v-if="v.layerLines">
      <RenderSlider
        label="Layer height"
        :value="v.layerHeight as number"
        :min="LIMITS.layerHeight[0]"
        :max="LIMITS.layerHeight[1]"
        :step="0.01"
        @update="set('layerHeight', $event)"
      />
      <RenderChoices label="Direction" :value="v.direction as string" :options="options" @update="set('direction', $event)" />
      <RenderSlider label="Depth" :value="v.depth as number" :min="LIMITS.depth[0]" :max="LIMITS.depth[1]" :step="0.01" @update="set('depth', $event)" />
    </template>
  </RenderSection>
</template>
