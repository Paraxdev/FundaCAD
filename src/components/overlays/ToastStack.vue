<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
import { useToastStore } from "../../stores/toasts";

const toasts = useToastStore();
const region = ref<HTMLElement | null>(null);
const hovered = ref(new Set<number>());
const focused = ref(false);

// A row removed under the pointer fires no pointerleave and a removed focused button no reliable focusout,
// so rows changing re-checks both instead of trusting the events.
watch(
  () => toasts.items.map((t) => `${t.id}${t.leaving ? "x" : ""}`),
  () => {
    const live = new Set(toasts.items.filter((t) => !t.leaving).map((t) => t.id));
    hovered.value = new Set([...hovered.value].filter((id) => live.has(id)));
    const active = document.activeElement;
    const row = active && region.value?.contains(active) ? active.closest(".toast") : null;
    focused.value = !!row && !row.classList.contains("toast-out");
  },
  { flush: "post" },
);

watch(
  () => hovered.value.size > 0 || focused.value,
  (hold) => (hold ? toasts.pause() : toasts.resume()),
);

// A modal makes the stack inert, out of reach, so a toast with a button waits until the modal lets it go.
const inertWatch = new MutationObserver(() => syncInert());
function syncInert() {
  if (region.value?.hasAttribute("inert")) toasts.pause("modal");
  else toasts.resume("modal");
}
onMounted(() => {
  if (region.value) inertWatch.observe(region.value, { attributes: true, attributeFilter: ["inert"] });
  syncInert();
});
onUnmounted(() => {
  inertWatch.disconnect();
  toasts.resume("modal");
});

function enter(id: number) {
  hovered.value = new Set(hovered.value).add(id);
}
function leave(id: number) {
  const next = new Set(hovered.value);
  next.delete(id);
  hovered.value = next;
}
function focusOut(e: FocusEvent) {
  const to = e.relatedTarget;
  if (!(to instanceof Node && region.value?.contains(to))) focused.value = false;
}
</script>

<template>
  <!-- Teleported: the stack is position:fixed and must not inherit a stacking context from #app's grid. -->
  <Teleport to="body">
    <!-- Not live: toast() speaks each message through the announcer, so a live stack would say it twice. -->
    <div
      ref="region"
      class="toast-stack"
      role="region"
      aria-label="Notifications"
      @focusin="focused = true"
      @focusout="focusOut"
    >
      <div
        v-for="t in toasts.items"
        :key="t.id"
        class="toast"
        :class="[`toast-${t.kind}`, { 'toast-out': t.leaving }]"
        @pointerenter="enter(t.id)"
        @pointerleave="leave(t.id)"
      >
        <!-- Messages carry engine error text and document-sourced names, {{ }} escapes them. -->
        <span class="toast-msg">{{ t.message }}</span>
        <Button
          v-if="t.action"
          size="sm"
          class="toast-action"
          @click="
            t.action.onClick();
            toasts.dismiss(t.id);
          "
          >{{ t.action.label }}</Button
        >
        <IconButton
          icon="close"
          tip="Dismiss"
          size="sm"
          variant="plain"
          :icon-size="12"
          class="toast-close"
          @click="toasts.dismiss(t.id)"
        />
      </div>
    </div>
  </Teleport>
</template>
