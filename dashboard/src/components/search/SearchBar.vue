<script setup lang="ts">
import { ref, watch } from "vue";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import SelectButton from "primevue/selectbutton";
import Listbox from "primevue/listbox";
import { useSearchStore } from "@/stores/search";
import { useRouter, useRoute } from "vue-router";

const store = useSearchStore();
const router = useRouter();
const route = useRoute();
const showRecent = ref(false);

const modeOptions = [
  { label: "Hybrid", value: "hybrid" },
  { label: "Semantic", value: "semantic" },
  { label: "Symbol", value: "symbol" },
  { label: "Graph", value: "graph" },
];

// Sync URL params
watch(
  () => route.query,
  (q) => {
    if (q.q && typeof q.q === "string") store.query = q.q;
    if (q.mode && typeof q.mode === "string") store.mode = q.mode as any;
  },
  { immediate: true },
);

function doSearch() {
  showRecent.value = false;
  router.replace({ query: { q: store.query, mode: store.mode } });
  store.search();
}

function pickRecent(q: string) {
  store.query = q;
  showRecent.value = false;
  doSearch();
}

function hideRecentDelayed() {
  globalThis.setTimeout(() => {
    showRecent.value = false;
  }, 200);
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.5rem">
    <div
      style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap"
    >
      <div style="flex: 1; min-width: 16rem; position: relative">
        <InputText
          v-model="store.query"
          placeholder="Search codebase..."
          style="width: 100%"
          @keyup.enter="doSearch"
          @focus="showRecent = store.recentSearches.length > 0 && !store.query"
          @blur="hideRecentDelayed"
        />
        <div
          v-if="showRecent && store.recentSearches.length > 0"
          style="
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            z-index: 100;
            background: var(--p-surface-0);
            border: 1px solid var(--p-surface-200);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            max-height: 200px;
            overflow-y: auto;
          "
        >
          <div
            v-for="s in store.recentSearches"
            :key="s"
            style="
              padding: 0.5rem 0.75rem;
              cursor: pointer;
              font-size: 0.85rem;
              display: flex;
              align-items: center;
              gap: 0.5rem;
            "
            @mousedown.prevent="pickRecent(s)"
          >
            <i
              class="pi pi-history"
              style="color: var(--p-text-muted-color); font-size: 0.75rem"
            />
            {{ s }}
          </div>
        </div>
      </div>
      <SelectButton
        v-model="store.mode"
        :options="modeOptions"
        optionLabel="label"
        optionValue="value"
        :allowEmpty="false"
        size="small"
      />
      <Button
        label="Search"
        icon="pi pi-search"
        @click="doSearch"
        :loading="store.loading"
      />
    </div>
  </div>
</template>
