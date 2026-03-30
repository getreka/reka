<script setup lang="ts">
import { computed } from "vue";
import Card from "primevue/card";
import Knob from "primevue/knob";

const props = defineProps<{ stats?: Record<string, any> | null }>();

const helpfulPct = computed(() => {
  if (!props.stats) return 0;
  const rate = props.stats.searchHelpfulRate ?? props.stats.helpfulRate ?? 0;
  return Math.round((rate || 0) * 100);
});

const totalFeedback = computed(() => {
  if (!props.stats) return 0;
  return (
    (props.stats.totalSearchFeedback ?? 0) +
      (props.stats.totalMemoryFeedback ?? 0) ||
    props.stats.totalFeedback ||
    0
  );
});
</script>

<template>
  <Card>
    <template #title>Feedback Trends</template>
    <template #content>
      <div
        v-if="!stats"
        style="color: var(--p-text-muted-color); font-size: 0.875rem"
      >
        No data
      </div>
      <div v-else style="display: flex; align-items: center; gap: 1.5rem">
        <div style="text-align: center">
          <Knob
            :modelValue="helpfulPct"
            :size="80"
            readonly
            valueColor="#10B981"
          />
          <div
            style="
              font-size: 0.75rem;
              color: var(--p-text-muted-color);
              margin-top: 0.25rem;
            "
          >
            Helpful
          </div>
        </div>
        <div
          style="
            font-size: 0.875rem;
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
          "
        >
          <div>
            <b>{{ totalFeedback }}</b> total feedback
          </div>
          <div>
            <b>{{ stats.totalSearchFeedback ?? stats.searchFeedback ?? 0 }}</b>
            search
          </div>
          <div>
            <b>{{ stats.totalMemoryFeedback ?? stats.memoryFeedback ?? 0 }}</b>
            memory
          </div>
          <div
            v-if="stats.recentTrend"
            style="font-size: 0.8rem; color: var(--p-text-muted-color)"
          >
            Trend: {{ stats.recentTrend }}
          </div>
        </div>
      </div>
    </template>
  </Card>
</template>
