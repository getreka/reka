<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Card from "primevue/card";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useSearchStore } from "@/stores/search";

const store = useSearchStore();
const hljs = ref<any>(null);

onMounted(async () => {
  try {
    const mod = await import("highlight.js/lib/core");
    hljs.value = mod.default;
    // Register common languages
    const [ts, js, py, json, yaml, css, html, bash] = await Promise.all([
      import("highlight.js/lib/languages/typescript"),
      import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/python"),
      import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/yaml"),
      import("highlight.js/lib/languages/css"),
      import("highlight.js/lib/languages/xml"),
      import("highlight.js/lib/languages/bash"),
    ]);
    hljs.value.registerLanguage("typescript", ts.default);
    hljs.value.registerLanguage("javascript", js.default);
    hljs.value.registerLanguage("python", py.default);
    hljs.value.registerLanguage("json", json.default);
    hljs.value.registerLanguage("yaml", yaml.default);
    hljs.value.registerLanguage("css", css.default);
    hljs.value.registerLanguage("html", html.default);
    hljs.value.registerLanguage("xml", html.default);
    hljs.value.registerLanguage("bash", bash.default);
    hljs.value.registerLanguage("vue", ts.default); // fallback
  } catch {}
});

const highlighted = computed(() => {
  const result = store.selectedResult;
  if (!result?.content) return "";
  if (!hljs.value) return escapeHtml(result.content);

  const lang = result.language || "typescript";
  try {
    if (hljs.value.getLanguage(lang)) {
      return hljs.value.highlight(result.content, { language: lang }).value;
    }
    return hljs.value.highlightAuto(result.content).value;
  } catch {
    return escapeHtml(result.content);
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
</script>

<template>
  <Card v-if="store.selectedResult" style="height: 100%">
    <template #title>
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
        "
      >
        <span style="font-size: 0.9rem">Code Preview</span>
        <Button
          icon="pi pi-times"
          text
          size="small"
          @click="store.selectedResult = null"
        />
      </div>
    </template>
    <template #content>
      <div style="display: flex; flex-direction: column; gap: 0.5rem">
        <div
          style="
            font-family: monospace;
            font-size: 0.8rem;
            color: var(--p-primary-color);
            word-break: break-all;
          "
        >
          {{ store.selectedResult.file }}
          <span
            v-if="store.selectedResult.line"
            style="color: var(--p-text-muted-color)"
            >:{{ store.selectedResult.line }}</span
          >
        </div>
        <div style="display: flex; gap: 0.25rem">
          <Tag
            v-if="store.selectedResult.language"
            :value="store.selectedResult.language"
            severity="info"
            style="font-size: 0.7rem"
          />
          <Tag
            v-if="store.selectedResult.layer"
            :value="store.selectedResult.layer"
            severity="secondary"
            style="font-size: 0.7rem"
          />
          <Tag
            :value="`Score: ${(store.selectedResult.score * 100).toFixed(0)}%`"
            severity="success"
            style="font-size: 0.7rem"
          />
        </div>
        <pre class="code-block" v-html="highlighted" />
      </div>
    </template>
  </Card>
</template>

<style scoped>
.code-block {
  margin: 0;
  padding: 0.75rem;
  background: var(--p-surface-50);
  border: 1px solid var(--p-surface-200);
  border-radius: 4px;
  font-size: 0.8rem;
  line-height: 1.5;
  overflow: auto;
  max-height: 500px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

<style>
/* highlight.js theme — minimal */
.hljs-keyword {
  color: #8b5cf6;
}
.hljs-string {
  color: #22c55e;
}
.hljs-comment {
  color: #94a3b8;
  font-style: italic;
}
.hljs-function {
  color: #3b82f6;
}
.hljs-number {
  color: #f97316;
}
.hljs-built_in {
  color: #06b6d4;
}
.hljs-title {
  color: #eab308;
}
.hljs-type {
  color: #ec4899;
}
.hljs-attr {
  color: #f59e0b;
}
.hljs-literal {
  color: #ef4444;
}
</style>
