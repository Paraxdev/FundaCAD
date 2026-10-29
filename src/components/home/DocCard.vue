<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, useTemplateRef, watch } from "vue";
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
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

const pathId = useId();
const card = useTemplateRef<InstanceType<typeof Button>>("card");
const root = (): HTMLElement | null => card.value?.$el ?? null;
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
    { root: root()?.closest(".home-scroll") ?? null, rootMargin: "200px" },
  );
  watcher.observe(root()!);
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
    <Button
      ref="card"
      variant="tile"
      class="home-card"
      :class="{ missing: entry.missing }"
      :title="entry.path"
      :aria-describedby="pathId"
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
    </Button>
    <span :id="pathId" hidden>{{ entry.path }}</span>
    <IconButton
      v-if="!entry.missing"
      class="home-card-versions"
      icon="versions"
      tip="Versions"
      size="md"
      variant="tile"
      :icon-size="14"
      :aria-label="`Versions of ${entry.name}`"
      @click="emit('versions')"
    />
  </div>
</template>
