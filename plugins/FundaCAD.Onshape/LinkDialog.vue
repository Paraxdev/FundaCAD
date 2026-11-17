<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Button, Checkbox, FieldRow, ModalFrame, TextField } from "fundacad/ui";
import { t } from "./lines";
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
// Inline, because a plugin has nowhere to ship a stylesheet.
const S = {
  form: { minWidth: "460px", display: "flex", flexDirection: "column", gap: "var(--s-3)" },
  link: { flex: "1", minWidth: "0" },
  error: { color: "var(--error, #f0564a)" },
} as const;

function confirm() {
  const parsed = parseOnshapeUrl(link.value);
  if ("error" in parsed) {
    error.value = parsed.error;
    return;
  }
  if (askKeys.value && (!access.value.trim() || !secret.value.trim())) {
    error.value = t("dialog.needKeys");
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
  } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
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
    <template #title>{{ t("dialog.title") }}</template>

    <div class="modal-body">
      <div :style="S.form">
        <FieldRow v-slot="{ id, describedby }" :label="t('dialog.link')" layout="stacked" :hint="t('dialog.linkHint')">
          <TextField
            :id="id"
            v-model="link"
            :style="S.link"
            :label="t('dialog.link')"
            type="url"
            spellcheck="false"
            autofocus
            placeholder="https://cad.onshape.com/documents/..."
            :aria-describedby="describedby"
            data-testid="onshape-link"
          />
        </FieldRow>

        <template v-if="askKeys">
          <FieldRow v-slot="{ id }" :label="t('dialog.accessKey')">
            <TextField
              :id="id"
              v-model="access"
              :label="t('dialog.accessKey')"
              spellcheck="false"
              autocomplete="off"
              data-testid="onshape-access"
            />
          </FieldRow>
          <!-- TextField has no password type, so this raw input sits in the same field well, named by its row. -->
          <FieldRow v-slot="{ id }" :label="t('dialog.secretKey')">
            <span class="ui-field ui-text-field ui-field-md">
              <input
                :id="id"
                v-model="secret"
                :aria-label="t('dialog.secretKey')"
                type="password"
                autocomplete="off"
                data-testid="onshape-secret"
              />
            </span>
          </FieldRow>
          <Checkbox v-model="remember">{{ t("dialog.remember") }}</Checkbox>
          <div class="sm-hint">{{ t("dialog.keysHint") }}</div>
        </template>
        <Button v-else size="sm" @click="changeKeys = true">{{ t("dialog.useOtherKeys") }}</Button>

        <div v-if="error" class="sm-hint" role="alert" :style="S.error" data-testid="onshape-error">{{
          t("error.prefix", { message: error })
        }}</div>
      </div>
    </div>

    <div class="modal-foot">
      <Button @click="cancel()">{{ t("dialog.cancel") }}</Button>
      <Button variant="primary" data-testid="onshape-import" @click="confirm()">{{ t("dialog.import") }}</Button>
    </div>
  </ModalFrame>
</template>
