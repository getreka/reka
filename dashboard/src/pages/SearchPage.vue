<script setup lang="ts">
import { ref } from "vue";
import Message from "primevue/message";
import SearchBar from "@/components/search/SearchBar.vue";
import SearchFilters from "@/components/search/SearchFilters.vue";
import SearchResults from "@/components/search/SearchResults.vue";
import CodePreview from "@/components/search/CodePreview.vue";
import ExportButton from "@/components/common/ExportButton.vue";
import { useSearchStore } from "@/stores/search";

const store = useSearchStore();
const pageRef = ref<HTMLElement>();
</script>

<template>
  <div ref="pageRef" style="display: flex; flex-direction: column; gap: 1rem">
    <div
      style="
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      "
    >
      <SearchBar style="flex: 1" />
      <ExportButton
        v-if="store.results.length > 0"
        page="search"
        :data="store.results"
        :elementRef="pageRef"
      />
    </div>

    <Message v-if="store.error" severity="error" :closable="false">{{
      store.error
    }}</Message>

    <div
      v-if="store.results.length > 0 || store.loading"
      style="display: flex; gap: 1rem; align-items: flex-start"
    >
      <!-- Left sidebar: filters -->
      <div style="flex: 0 0 200px">
        <SearchFilters />
      </div>

      <!-- Center: results list -->
      <div style="flex: 1; min-width: 0; max-height: 75vh; overflow-y: auto">
        <SearchResults />
      </div>

      <!-- Right: code preview -->
      <div
        v-if="store.selectedResult"
        style="flex: 0 0 380px; max-height: 75vh; overflow-y: auto"
      >
        <CodePreview />
      </div>
    </div>

    <div
      v-if="store.results.length === 0 && !store.loading && !store.error"
      style="
        padding: 3rem;
        text-align: center;
        color: var(--p-text-muted-color);
      "
    >
      <i
        class="pi pi-search"
        style="font-size: 2rem; margin-bottom: 0.5rem; display: block"
      />
      Enter a query to search your codebase.
    </div>
  </div>
</template>
