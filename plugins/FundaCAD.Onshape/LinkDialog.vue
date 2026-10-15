<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ModalFrame } from "fundacad/ui";
import { parseOnshapeUrl } from "./url";
import type { LinkRequest } from "./dialog";

const props = defineProps<{ req: LinkRequest }>();

const link = ref("");
const access = ref("");
const secret = ref("");
const remember = ref(true);
const changeKeys = ref(false);
const error = ref("");
const askKeys = computed(() => props.req.askKeys || changeKeys.value);

function confirm() {
  const parsed = parseOnshapeUrl(link.value);
  if ("error" in parsed) {
    error.value = parsed.error;
    return;
  }
  if (askKeys.value && (!access.value.trim() || !secret.value.trim())) {
    error.value = "Paste both the access key and the secret key.";
    return;
  }
  props.req.resolve({
    link: link.value.trim(),
    remember: remember.value,
    ...(askKeys.value ? { keys: { access: access.value.trim(), secret: secret.value.trim() } } : {}),
  });
}
const cancel = () => props.req.resolve(null);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    confirm();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <ModalFrame panel-class="onshape-link-dialog" @close="cancel()">
    <template #title>Import from Onshape link</template>

    <div class="modal-body prefs">
      <label class="prefs-row" style="grid-template-columns: 90px 1fr">
        <span class="prefs-label">Link</span>
        <input
          v-model="link" class="sm-input" type="url" spellcheck="false" autofocus
          placeholder="https://cad.onshape.com/documents/..." data-testid="onshape-link"
        />
      </label>
      <div class="sm-hint">A part studio link imports that part studio. A document link imports every part studio in it.</div>

      <template v-if="askKeys">
        <label class="prefs-row" style="grid-template-columns: 90px 1fr">
          <span class="prefs-label">Access key</span>
          <input v-model="access" class="sm-input" spellcheck="false" autocomplete="off" data-testid="onshape-access" />
        </label>
        <label class="prefs-row" style="grid-template-columns: 90px 1fr">
          <span class="prefs-label">Secret key</span>
          <input v-model="secret" class="sm-input" type="password" autocomplete="off" data-testid="onshape-secret" />
        </label>
        <label class="prefs-row" style="grid-template-columns: 90px 1fr">
          <span class="prefs-label"></span>
          <span><input v-model="remember" type="checkbox" /> Remember in the system's credential store</span>
        </label>
        <div class="sm-hint">Create a key with read access at dev-portal.onshape.com/keys. The keys never go in the document.</div>
      </template>
      <button v-else type="button" class="btn" style="justify-self: start" @click="changeKeys = true">Use other keys</button>

      <div v-if="error" class="sm-hint" style="color: var(--error, #f0564a)" data-testid="onshape-error">{{ error }}</div>
    </div>

    <div class="modal-foot">
      <button type="button" class="btn" @click="cancel()">Cancel</button>
      <button type="button" class="btn btn-primary" data-testid="onshape-import" @click="confirm()">Import</button>
    </div>
  </ModalFrame>
</template>
