<script setup lang="ts">
import ListRow from "../ui/ListRow.vue";
import type { HomeFolder } from "../../io/homeFolders";
import { folderName } from "../../ui/homeList";

defineProps<{ folders: readonly HomeFolder[]; view: string; loading: string | null; canAdd: boolean }>();
const emit = defineEmits<{ view: [view: string]; add: []; menu: [path: string, ev: MouseEvent] }>();
</script>

<template>
  <nav class="home-nav">
    <ListRow class="home-recent-row" label="Recent" :selected="view === 'recent'" @click="emit('view', 'recent')" />
    <template v-if="canAdd">
      <div class="home-nav-section">Folders</div>
      <ListRow
        v-for="f in folders"
        :key="f.path"
        class="home-folder-row"
        icon="open"
        :label="folderName(f.path)"
        :selected="view === f.path"
        :title="f.path"
        :aria-busy="loading === f.path"
        @click="emit('view', f.path)"
        @contextmenu.prevent.stop="emit('menu', f.path, $event)"
      />
      <ListRow class="home-add-folder" icon="plus" label="Add folder…" @click="emit('add')" />
    </template>
  </nav>
</template>
