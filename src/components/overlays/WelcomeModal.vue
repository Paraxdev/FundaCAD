<script setup lang="ts">
// Welcome screen: opens at startup (unless turned off) and from the Help menu.
// New, Open, and the recent files.
//
// The right-hand pane used to be a remote page in a cross-origin iframe, which
// made this the one place the webview loaded someone else's content and put a
// third-party server on the startup path: unreachable meant a "service is down"
// panel on first launch. Everything here is local now, and the CSP no longer
// needs a frame-src at all.

import { onMounted, onUnmounted, ref, watch } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import { welcomeOnStartup, setWelcomeOnStartup } from "../../ui/welcome";
import { forgetRecent, getRecentFiles, type RecentFile } from "../../io/recentFiles";
import ModalFrame from "./ModalFrame.vue";
import logoUrl from "../../../assets/brand/neocad-lockup-app.svg";

const dialogs = useDialogStore();
// Non-null whenever this component is rendered: App.vue gates it on the same
// field, because a welcome screen with no callbacks has nothing to do.
const cb = dialogs.welcomeCallbacks!;

const close = () => { dialogs.welcome = false; };

// pushModal/popModal, tied to mount rather than to open()/close(). See
// useModalGate — this is the one that must not be got wrong.
useModalGate();

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
}

// --- recent files (paths only exist in the native app) ---
const recents = ref<RecentFile[]>(getRecentFiles());
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const dirName = (path: string) => path.split(/[\\/]/).slice(0, -1).join("/");

async function openRecent(path: string) {
  const outcome = await cb.onOpenPath(path);
  if (outcome === "ok") {
    close();
  } else if (outcome === "unreadable") {
    forgetRecent(path); // gone from disk — drop it so it stops teasing
    recents.value = recents.value.filter((r) => r.path !== path);
  }
  // "newerFormat": the file is fine, we're too old. Keep the row — it's how
  // the user finds the file again after updating.
}

// --- footer ---
const showOnStartup = ref(welcomeOnStartup());
watch(showOnStartup, setWelcomeOnStartup);

onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <ModalFrame panel-class="welcome-panel" @close="close()">
    <template #title>
      <img :src="logoUrl" alt="Neocad" class="welcome-logo" />
    </template>

    <div class="modal-body welcome-body">
      <div class="welcome-left">
        <div class="welcome-actions">
          <button class="choice-btn choice-primary" @click="close(); cb.onNew()">
            <span>New Document</span>
          </button>
          <button class="choice-btn" @click="close(); cb.onOpen()">
            <span>Open…</span>
          </button>
        </div>

        <template v-if="recents.length">
          <div class="welcome-section">Recent</div>
          <div class="welcome-recents">
            <!-- no esc(): interpolation escapes, and a second pass would render
                 a file called "Bracket & Plate.sindri" as "Bracket &amp; Plate". -->
            <button
              v-for="r in recents"
              :key="r.path"
              class="welcome-recent"
              :title="r.path"
              @click="openRecent(r.path)"
            >
              <span class="welcome-recent-name">{{ baseName(r.path) }}</span>
              <span class="welcome-recent-dir">{{ dirName(r.path) }}</span>
            </button>
          </div>
        </template>
      </div>
    </div>

    <div class="welcome-foot">
      <label class="welcome-startup">
        <input v-model="showOnStartup" type="checkbox" />
        Show this screen on startup
      </label>
    </div>
  </ModalFrame>
</template>
