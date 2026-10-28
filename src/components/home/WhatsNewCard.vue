<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import { useWhatsNewStore } from "../../stores/whatsNew";
import { REPO_URL } from "../../ui/reportText";
import { openExternal } from "../../ui/welcome";
import Button from "../ui/Button.vue";

const news = useWhatsNewStore();
// A start from a double-clicked file closes Home within a moment, which does not count as reading the card.
const SEEN_AFTER_MS = 2000;
let seenTimer: ReturnType<typeof setTimeout> | undefined;
watchEffect(() => {
  clearTimeout(seenTimer);
  if (news.notes.length) seenTimer = setTimeout(news.markSeen, SEEN_AFTER_MS);
});
onBeforeUnmount(() => clearTimeout(seenTimer));

// The body scrolls inside the card, and a scrollbar that only shows on hover does not say there is more.
const body = ref<HTMLElement | null>(null);
const more = ref(false);
const measure = () => {
  const el = body.value;
  more.value = !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
};
watch(
  () => news.notes,
  () => void nextTick(measure),
);
onMounted(() => {
  measure();
  window.addEventListener("resize", measure);
});
onBeforeUnmount(() => window.removeEventListener("resize", measure));
const title = computed(() =>
  /^\d/.test(news.version) ? `What's new in FundaCAD ${news.version}` : "What's new in FundaCAD",
);
</script>

<template>
  <section v-if="news.notes.length" class="home-news" aria-labelledby="home-news-title">
    <h2 id="home-news-title" class="home-news-title">{{ title }}</h2>
    <div ref="body" class="home-news-body" :class="{ 'is-more': more }" @scroll.passive="measure">
      <template v-for="(g, i) in news.notes" :key="i">
        <h3 v-if="g.title" class="home-news-group">{{ g.title }}</h3>
        <ul class="home-news-list">
          <li v-for="(b, j) in g.bullets" :key="j">{{ b }}</li>
        </ul>
      </template>
    </div>
    <div class="home-news-acts">
      <Button class="home-news-all" @click="void openExternal(`${REPO_URL}/releases`)">All release notes</Button>
      <Button class="home-news-hide" @click="news.dismiss()">Hide</Button>
    </div>
  </section>
</template>
