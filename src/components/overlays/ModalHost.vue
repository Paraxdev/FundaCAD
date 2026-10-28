<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useModalStore } from "../../stores/modals";
import Button from "../ui/Button.vue";
import ConfirmDialog from "../ui/ConfirmDialog.vue";
import Dialog from "../ui/Dialog.vue";

const modals = useModalStore();
const req = computed(() => modals.current);

function finish(value: unknown) {
  const r = req.value;
  if (!r) return;
  modals.close();
  (r.resolve as (v: unknown) => void)(value);
}

function cancel() {
  const r = req.value;
  if (!r) return;
  finish(r.kind === "list" ? undefined : null);
}

// The last one: a chooser is the topmost dialog, and ConfirmDialog has no other user.
function panel(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(".ui-confirm");
  return all[all.length - 1] ?? null;
}

// What the dialog itself handles: Tab for its focus trap, Space for a box, the arrows, Home and End for the choices.
const DIALOG_KEYS = new Set(["Tab", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
let passed: KeyboardEvent | null = null;

// Swallows every key it does not handle or pass to the dialog, so no global shortcut fires under an open modal. Esc
// uses stopImmediatePropagation for the same reason.
function onKeydown(e: KeyboardEvent) {
  const r = req.value;
  if (!r) return;
  const card = panel();

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (r.kind === "multi") card?.querySelector<HTMLElement>(".ui-confirm-ok")?.click();
    else if (r.kind === "list") cancel();
    else {
      const active = document.activeElement;
      const own = active instanceof HTMLButtonElement && card?.contains(active) ? active : null;
      (own ?? card?.querySelector<HTMLElement>(".ui-confirm-choice"))?.click();
    }
    return;
  }
  if (DIALOG_KEYS.has(e.key) && card && e.target instanceof Node && card.contains(e.target)) {
    passed = e;
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// A passed key still stops short of the window's shortcut listeners, once the dialog has had it.
function onBubble(e: KeyboardEvent) {
  if (e !== passed) return;
  passed = null;
  e.stopPropagation();
}

// On window in the capture phase, not the backdrop: the trap must swallow keys wherever focus is, and a backdrop
// click moves focus out of the card.
onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
  document.body.addEventListener("keydown", onBubble);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown, true);
  document.body.removeEventListener("keydown", onBubble);
});
</script>

<template>
  <ConfirmDialog
    v-if="req && req.kind !== 'list'"
    :key="req.id"
    :title="req.title"
    :options="req.options"
    :multi="req.kind === 'multi'"
    :min="req.kind === 'multi' ? req.min : 1"
    :confirm-label="req.kind === 'multi' ? req.confirmLabel : 'OK'"
    @pick="finish"
    @confirm="finish"
    @cancel="cancel()"
  />
  <!-- listModal() leaves the modal depth alone, so its frame holds no gate. -->
  <Dialog
    v-else-if="req"
    :key="req.id"
    :title="req.title"
    size="sm"
    :gate="false"
    :close-on-esc="false"
    panel-class="ui-confirm"
    @close="cancel()"
  >
    <ul class="choice-list">
      <li v-for="(it, i) in req.items" :key="i" :title="it">{{ it }}</li>
    </ul>
    <template #footer>
      <Button variant="primary" class="ui-confirm-ok" @click="cancel()">Done</Button>
    </template>
  </Dialog>
</template>
