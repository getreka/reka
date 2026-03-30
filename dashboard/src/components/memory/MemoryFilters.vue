<script setup lang="ts">
import Select from "primevue/select";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import { useMemoryStore } from "@/stores/memory";

const store = useMemoryStore();

const typeOptions = [
  { label: "All Types", value: "all" },
  { label: "Decision", value: "decision" },
  { label: "Insight", value: "insight" },
  { label: "Context", value: "context" },
  { label: "Todo", value: "todo" },
  { label: "Conversation", value: "conversation" },
  { label: "Note", value: "note" },
];

function apply() {
  store.loadMemories();
}
</script>

<template>
  <div
    style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap"
  >
    <Select
      v-model="store.filterType"
      :options="typeOptions"
      optionLabel="label"
      optionValue="value"
      placeholder="Type"
      size="small"
      style="width: 10rem"
    />
    <InputText
      v-model="store.filterTag"
      placeholder="Filter by tag"
      size="small"
      style="width: 10rem"
    />
    <InputText
      v-model="store.searchQuery"
      placeholder="Semantic search..."
      size="small"
      style="width: 14rem"
      @keyup.enter="apply"
    />
    <Button label="Search" icon="pi pi-search" size="small" @click="apply" />
  </div>
</template>
