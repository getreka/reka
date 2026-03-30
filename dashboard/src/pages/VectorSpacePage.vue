<script setup lang="ts">
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import VectorFilters from "@/components/vectors/VectorFilters.vue";
import VectorScatter from "@/components/vectors/VectorScatter.vue";
import PointInspector from "@/components/vectors/PointInspector.vue";
import { useVectorsStore } from "@/stores/vectors";

const store = useVectorsStore();
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <VectorFilters />

    <Message v-if="store.error" severity="error" :closable="false">{{
      store.error
    }}</Message>

    <div v-if="store.computing" style="text-align: center; padding: 3rem">
      <ProgressSpinner style="width: 3rem; height: 3rem" />
      <div style="margin-top: 0.5rem; color: var(--p-text-muted-color)">
        Computing projection...
      </div>
    </div>

    <div
      v-else-if="store.projected.length > 0"
      style="display: flex; gap: 1rem"
    >
      <div
        :style="{
          flex: store.selectedPoint ? '1 1 65%' : '1 1 100%',
          minWidth: 0,
          transition: 'flex 0.3s',
        }"
      >
        <VectorScatter />
      </div>
      <div
        v-if="store.selectedPoint"
        style="flex: 0 0 320px; max-height: 600px; overflow-y: auto"
      >
        <PointInspector />
      </div>
    </div>

    <div
      v-else-if="!store.loading"
      style="
        padding: 3rem;
        text-align: center;
        color: var(--p-text-muted-color);
      "
    >
      Select a collection and click Visualize to explore the vector space.
    </div>
  </div>
</template>
