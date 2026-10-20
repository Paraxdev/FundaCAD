<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import { ago } from "../../ui/timeAgo";
import { folderPath, type HomeEntry } from "../../ui/homeList";

const props = defineProps<{ entry: HomeEntry; unreadable?: boolean }>();
const emit = defineEmits<{ open: []; menu: [ev: MouseEvent] }>();

const when = computed(() => {
  const e = props.entry;
  if (e.editedAt != null) return `Edited ${ago(e.editedAt)}`;
  return e.openedAt != null ? `Opened ${ago(e.openedAt)}` : "";
});

const badge = computed(() => {
  if (props.entry.open) return "Open";
  if (props.entry.missing) return "Not found";
  return props.unreadable ? "Could not be read" : null;
});
</script>

<template>
  <button
    class="home-card"
    :class="{ missing: entry.missing }"
    :title="entry.path"
    @click="emit('open')"
    @contextmenu.prevent.stop="emit('menu', $event)"
  >
    <span class="home-card-pic"><Icon name="body" :size="36" /></span>
    <span v-if="badge" class="home-badge">{{ badge }}</span>
    <span class="home-card-name">{{ entry.name }}</span>
    <span class="home-card-folder" :title="folderPath(entry.path)">{{ entry.folder }}</span>
    <span class="home-card-time">{{ when }}</span>
  </button>
</template>
