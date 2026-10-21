<script setup lang="ts">
import Icon from "../shell/Icon.vue";
import type { HomeFolder } from "../../io/homeFolders";
import { folderName } from "../../ui/homeList";

defineProps<{ folders: readonly HomeFolder[]; view: string; loading: string | null; canAdd: boolean }>();
const emit = defineEmits<{ view: [view: string]; add: []; menu: [path: string, ev: MouseEvent] }>();
</script>

<template>
  <nav class="home-nav">
    <button class="home-nav-row" :class="{ active: view === 'recent' }" @click="emit('view', 'recent')">Recent</button>
    <template v-if="canAdd">
      <div class="home-nav-section">Folders</div>
      <button
        v-for="f in folders"
        :key="f.path"
        class="home-nav-row home-folder-row"
        :class="{ active: view === f.path }"
        :title="f.path"
        :aria-busy="loading === f.path"
        @click="emit('view', f.path)"
        @contextmenu.prevent.stop="emit('menu', f.path, $event)"
      >
        <Icon name="open" :size="14" />
        <span class="home-nav-label">{{ folderName(f.path) }}</span>
      </button>
      <button class="home-nav-row home-add-folder" @click="emit('add')">
        <Icon name="plus" :size="14" />
        <span class="home-nav-label">Add folder…</span>
      </button>
    </template>
  </nav>
</template>
