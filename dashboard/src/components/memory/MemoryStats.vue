<script setup lang="ts">
import Tag from "primevue/tag";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import type { MemoryStats, MemoryType } from "@/types/memory";

defineProps<{ stats: MemoryStats | null }>();
const emit = defineEmits<{ "bulk-delete": [type: MemoryType] }>();
const confirm = useConfirm();

const typeColors: Record<string, string> = {
  decision: "info",
  insight: "success",
  context: "secondary",
  todo: "warn",
  conversation: "contrast",
  note: "secondary",
};

function handleBulkDelete(type: string) {
  confirm.require({
    message: `Delete ALL "${type}" memories? This cannot be undone.`,
    header: "Confirm Bulk Delete",
    acceptLabel: "Delete All",
    rejectLabel: "Cancel",
    accept: () => emit("bulk-delete", type as MemoryType),
  });
}
</script>

<template>
  <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center">
    <Tag severity="primary" :value="`Total: ${stats?.total ?? 0}`" />
    <template v-if="stats?.byType">
      <span
        v-for="(count, type) in stats.byType"
        :key="type"
        style="display: inline-flex; align-items: center; gap: 2px"
      >
        <Tag
          :severity="(typeColors[type] as any) || 'secondary'"
          :value="`${type}: ${count}`"
        />
        <Button
          v-if="count > 0"
          icon="pi pi-trash"
          severity="danger"
          text
          size="small"
          style="width: 1.25rem; height: 1.25rem"
          @click="handleBulkDelete(type as string)"
          v-tooltip="`Delete all ${type}`"
        />
      </span>
    </template>
  </div>
</template>
