<script setup lang="ts">
import { ref } from "vue";
import Tag from "primevue/tag";
import type { WorkingMemoryState } from "@/types/session";

const props = defineProps<{ workingMemory: WorkingMemoryState }>();

const TYPE_SEVERITY: Record<string, string> = {
  query: "info",
  search: "info",
  file: "secondary",
  code: "secondary",
  memory: "success",
  decision: "success",
  insight: "success",
  context: "contrast",
  tool_call: "warn",
};

function tagSeverity(type: string): string {
  return TYPE_SEVERITY[type] ?? "secondary";
}

function salienceColor(salience: number): string {
  if (salience >= 0.75) return "#22C55E";
  if (salience >= 0.5) return "#F97316";
  return "#94A3B8";
}

function preview(content: string): string {
  return content.length > 120 ? content.slice(0, 120) + "…" : content;
}
</script>

<template>
  <div>
    <div
      style="
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.5rem;
      "
    >
      <span style="font-size: 0.85rem; font-weight: 600">Working Memory</span>
      <span style="font-size: 0.75rem; color: var(--p-text-muted-color)">
        {{ workingMemory.slots.length }} / {{ workingMemory.capacity }} slots
      </span>
    </div>

    <!-- Capacity bar -->
    <div
      style="
        height: 4px;
        border-radius: 2px;
        background: var(--p-surface-200);
        margin-bottom: 0.6rem;
        overflow: hidden;
      "
    >
      <div
        :style="{
          height: '100%',
          borderRadius: '2px',
          background: '#3B82F6',
          width:
            workingMemory.capacity > 0
              ? `${(workingMemory.slots.length / workingMemory.capacity) * 100}%`
              : '0%',
          transition: 'width 0.3s ease',
        }"
      />
    </div>

    <div
      style="
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 260px;
        overflow-y: auto;
      "
    >
      <div
        v-for="(slot, i) in workingMemory.slots"
        :key="slot.id ?? i"
        style="
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 0.4rem 0.5rem;
          border-radius: 4px;
          background: var(--p-surface-50);
          border: 1px solid var(--p-surface-200);
        "
      >
        <div
          style="
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.25rem;
            flex-shrink: 0;
            padding-top: 1px;
          "
        >
          <span
            style="
              font-size: 0.65rem;
              color: var(--p-text-muted-color);
              line-height: 1;
            "
            >{{ (slot.index ?? i) + 1 }}</span
          >
          <div
            v-tooltip="`Salience: ${slot.salience.toFixed(2)}`"
            :style="{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: salienceColor(slot.salience),
              flexShrink: 0,
            }"
          />
        </div>
        <div style="flex: 1; min-width: 0">
          <div
            style="
              display: flex;
              align-items: center;
              gap: 0.4rem;
              margin-bottom: 0.2rem;
            "
          >
            <Tag
              :severity="tagSeverity(slot.type) as any"
              :value="slot.type"
              style="font-size: 0.65rem"
            />
            <span
              style="font-size: 0.65rem; color: var(--p-text-muted-color)"
              v-if="slot.timestamp"
            >
              {{ new Date(slot.timestamp).toLocaleTimeString() }}
            </span>
          </div>
          <div
            style="
              font-size: 0.8rem;
              color: var(--p-text-color);
              line-height: 1.35;
              word-break: break-word;
            "
          >
            {{ preview(slot.content) }}
          </div>
        </div>
      </div>

      <div
        v-if="workingMemory.slots.length === 0"
        style="
          font-size: 0.8rem;
          color: var(--p-text-muted-color);
          text-align: center;
          padding: 0.75rem 0;
        "
      >
        No working memory slots
      </div>
    </div>
  </div>
</template>
