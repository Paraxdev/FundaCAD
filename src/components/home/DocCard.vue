<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../shell/Icon.vue";
import { ago } from "../../ui/timeAgo";
import { folderPath, type HomeEntry } from "../../ui/homeList";
import type { ThumbQueue } from "../../ui/thumbQueue";

const props = defineProps<{ entry: HomeEntry; unreadable?: boolean; thumbs?: ThumbQueue | null }>();
const emit = defineEmits<{ open: []; menu: [ev: MouseEvent]; versions: [] }>();

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

const root = ref<HTMLElement | null>(null);
const pic = ref<string | null>(null);
let inView = false;
let watcher: IntersectionObserver | null = null;

function ask(): void {
  const { path, editedAt, missing } = props.entry;
  if (!props.thumbs || missing || editedAt == null) return;
  props.thumbs.request(path, editedAt, (url) => {
    pic.value = url;
  });
}

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    inView = true;
    return ask();
  }
  watcher = new IntersectionObserver(
    (seen) => {
      inView = seen.some((s) => s.isIntersecting);
      if (inView) ask();
      else props.thumbs?.cancel(props.entry.path);
    },
    { root: root.value?.closest(".home-scroll") ?? null, rootMargin: "200px" },
  );
  watcher.observe(root.value!);
});
watch(
  () => [props.entry.editedAt, props.entry.missing],
  () => {
    if (inView) ask();
  },
);
onUnmounted(() => {
  watcher?.disconnect();
  props.thumbs?.cancel(props.entry.path);
});
</script>

<template>
  <div class="home-cell">
    <button
      ref="root"
      class="home-card"
      :class="{ missing: entry.missing }"
      :title="entry.path"
      @click="emit('open')"
      @contextmenu.prevent.stop="emit('menu', $event)"
    >
      <span class="home-card-pic">
        <img v-if="pic" :src="pic" alt="" draggable="false" />
        <Icon v-else name="body" :size="36" />
      </span>
      <span v-if="badge" class="home-badge">{{ badge }}</span>
      <span class="home-card-name">{{ entry.name }}</span>
      <span class="home-card-folder" :title="folderPath(entry.path)">{{ entry.folder }}</span>
      <span class="home-card-time">{{ when }}</span>
    </button>
    <button
      v-if="!entry.missing"
      class="home-card-versions"
      title="Versions"
      :aria-label="`Versions of ${entry.name}`"
      @click="emit('versions')"
    >
      <Icon name="versions" :size="14" />
    </button>
  </div>
</template>
