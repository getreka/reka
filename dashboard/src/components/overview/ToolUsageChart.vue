<script setup lang="ts">
import { computed } from "vue";
import VChart from "vue-echarts";
import { use } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

const props = defineProps<{ callsByHour?: Record<string, number> }>();

const option = computed(() => {
  const data = props.callsByHour ?? {};
  const hours = Array.from({ length: 24 }, (_, i) =>
    String(i).padStart(2, "0"),
  );
  const values = hours.map((h) => data[h] ?? data[String(Number(h))] ?? 0);

  return {
    tooltip: { trigger: "axis" as const },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: { type: "category" as const, data: hours },
    yAxis: { type: "value" as const },
    series: [
      {
        type: "line" as const,
        data: values,
        smooth: true,
        areaStyle: { opacity: 0.15 },
      },
    ],
  };
});
</script>

<template>
  <VChart
    v-if="callsByHour && Object.keys(callsByHour).length > 0"
    :option="option"
    style="height: 250px"
    autoresize
  />
  <div
    v-else
    style="
      height: 250px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--p-text-muted-color);
      font-size: 0.875rem;
    "
  >
    No data
  </div>
</template>
