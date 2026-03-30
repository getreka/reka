<script setup lang="ts">
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import Select from "primevue/select";
import SelectButton from "primevue/selectbutton";
import Slider from "primevue/slider";
import { useGraphStore } from "@/stores/graph";
import type {
  LayoutMode,
  EdgeTypeFilter,
  ConfidenceFilter,
} from "@/types/graph";

const store = useGraphStore();

const depthOptions = [
  { label: "1 hop", value: 1 },
  { label: "2 hops", value: 2 },
  { label: "3 hops", value: 3 },
  { label: "4 hops", value: 4 },
  { label: "5 hops", value: 5 },
];

const modeOptions = [
  { label: "Dependencies", value: "deps" },
  { label: "Dependents", value: "dependents" },
  { label: "Both", value: "both" },
];

const layoutOptions: { label: string; value: LayoutMode }[] = [
  { label: "Force", value: "force" },
  { label: "Circular", value: "circular" },
  { label: "Tree", value: "tree" },
];

const edgeFilterOptions: { label: string; value: EdgeTypeFilter }[] = [
  { label: "All edges", value: "all" },
  { label: "Imports", value: "imports" },
  { label: "Extends", value: "extends" },
  { label: "Implements", value: "implements" },
  { label: "Calls", value: "calls" },
  { label: "Depends on", value: "depends_on" },
];

const confidenceFilterOptions: { label: string; value: ConfidenceFilter }[] = [
  { label: "All confidence", value: "all" },
  { label: "SCIP only", value: "scip" },
  { label: "Tree-sitter+", value: "tree-sitter+" },
  { label: "Any", value: "any" },
];
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <!-- Row 1: Search -->
    <div
      style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap"
    >
      <InputText
        v-model="store.searchFile"
        placeholder="File path (e.g. src/services/embedding.ts)"
        style="flex: 1; min-width: 16rem"
        @keyup.enter="store.search()"
      />
      <Select
        v-model="store.depth"
        :options="depthOptions"
        optionLabel="label"
        optionValue="value"
        style="width: 8rem"
      />
      <Select
        v-model="store.mode"
        :options="modeOptions"
        optionLabel="label"
        optionValue="value"
        style="width: 10rem"
      />
      <Button
        label="Search"
        icon="pi pi-search"
        @click="store.search()"
        :loading="store.loading"
      />
    </div>

    <!-- Row 2: Filters (shown when graph has data) -->
    <div
      v-if="store.nodes.length > 0"
      style="
        display: flex;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
        font-size: 0.85rem;
      "
    >
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <span style="color: var(--p-text-muted-color)">Layout:</span>
        <SelectButton
          v-model="store.layoutMode"
          :options="layoutOptions"
          optionLabel="label"
          optionValue="value"
          :allowEmpty="false"
          size="small"
        />
      </div>
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <span style="color: var(--p-text-muted-color)">Edge type:</span>
        <Select
          v-model="store.edgeTypeFilter"
          :options="edgeFilterOptions"
          optionLabel="label"
          optionValue="value"
          style="width: 9rem"
          size="small"
        />
      </div>
      <div style="display: flex; align-items: center; gap: 0.5rem">
        <span style="color: var(--p-text-muted-color)">Confidence:</span>
        <Select
          v-model="store.confidenceFilter"
          :options="confidenceFilterOptions"
          optionLabel="label"
          optionValue="value"
          style="width: 10rem"
          size="small"
        />
      </div>
      <div
        style="
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex: 1;
          min-width: 12rem;
        "
      >
        <span style="color: var(--p-text-muted-color)">Filter:</span>
        <InputText
          v-model="store.filePatternFilter"
          placeholder="File pattern..."
          size="small"
          style="flex: 1"
        />
      </div>
      <span style="color: var(--p-text-muted-color); font-size: 0.8rem">
        {{ store.nodes.length }} nodes, {{ store.links.length }} edges
      </span>
    </div>
  </div>
</template>
