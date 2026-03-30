<script setup lang="ts">
import Message from "primevue/message";
import GraphSearch from "@/components/graph/GraphSearch.vue";
import GraphVisualization from "@/components/graph/GraphVisualization.vue";
import BlastRadiusPanel from "@/components/graph/BlastRadiusPanel.vue";
import NodeInspectorPanel from "@/components/graph/NodeInspectorPanel.vue";
import { useGraphStore } from "@/stores/graph";
import { useProjectWatch } from "@/composables/useProjectWatch";

const store = useGraphStore();

useProjectWatch(() => {
  store.nodes = [];
  store.links = [];
  store.selectedNode = null;
  store.inspectorData = null;
});
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <GraphSearch />

    <Message v-if="store.error" severity="error" :closable="false">{{
      store.error
    }}</Message>

    <!-- Graph + Inspector split -->
    <div v-if="store.nodes.length > 0" style="display: flex; gap: 1rem">
      <div
        :style="{
          flex: store.selectedNode ? '1 1 65%' : '1 1 100%',
          minWidth: 0,
          transition: 'flex 0.3s',
        }"
      >
        <GraphVisualization />
      </div>
      <div
        v-if="store.selectedNode"
        style="flex: 0 0 320px; max-height: 650px; overflow-y: auto"
      >
        <NodeInspectorPanel />
      </div>
    </div>

    <div
      v-if="store.nodes.length === 0 && !store.loading"
      style="
        padding: 3rem;
        text-align: center;
        color: var(--p-text-muted-color);
      "
    >
      Enter a file path and search to explore the dependency graph.
    </div>

    <BlastRadiusPanel />
  </div>
</template>
