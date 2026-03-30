<script setup lang="ts">
import { computed } from "vue";
import Tag from "primevue/tag";
import { useSearchStore } from "@/stores/search";

const store = useSearchStore();

const filtered = computed(() => {
  return store.results.filter((r) => r.score >= store.scoreThreshold);
});

function scoreColor(s: number): string {
  if (s >= 0.8) return "#22C55E";
  if (s >= 0.5) return "#EAB308";
  return "#94A3B8";
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.5rem">
    <div
      v-for="result in filtered"
      :key="result.id"
      :class="[
        'result-card',
        { 'result-card--selected': store.selectedResult?.id === result.id },
      ]"
      @click="store.selectedResult = result"
    >
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.25rem;
        "
      >
        <span
          style="
            font-family: monospace;
            font-size: 0.8rem;
            color: var(--p-primary-color);
            font-weight: 600;
          "
        >
          {{ result.file.split("/").pop() || result.file }}
        </span>
        <div style="display: flex; align-items: center; gap: 0.5rem">
          <div
            style="
              width: 50px;
              height: 6px;
              background: var(--p-surface-200);
              border-radius: 3px;
              overflow: hidden;
            "
          >
            <div
              :style="{
                width: `${result.score * 100}%`,
                height: '100%',
                background: scoreColor(result.score),
                borderRadius: '3px',
              }"
            />
          </div>
          <span
            style="
              font-size: 0.75rem;
              color: var(--p-text-muted-color);
              min-width: 2.5rem;
              text-align: right;
            "
          >
            {{ (result.score * 100).toFixed(0) }}%
          </span>
        </div>
      </div>
      <div
        style="
          font-size: 0.75rem;
          color: var(--p-text-muted-color);
          margin-bottom: 0.35rem;
        "
      >
        {{ result.file }}
        <span v-if="result.line">:{{ result.line }}</span>
      </div>
      <pre
        v-if="result.content"
        style="
          margin: 0;
          font-size: 0.75rem;
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--p-text-color);
          max-height: 4rem;
          overflow: hidden;
        "
        >{{ truncate(result.content) }}</pre
      >
      <div
        v-if="result.language || result.layer"
        style="display: flex; gap: 0.25rem; margin-top: 0.35rem"
      >
        <Tag
          v-if="result.language"
          :value="result.language"
          severity="info"
          style="font-size: 0.65rem"
        />
        <Tag
          v-if="result.layer"
          :value="result.layer"
          severity="secondary"
          style="font-size: 0.65rem"
        />
        <Tag
          v-if="result.chunkType"
          :value="result.chunkType"
          severity="success"
          style="font-size: 0.65rem"
        />
      </div>
    </div>

    <div
      v-if="store.results.length > 0 && filtered.length === 0"
      style="
        text-align: center;
        padding: 2rem;
        color: var(--p-text-muted-color);
        font-size: 0.85rem;
      "
    >
      No results match the current filters. Try lowering the score threshold.
    </div>
  </div>
</template>

<style scoped>
.result-card {
  padding: 0.75rem;
  background: var(--p-surface-0);
  border: 1px solid var(--p-surface-200);
  border-radius: 6px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.result-card:hover {
  border-color: var(--p-primary-200);
  background: var(--p-surface-50);
}
.result-card--selected {
  border-color: var(--p-primary-color);
  background: var(--p-primary-50);
}
</style>
