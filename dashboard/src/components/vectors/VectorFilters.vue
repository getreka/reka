<script setup lang="ts">
import { ref, onMounted } from "vue";
import Select from "primevue/select";
import Button from "primevue/button";
import InputNumber from "primevue/inputnumber";
import { useVectorsStore } from "@/stores/vectors";
import { fetchCollections } from "@/api/collections";

const store = useVectorsStore();
const collections = ref<{ label: string; value: string }[]>([]);
const selectedCollection = ref("");

const colorOptions = [
  { label: "Language", value: "language" },
  { label: "Layer", value: "layer" },
  { label: "Chunk Type", value: "chunkType" },
];

onMounted(async () => {
  try {
    const list = await fetchCollections();
    collections.value = list
      .filter((c) => c.vectorsCount > 0)
      .map((c) => ({ label: `${c.name} (${c.vectorsCount})`, value: c.name }));
    if (collections.value.length > 0 && !selectedCollection.value) {
      // Prefer _code collections
      const codeCol = collections.value.find((c) => c.value.endsWith("_code"));
      selectedCollection.value = codeCol?.value || collections.value[0].value;
    }
  } catch {}
});

function load() {
  if (selectedCollection.value) {
    store.loadAndProject(selectedCollection.value);
  }
}
</script>

<template>
  <div
    style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap"
  >
    <Select
      v-model="selectedCollection"
      :options="collections"
      optionLabel="label"
      optionValue="value"
      placeholder="Select collection"
      style="min-width: 16rem"
    />
    <div style="display: flex; align-items: center; gap: 0.5rem">
      <span style="font-size: 0.85rem; color: var(--p-text-muted-color)"
        >Max points:</span
      >
      <InputNumber
        v-model="store.maxPoints"
        :min="50"
        :max="1000"
        :step="50"
        style="width: 6rem"
        size="small"
      />
    </div>
    <Button
      label="Visualize"
      icon="pi pi-eye"
      @click="load"
      :loading="store.loading || store.computing"
    />
    <div
      v-if="store.projected.length > 0"
      style="display: flex; align-items: center; gap: 0.5rem"
    >
      <span style="font-size: 0.85rem; color: var(--p-text-muted-color)"
        >Color by:</span
      >
      <Select
        v-model="store.colorBy"
        :options="colorOptions"
        optionLabel="label"
        optionValue="value"
        style="width: 9rem"
        size="small"
      />
    </div>
    <span
      v-if="store.projected.length > 0"
      style="font-size: 0.8rem; color: var(--p-text-muted-color)"
    >
      {{ store.projected.length }} points
    </span>
  </div>
</template>
