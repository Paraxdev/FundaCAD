<script setup lang="ts">
// Never armed on focus: screen reader browse mode and voice control pass over a focused control with letters, and
// would set a key by reading the row. The keys are taken only inside the dialog the button opens.
import { computed, nextTick, ref, useId, useTemplateRef } from "vue";
import { comboKey, spokenKeys } from "../../input/platform";
import { announce } from "../../ui/announce";
import Button from "./Button.vue";
import Dialog from "./Dialog.vue";
import KeyChip from "./KeyChip.vue";

export interface CapturedKey {
  /** As comboKey reads it: lower case, and the US key under a non Latin letter. */
  key: string;
  /** e.key as typed, for a setting that keeps named keys ("ArrowUp", "F5") by their own names. */
  name: string;
  code: string;
  /** Ctrl, or Cmd on macOS, as the shortcut table means it. */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** What the key does: the start of the button's name and the dialog's title. */
    action: string;
    /** In the table's form, "Ctrl+Z"; empty is Not set. */
    keys?: string | undefined;
    /** The owner's refusal of the last capture, set in its capture handler and spoken in place of the new keys. */
    problem?: string | undefined;
    /** Adds a Clear button to the dialog, for a key that may be left unset. */
    clearable?: boolean;
  }>(),
  { keys: undefined, problem: undefined, clearable: false },
);
const emit = defineEmits<{ capture: [key: CapturedKey]; clear: [] }>();

const open = ref(false);
const listening = ref(false);
const hintId = useId();
const button = useTemplateRef<InstanceType<typeof Button>>("button");

const name = computed(() => `${props.action}, shortcut ${props.keys ? spokenKeys(props.keys) : "not set"}, change`);

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Super", "Hyper", "Fn"]);
// A dead key or an IME is still composing: the key that counts comes next.
const UNFINISHED = new Set(["Dead", "Process", "Unidentified"]);

// The owner's handler runs inside `result`, so its new keys or its problem are in the props after one tick.
async function finish(result: (() => void) | null) {
  open.value = false;
  listening.value = false;
  result?.();
  await nextTick();
  (button.value?.$el as HTMLElement | undefined)?.focus();
  if (!result) return;
  if (props.problem) announce(props.problem, "assertive");
  else {
    const said = props.keys ? `${props.action} is now ${spokenKeys(props.keys)}` : `${props.action} has no shortcut`;
    announce(said, "polite");
  }
}

function onPadKey(e: KeyboardEvent) {
  // Tab moves on to the buttons, so the region is no keyboard trap.
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") return void finish(null);
  if (MODIFIERS.has(e.key) || UNFINISHED.has(e.key) || e.isComposing) return;
  const key = {
    key: comboKey(e),
    name: e.key,
    code: e.code,
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
  void finish(() => emit("capture", key));
}
</script>

<template>
  <Button
    ref="button"
    v-bind="$attrs"
    size="sm"
    class="key-capture"
    :class="{ 'is-unset': !keys }"
    :aria-label="name"
    @click="open = true"
  >
    <KeyChip v-if="keys" :keys="keys" in-title />
    <template v-else>Not set</template>
  </Button>
  <Dialog
    v-if="open"
    size="sm"
    :title="`Shortcut for ${action}`"
    initial-focus=".key-capture-pad"
    @close="finish(null)"
  >
    <div
      class="key-capture-pad"
      role="application"
      tabindex="0"
      :aria-label="`Press the new shortcut for ${action}`"
      :aria-describedby="hintId"
      @keydown="onPadKey"
      @focus="listening = true"
      @blur="listening = false"
    >
      <span aria-hidden="true">{{ listening ? "Press the new keys" : "Click here, then press the new keys" }}</span>
      <span v-if="keys" class="key-capture-now" aria-hidden="true">Now <KeyChip :keys="keys" in-title /></span>
    </div>
    <p :id="hintId" class="key-capture-hint">Escape cancels. Tab moves on to the buttons.</p>
    <template #footer>
      <Button v-if="clearable" variant="ghost" @click="finish(() => emit('clear'))">Clear</Button>
      <Button @click="finish(null)">Cancel</Button>
    </template>
  </Dialog>
</template>
