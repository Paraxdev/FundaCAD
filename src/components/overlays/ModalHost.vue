<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, useTemplateRef } from "vue";
import { useModalStore } from "../../stores/modals";

const modals = useModalStore();
const req = computed(() => modals.current);

const card = useTemplateRef<HTMLDivElement>("card");
/** chooseMulti: which options are ticked, by index. */
const checked = ref<boolean[]>([]);

const okDisabled = computed(() => {
  const r = req.value;
  if (r?.kind !== "multi") return false;
  return checked.value.filter(Boolean).length < r.min;
});

// Keyboard-first: focus the first control so Enter commits without a mouse.
// This modal used to be click-only with a silently-cancelling backdrop; a user
// pressing Enter (dead) and then clicking (backdrop = cancel) got "nothing
// happened" with no feedback.
watch(
  req,
  async (r) => {
    if (!r) return;
    if (r.kind === "multi") checked.value = r.options.map(() => false);
    await nextTick();
    card.value?.querySelector<HTMLElement>("button, input")?.focus();
  },
  { immediate: true },
);

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

function confirmMulti() {
  const r = req.value;
  if (r?.kind !== "multi" || okDisabled.value) return;
  finish(r.options.filter((_, i) => checked.value[i]).map((o) => o.value));
}

function buttons(): HTMLButtonElement[] {
  return [...(card.value?.querySelectorAll<HTMLButtonElement>(".choice-row button") ?? [])];
}

// Capture phase, and it swallows everything it does not handle: while a modal is
// open it OWNS the keyboard, so a global shortcut can't fire underneath it. Esc
// uses stopImmediatePropagation for the same reason the imperative version did.
function onKeydown(e: KeyboardEvent) {
  const r = req.value;
  if (!r) return;

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (r.kind === "multi") confirmMulti();
    else if (r.kind === "list") cancel();
    else {
      const bs = buttons();
      const active = document.activeElement as HTMLButtonElement | null;
      (active && bs.includes(active) ? active : bs[0])?.click();
    }
    return;
  }
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && r.kind === "choose") {
    e.preventDefault();
    const bs = buttons();
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    const n = bs.length;
    if (n) bs[i < 0 ? 0 : (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n]?.focus();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// On WINDOW, in the CAPTURE phase, not on the backdrop element. The trap has to
// swallow keystrokes wherever focus happens to be (click the backdrop and focus
// leaves the card), which is what the imperative version got from
// window.addEventListener("keydown", onKey, true).
onMounted(() => window.addEventListener("keydown", onKeydown, true));
onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="req"
      class="choice-backdrop"
      @pointerdown.self="cancel()"
    >
      <div class="choice-card" ref="card">
        <div class="choice-title">{{ req.title }}</div>

        <!-- choose(): a row of option buttons -->
        <div v-if="req.kind === 'choose'" class="choice-row">
          <button
            v-for="opt in req.options"
            :key="opt.value"
            class="choice-btn"
            @click="finish(opt.value)"
          >
            <span>{{ opt.label }}</span>
            <small v-if="opt.hint">{{ opt.hint }}</small>
          </button>
        </div>

        <!-- chooseMulti(): a checkbox list + Cancel/confirm -->
        <template v-else-if="req.kind === 'multi'">
          <div class="choice-checklist">
            <label
              v-for="(opt, i) in req.options"
              :key="opt.value"
              class="choice-check"
            >
              <input type="checkbox" :value="opt.value" v-model="checked[i]" />
              <span>{{ opt.label }}</span>
              <small v-if="opt.hint">{{ opt.hint }}</small>
            </label>
          </div>
          <div class="choice-row">
            <button class="choice-btn" @click="cancel()"><span>Cancel</span></button>
            <button
              class="choice-btn choice-primary"
              :disabled="okDisabled"
              @click="confirmMulti()"
            ><span>{{ req.confirmLabel }}</span></button>
          </div>
        </template>

        <!-- listModal(): read-only list + Done -->
        <template v-else>
          <ul class="choice-list">
            <li v-for="(it, i) in req.items" :key="i" :title="it">{{ it }}</li>
          </ul>
          <div class="choice-row">
            <button class="choice-btn choice-primary" @click="cancel()"><span>Done</span></button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
