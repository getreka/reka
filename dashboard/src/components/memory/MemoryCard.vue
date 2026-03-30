<script setup lang="ts">
import { ref } from "vue";
import Card from "primevue/card";
import Tag from "primevue/tag";
import Chip from "primevue/chip";
import Button from "primevue/button";
import type { Memory } from "@/types/memory";

const props = defineProps<{ memory: Memory }>();
const emit = defineEmits<{ delete: [id: string] }>();

const expanded = ref(false);
const needsTruncation = (props.memory.content?.length ?? 0) > 200;

const typeColors: Record<string, string> = {
  decision: "info",
  insight: "success",
  context: "secondary",
  todo: "warn",
  conversation: "contrast",
  note: "secondary",
};

function relativeDate(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
</script>

<template>
  <Card style="height: 100%">
    <template #content>
      <div
        style="display: flex; flex-direction: column; gap: 0.5rem; height: 100%"
      >
        <div
          style="
            display: flex;
            justify-content: space-between;
            align-items: center;
          "
        >
          <div style="display: flex; align-items: center; gap: 0.5rem">
            <Tag
              :severity="(typeColors[memory.type] as any) || 'secondary'"
              :value="memory.type"
            />
            <span
              v-if="memory.score != null"
              style="font-size: 0.7rem; color: var(--p-text-muted-color)"
            >
              {{ (memory.score * 100).toFixed(0) }}%
            </span>
          </div>
          <span style="font-size: 0.75rem; color: var(--p-text-muted-color)">{{
            relativeDate(memory.createdAt)
          }}</span>
        </div>

        <div
          v-if="memory.relatedTo"
          style="font-size: 0.75rem; color: var(--p-text-muted-color)"
        >
          Related: {{ memory.relatedTo }}
        </div>

        <div
          style="
            flex: 1;
            font-size: 0.875rem;
            line-height: 1.4;
            white-space: pre-wrap;
            word-break: break-word;
          "
        >
          {{
            expanded || !needsTruncation
              ? memory.content
              : memory.content.slice(0, 200) + "..."
          }}
          <a
            v-if="needsTruncation"
            href="#"
            @click.prevent="expanded = !expanded"
            style="font-size: 0.8rem; margin-left: 0.25rem"
          >
            {{ expanded ? "less" : "more" }}
          </a>
        </div>

        <div
          v-if="memory.tags?.length"
          style="display: flex; gap: 0.25rem; flex-wrap: wrap"
        >
          <Chip
            v-for="tag in memory.tags"
            :key="tag"
            :label="tag"
            style="font-size: 0.75rem"
          />
        </div>

        <div style="display: flex; justify-content: flex-end">
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            size="small"
            @click="emit('delete', memory.id)"
          />
        </div>
      </div>
    </template>
  </Card>
</template>
