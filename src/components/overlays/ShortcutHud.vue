<script setup lang="ts">
import { computed, watch, onUnmounted } from "vue";
import { useUiStore } from "../../stores/ui";
import { shortcutHudGroups } from "../../input/shortcuts";

const ui = useUiStore();
// Derived from the SHORTCUTS table on each open, so the sheet cannot advertise
// a binding the dispatcher does not have.
const groups = computed(() => (ui.shortcutHudOpen ? shortcutHudGroups() : []));

// Dismissed by ANY key or click. Capture phase + preventDefault so the
// dismissing keystroke doesn't also run a command underneath.
function onAny(e: Event) {
  e.preventDefault();
  e.stopPropagation();
  ui.shortcutHudOpen = false;
}

function bind() {
  window.addEventListener("keydown", onAny, true);
  window.addEventListener("pointerdown", onAny, true);
}
function unbind() {
  window.removeEventListener("keydown", onAny, true);
  window.removeEventListener("pointerdown", onAny, true);
}

watch(
  () => ui.shortcutHudOpen,
  (open) => {
    if (!open) return unbind();
    // Deferred so the `?` keydown that opened it doesn't instantly close it.
    setTimeout(bind, 0);
  },
);
onUnmounted(unbind);
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.shortcutHudOpen" class="shortcut-hud">
      <div class="shortcut-hud-card">
        <div class="shortcut-hud-title">Keyboard shortcuts</div>
        <div v-for="g in groups" :key="g.name" class="shortcut-hud-group">
          <h4>{{ g.name }}</h4>
          <div v-for="(r, i) in g.rows" :key="i" class="shortcut-hud-row">
            <kbd>{{ r.key }}</kbd><span>{{ r.label }}</span>
            <span v-if="r.changed" class="shortcut-hud-changed">changed</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
