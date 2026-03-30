<script setup lang="ts">
import Card from "primevue/card";
import Tag from "primevue/tag";
import Button from "primevue/button";
import type { QuarantineMemory } from "@/types/memory";

defineProps<{ memories: QuarantineMemory[] }>();
const emit = defineEmits<{ validate: [id: string, validated: boolean] }>();

const typeColors: Record<string, string> = {
  decision: "info",
  insight: "success",
  context: "secondary",
  todo: "warn",
  conversation: "contrast",
  note: "secondary",
};
</script>

<template>
  <div
    v-if="memories.length === 0"
    style="padding: 2rem; text-align: center; color: var(--p-text-muted-color)"
  >
    No unvalidated memories.
  </div>
  <div
    v-else
    style="
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding-top: 0.5rem;
    "
  >
    <Card v-for="mem in memories" :key="mem.id">
      <template #content>
        <div style="display: flex; flex-direction: column; gap: 0.5rem">
          <div
            style="
              display: flex;
              justify-content: space-between;
              align-items: center;
            "
          >
            <Tag
              :severity="(typeColors[mem.type] as any) || 'secondary'"
              :value="mem.type"
            />
            <span
              v-if="mem.confidence != null"
              style="font-size: 0.75rem; color: var(--p-text-muted-color)"
            >
              confidence: {{ (mem.confidence * 100).toFixed(0) }}%
            </span>
          </div>
          <div
            style="
              font-size: 0.875rem;
              white-space: pre-wrap;
              word-break: break-word;
            "
          >
            {{ mem.content }}
          </div>
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end">
            <Button
              icon="pi pi-check"
              severity="success"
              size="small"
              text
              @click="emit('validate', mem.id, true)"
            />
            <Button
              icon="pi pi-times"
              severity="danger"
              size="small"
              text
              @click="emit('validate', mem.id, false)"
            />
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>
