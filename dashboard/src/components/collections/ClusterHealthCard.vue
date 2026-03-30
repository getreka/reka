<script setup lang="ts">
import Tag from "primevue/tag";
import type { ClusterHealth } from "@/types/collections";

defineProps<{ health?: ClusterHealth | null }>();
</script>

<template>
  <div
    v-if="health"
    style="
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1rem;
      background: var(--p-surface-0);
      border: 1px solid var(--p-surface-200);
      border-radius: 8px;
      font-size: 0.875rem;
    "
  >
    <span style="font-weight: 600">Qdrant Cluster:</span>
    <Tag
      :severity="
        health.status === 'ok' || health.status === 'green' ? 'success' : 'warn'
      "
      :value="health.status"
    />
    <span v-if="health.nodes != null" style="color: var(--p-text-muted-color)"
      >Nodes: {{ health.nodes }}</span
    >
    <span
      v-if="health.pendingOperations"
      style="color: var(--p-text-muted-color)"
      >Pending: {{ health.pendingOperations }}</span
    >
  </div>
</template>
