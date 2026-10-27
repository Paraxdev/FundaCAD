<script setup lang="ts">
// Absent, not greyed, when nobody is attached. When one is, it says what the assistant last did and disconnects in one
// click, which is why the live session setting can default to on.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDialogStore } from "../../stores/dialogs";
import { liveEditsAllowed, onLiveEditingChange } from "../../ui/liveEditing";
import type { LiveState } from "../../live/liveSession";
import Icon from "./Icon.vue";

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
  <button
    v-if="attached"
    id="live-pill"
    class="live-pill"
    :class="{ readonly: !canEdit }"
    :title="title"
    @click="dialogs.preferences = true"
  >
    <Icon name="dot" :size="8" class="live-dot" />
    <span class="live-who">{{ label }}</span>
    <span v-if="recent && state.lastEdit?.note" class="live-note">{{ state.lastEdit.note }}</span>
  </button>
</template>

<style scoped>
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 22rem;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--accent-tint);
  color: var(--fg, inherit);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.live-pill.readonly {
  background: var(--float-chip-bg);
  opacity: 0.85;
}
.live-dot {
  color: var(--accent);
  flex: none;
}
.live-pill.readonly .live-dot {
  color: var(--muted, #999);
}
.live-who {
  white-space: nowrap;
}
/* The note may truncate: the assistant writes it, and the tooltip and timeline already say it whole. */
.live-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}
</style>
