<script setup lang="ts">
import { computed, useId } from "vue";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import { useDialogStore } from "../../stores/dialogs";
import { announce } from "../../ui/announce";
import { descriptionText } from "../../ui/modelDescription";

const dialogs = useDialogStore();
const description = computed(() => dialogs.describeModel);
const base = useId();

const close = () => {
  dialogs.describeModel = null;
};

// The clipboard write is the first await: WebKit refuses it once the click's user activation has passed.
async function copy() {
  const d = description.value;
  if (!d) return;
  try {
    await navigator.clipboard.writeText(descriptionText(d));
    announce("Copied the model description");
  } catch {
    announce("Could not reach the clipboard, select the text in the dialog and copy it", "assertive");
  }
}
</script>

<template>
  <!-- A document, so NVDA browses the headings and lists inside the dialog; focusable, since it scrolls. -->
  <Dialog
    v-if="description"
    :title="description.title"
    size="md"
    :body="false"
    panel-class="describe-card"
    initial-focus=".describe-body"
    @close="close()"
  >
    <div class="modal-body ui-dialog-body describe-body" role="document" tabindex="0" aria-label="Description">
      <section v-for="(s, i) in description.sections" :key="s.heading" class="describe-section">
        <h3 :id="`${base}-${i}`" class="describe-head">{{ s.heading }}</h3>
        <component :is="s.ordered ? 'ol' : 'ul'" class="describe-list" :aria-labelledby="`${base}-${i}`">
          <li v-for="(item, j) in s.items" :key="j">{{ item }}</li>
        </component>
      </section>
    </div>
    <template #footer>
      <Button @click="close()">Close</Button>
      <Button variant="primary" @click="copy()">Copy as text</Button>
    </template>
  </Dialog>
</template>
