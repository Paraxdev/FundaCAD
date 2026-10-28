<script setup lang="ts">
// Absent, not greyed, when nobody is attached. When one is, it says what the assistant last did and disconnects in one
// click, which is why the live session setting can default to on.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDialogStore } from "../../stores/dialogs";
import { liveEditsAllowed, onLiveEditingChange } from "../../ui/liveEditing";
import type { LiveState } from "../../live/liveSession";
import Icon from "./Icon.vue";
import Chip from "../ui/Chip.vue";

const engine = useEngine();
const dialogs = useDialogStore();

const state = ref<LiveState>(engine.live.snapshot);
const canEdit = ref(liveEditsAllowed());
const stops: (() => void)[] = [];
onMounted(() => {
  stops.push(
    engine.live.subscribe((s) => {
      state.value = s;
    }),
    onLiveEditingChange(() => {
      canEdit.value = liveEditsAllowed();
    }),
  );
});
onUnmounted(() => {
  for (const stop of stops) stop();
});

const attached = computed(() => state.value.sharing && state.value.guests.length > 0);

const label = computed(() => {
  const n = state.value.guests.length;
  if (n === 1) return state.value.guests[0];
  return `${n} assistants`;
});

// The last edit, for as long as it is still news. A note that stays up forever
// stops meaning "just now" and starts being decoration.
const RECENT_MS = 12000;
const recent = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    const at = state.value.lastEdit?.at ?? 0;
    recent.value = at > 0 && Date.now() - at < RECENT_MS;
  }, 1000);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

const title = computed(() =>
  canEdit.value
    ? `${label.value} is connected to this document and can edit it. Click to change.`
    : `${label.value} is connected and can read this document but not change it. Click to change.`,
);
</script>

<template>
  <!-- title, not tip: the tip would become the name, and the name is who is attached and what they did. -->
  <Chip
    v-if="attached"
    id="live-pill"
    as="button"
    :variant="canEdit ? 'accent' : 'neutral'"
    class="live-pill"
    :class="{ readonly: !canEdit }"
    :title="title"
    @click="dialogs.preferences = true"
  >
    <Icon name="dot" :size="8" class="live-dot" />
    <span class="live-who">{{ label }}</span>
    <span v-if="recent && state.lastEdit?.note" class="live-note">{{ state.lastEdit.note }}</span>
  </Chip>
</template>
