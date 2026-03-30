<script setup lang="ts">
import { computed } from "vue";
import Select from "primevue/select";
import Slider from "primevue/slider";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { useSearchStore } from "@/stores/search";

const store = useSearchStore();

const languageOptions = [
  { label: "All languages", value: "" },
  { label: "TypeScript", value: "typescript" },
  { label: "JavaScript", value: "javascript" },
  { label: "Python", value: "python" },
  { label: "Vue", value: "vue" },
  { label: "JSON", value: "json" },
  { label: "YAML", value: "yaml" },
  { label: "Markdown", value: "markdown" },
];

const layerOptions = [
  { label: "All layers", value: "" },
  { label: "API", value: "api" },
  { label: "Service", value: "service" },
  { label: "Util", value: "util" },
  { label: "Model", value: "model" },
  { label: "Middleware", value: "middleware" },
  { label: "Test", value: "test" },
  { label: "Config", value: "config" },
];

const filteredCount = computed(() => {
  if (!store.scoreThreshold) return store.results.length;
  return store.results.filter((r) => r.score >= store.scoreThreshold).length;
});
</script>

<template>
  <div
    style="
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--p-surface-0);
      border: 1px solid var(--p-surface-200);
      border-radius: 8px;
    "
  >
    <div style="font-size: 0.85rem; font-weight: 600">Filters</div>

    <div>
      <div
        style="
          font-size: 0.8rem;
          color: var(--p-text-muted-color);
          margin-bottom: 0.25rem;
        "
      >
        Language
      </div>
      <Select
        v-model="store.languageFilter"
        :options="languageOptions"
        optionLabel="label"
        optionValue="value"
        style="width: 100%"
        size="small"
      />
    </div>

    <div>
      <div
        style="
          font-size: 0.8rem;
          color: var(--p-text-muted-color);
          margin-bottom: 0.25rem;
        "
      >
        Layer
      </div>
      <Select
        v-model="store.layerFilter"
        :options="layerOptions"
        optionLabel="label"
        optionValue="value"
        style="width: 100%"
        size="small"
      />
    </div>

    <div>
      <div
        style="
          font-size: 0.8rem;
          color: var(--p-text-muted-color);
          margin-bottom: 0.25rem;
        "
      >
        Min score: {{ store.scoreThreshold.toFixed(2) }}
      </div>
      <Slider
        v-model="store.scoreThreshold"
        :min="0"
        :max="1"
        :step="0.05"
        style="width: 100%"
      />
    </div>

    <div
      v-if="store.meta"
      style="font-size: 0.8rem; color: var(--p-text-muted-color)"
    >
      {{ filteredCount }} / {{ store.meta.totalResults }} results
    </div>

    <div v-if="store.meta" style="display: flex; flex-wrap: wrap; gap: 0.25rem">
      <Tag :value="store.meta.mode" severity="info" style="font-size: 0.7rem" />
      <Tag
        v-if="store.meta.timing"
        :value="`${store.meta.timing}ms`"
        severity="secondary"
        style="font-size: 0.7rem"
      />
    </div>

    <Button
      v-if="store.results.length > 0"
      label="Clear"
      icon="pi pi-times"
      severity="secondary"
      size="small"
      text
      @click="store.clearResults()"
    />
  </div>
</template>
