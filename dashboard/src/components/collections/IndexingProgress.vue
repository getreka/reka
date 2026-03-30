<script setup lang="ts">
import { watch, computed } from "vue";
import ProgressBar from "primevue/progressbar";
import Tag from "primevue/tag";
import type { IndexStatus } from "@/types/collections";
import { useSSE } from "@/composables/useSSE";

const props = defineProps<{
  status: IndexStatus | null;
  collection?: string;
}>();

const sse = useSSE<IndexStatus>(() => {
  if (props.collection && props.status?.status === "indexing") {
    return `/api/index/status/${props.collection}/stream`;
  }
  return null;
});

// Auto-connect SSE when indexing
watch(
  () => props.status?.status,
  (status) => {
    if (status === "indexing" && props.collection) {
      sse.connect();
    } else {
      sse.disconnect();
    }
  },
  { immediate: true },
);

const liveStatus = computed(() => sse.data.value || props.status);
const currentFile = computed(() => (sse.data.value as any)?.currentFile);

function severityForStatus(s: string) {
  switch (s) {
    case "completed":
      return "success";
    case "indexing":
      return "info";
    case "error":
      return "danger";
    default:
      return "secondary";
  }
}
</script>

<template>
  <div
    v-if="liveStatus"
    style="display: flex; flex-direction: column; gap: 0.5rem"
  >
    <div style="display: flex; align-items: center; gap: 0.75rem">
      <Tag
        :severity="severityForStatus(liveStatus.status) as any"
        :value="liveStatus.status"
      />
      <span
        v-if="sse.connected.value"
        style="font-size: 0.7rem; color: var(--p-primary-color)"
      >
        <i
          class="pi pi-circle-fill"
          style="font-size: 0.5rem; margin-right: 0.25rem"
        />LIVE
      </span>
      <ProgressBar
        v-if="liveStatus.status === 'indexing' && liveStatus.progress != null"
        :value="Math.round(liveStatus.progress * 100)"
        style="flex: 1; height: 1rem"
      />
      <span
        v-if="liveStatus.indexedFiles != null"
        style="font-size: 0.8rem; color: var(--p-text-muted-color)"
      >
        {{ liveStatus.indexedFiles }}/{{ liveStatus.totalFiles ?? "?" }} files
      </span>
    </div>
    <div
      v-if="currentFile"
      style="
        font-size: 0.75rem;
        color: var(--p-text-muted-color);
        font-family: monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      "
    >
      {{ currentFile }}
    </div>
  </div>
</template>
