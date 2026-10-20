<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useHomeStore } from "../../stores/home";
import { useModalStore } from "../../stores/modals";
import { useModalGate } from "../../composables/useModalGate";
import { welcomeOnStartup, setWelcomeOnStartup } from "../../ui/welcome";
import { getRecentFiles } from "../../io/recentFiles";
import { buildEntries, type HomeEntry } from "../../ui/homeList";
import { getTheme, onThemeChange, themeMode } from "../../ui/theme";
import Icon from "../shell/Icon.vue";
import DocCard from "./DocCard.vue";
import NewStrip from "./NewStrip.vue";
import logoDarkUrl from "../../../assets/brand/fundacad-lockup-app.svg";
import logoLightUrl from "../../../assets/brand/fundacad-lockup-app-light.svg";

const home = useHomeStore();
const modals = useModalStore();
const cb = home.callbacks!;

const close = () => { home.visible = false; };

useModalGate();
let ownDepth = 0;
const onTop = () => modals.current === null && modals.depth === ownDepth;

const UNDO_KEYS = new Set(["z", "y"]);

function onKey(e: KeyboardEvent): void {
  if (!onTop()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const inField = e.target instanceof HTMLInputElement && e.target.type !== "checkbox";
  if (mod && UNDO_KEYS.has(e.key.toLowerCase()) && !inField) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

const logoUrl = ref(themeMode(getTheme()) === "light" ? logoLightUrl : logoDarkUrl);
const offTheme = onThemeChange(() => {
  logoUrl.value = themeMode(getTheme()) === "light" ? logoLightUrl : logoDarkUrl;
});

const recents = ref(getRecentFiles());
const entries = computed(() => buildEntries(recents.value, cb.currentPath()));
const unreadable = ref(new Set<string>());

async function openEntry(entry: HomeEntry): Promise<void> {
  if (entry.open) return close();
  const outcome = await cb.openPath(entry.path);
  if (outcome === "ok") close();
  else if (outcome === "unreadable") unreadable.value = new Set(unreadable.value).add(entry.path);
}

const showOnStartup = ref(welcomeOnStartup());
watch(showOnStartup, setWelcomeOnStartup);

onMounted(() => {
  ownDepth = modals.depth;
  window.addEventListener("keydown", onKey, true);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  offTheme();
});
</script>

<template>
  <div class="home" role="dialog" aria-label="Home">
    <aside class="home-side">
      <img :src="logoUrl" alt="FundaCAD" class="home-logo" />
      <nav class="home-nav">
        <button class="home-nav-row active">Recent</button>
      </nav>
    </aside>

    <div class="home-main">
      <div class="home-head">
        <NewStrip @blank="cb.newDocument()" @open="cb.openDoc()" />
        <button class="modal-close" aria-label="Back to the document" title="Back to the document" @click="close()">
          <Icon name="close" :size="15" />
        </button>
      </div>

      <div v-if="cb.desktop && entries.length" class="home-grid">
        <DocCard
          v-for="e in entries"
          :key="e.path"
          :entry="e"
          :unreadable="unreadable.has(e.path)"
          @open="openEntry(e)"
        />
      </div>
      <p v-else-if="cb.desktop" class="home-empty">Documents you open or save appear here.</p>
      <p v-else class="home-empty">Recent documents appear here in the desktop app.</p>

      <div class="home-foot">
        <label class="home-startup">
          <input v-model="showOnStartup" type="checkbox" />
          Show Home on startup
        </label>
      </div>
    </div>
  </div>
</template>
