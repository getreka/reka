<script setup lang="ts">
import { computed } from "vue";
import VChart from "vue-echarts";
import type { CollectionAnalytics } from "@/types/collections";

const props = defineProps<{ analytics?: CollectionAnalytics | null }>();

const languageChart = computed(() => {
  const breakdown = props.analytics?.languageBreakdown;
  if (!breakdown || Object.keys(breakdown).length === 0) return null;
  const entries = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: entries.map((e) => e[0]) },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        data: entries.map((e) => e[1]),
        itemStyle: { color: "#3B82F6" },
      },
    ],
  };
});
</script>

<template>
  <div
    v-if="!analytics"
    style="padding: 1rem; color: var(--p-text-muted-color); font-size: 0.875rem"
  >
    No analytics available.
  </div>
  <div
    v-else
    style="
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding-top: 0.5rem;
      font-size: 0.875rem;
    "
  >
    <div><b>Vectors:</b> {{ analytics.vectors?.toLocaleString() }}</div>
    <div><b>Segments:</b> {{ analytics.segments }}</div>
    <div v-if="analytics.diskUsageMb != null">
      <b>Disk Usage:</b> {{ analytics.diskUsageMb.toFixed(1) }} MB
    </div>

    <div v-if="languageChart">
      <b>Language Breakdown:</b>
      <VChart
        :option="languageChart"
        autoresize
        style="height: 200px; width: 100%; margin-top: 0.5rem"
      />
    </div>
  </div>
</template>
