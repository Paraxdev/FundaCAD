<script setup lang="ts">
import { computed } from "vue";
import { useWhatsNewStore } from "../../stores/whatsNew";
import { REPO_URL } from "../../ui/reportText";
import { openExternal } from "../../ui/welcome";

const news = useWhatsNewStore();
const title = computed(() =>
  /^\d/.test(news.version) ? `What's new in FundaCAD ${news.version}` : "What's new in FundaCAD",
);
</script>

<template>
  <section v-if="news.notes.length" class="home-news" aria-labelledby="home-news-title">
    <h2 id="home-news-title" class="home-news-title">{{ title }}</h2>
    <div class="home-news-body">
      <template v-for="(g, i) in news.notes" :key="i">
        <h3 v-if="g.title" class="home-news-group">{{ g.title }}</h3>
        <ul class="home-news-list">
          <li v-for="(b, j) in g.bullets" :key="j">{{ b }}</li>
        </ul>
      </template>
    </div>
    <div class="home-news-acts">
      <button type="button" class="btn home-news-all" @click="void openExternal(`${REPO_URL}/releases`)">
        All release notes
      </button>
      <button type="button" class="btn home-news-hide" @click="news.dismiss()">Hide</button>
    </div>
  </section>
</template>
