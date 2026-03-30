<script setup lang="ts">
import { computed } from "vue";
import Card from "primevue/card";
import Knob from "primevue/knob";
import VChart from "vue-echarts";

const props = defineProps<{ stats?: Record<string, any> | null }>();

const hitPct = computed(() => {
  if (!props.stats) return 0;
  return Math.round((props.stats.hitRate || 0) * 100);
});

const strategyChart = computed(() => {
  const strats = props.stats?.byStrategy ?? props.stats?.strategies;
  if (!strats || Object.keys(strats).length === 0) return null;
  const entries = Object.entries(strats);
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: entries.map((e) => e[0]) },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        data: entries.map((e) => e[1]),
        itemStyle: { color: "#8B5CF6" },
      },
    ],
  };
});
</script>

<template>
  <Card>
    <template #title>Prediction Stats</template>
    <template #content>
      <div
        v-if="!stats"
        style="color: var(--p-text-muted-color); font-size: 0.875rem"
      >
        No data
      </div>
      <div v-else style="display: flex; flex-direction: column; gap: 0.75rem">
        <div style="display: flex; align-items: center; gap: 1.5rem">
          <div style="text-align: center">
            <Knob
              :modelValue="hitPct"
              :size="80"
              readonly
              valueColor="#8B5CF6"
            />
            <div
              style="
                font-size: 0.75rem;
                color: var(--p-text-muted-color);
                margin-top: 0.25rem;
              "
            >
              Hit Rate
            </div>
          </div>
          <div style="font-size: 0.875rem">
            <div>
              <b>{{ (stats.totalPredictions ?? 0).toLocaleString() }}</b>
              predictions
            </div>
          </div>
        </div>
        <VChart
          v-if="strategyChart"
          :option="strategyChart"
          autoresize
          style="height: 150px; width: 100%"
        />
      </div>
    </template>
  </Card>
</template>
