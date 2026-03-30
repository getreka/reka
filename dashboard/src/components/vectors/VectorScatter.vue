<script setup lang="ts">
import { computed } from "vue";
import VChart from "vue-echarts";
import { useVectorsStore } from "@/stores/vectors";

const store = useVectorsStore();

const COLOR_MAPS: Record<string, Record<string, string>> = {
  language: {
    typescript: "#3178C6",
    javascript: "#F7DF1E",
    python: "#3776AB",
    vue: "#42B883",
    json: "#94A3B8",
    yaml: "#CB171E",
    markdown: "#083FA1",
    unknown: "#64748B",
  },
  layer: {
    api: "#3B82F6",
    service: "#22C55E",
    util: "#F97316",
    model: "#8B5CF6",
    middleware: "#EF4444",
    test: "#EAB308",
    config: "#94A3B8",
    other: "#64748B",
  },
  chunkType: {
    function: "#3B82F6",
    class: "#22C55E",
    interface: "#8B5CF6",
    type: "#F97316",
    code: "#64748B",
    config: "#94A3B8",
  },
};

function getColor(point: any): string {
  const map = COLOR_MAPS[store.colorBy] || COLOR_MAPS.language;
  const key = point[store.colorBy] || "unknown";
  return map[key] || "#64748B";
}

const categories = computed(() => {
  const map = COLOR_MAPS[store.colorBy] || COLOR_MAPS.language;
  return Object.entries(map).map(([name, color]) => ({
    name,
    itemStyle: { color },
  }));
});

const chartOption = computed(() => ({
  tooltip: {
    formatter: (params: any) => {
      const d = params.data;
      if (!d) return "";
      return `<b>${d.file?.split("/").pop() || d.id}</b><br/>${store.colorBy}: ${d[store.colorBy]}`;
    },
  },
  legend: {
    data: categories.value.map((c) => c.name),
    bottom: 0,
    textStyle: { fontSize: 10 },
  },
  xAxis: { show: false, type: "value" as const },
  yAxis: { show: false, type: "value" as const },
  series: categories.value.map((cat) => ({
    name: cat.name,
    type: "scatter",
    symbolSize: 8,
    itemStyle: cat.itemStyle,
    data: store.projected
      .filter((p) => (p as any)[store.colorBy] === cat.name)
      .map((p) => ({
        value: [p.x, p.y],
        ...p,
      })),
    emphasis: {
      itemStyle: {
        borderColor: "#fff",
        borderWidth: 2,
        shadowBlur: 10,
        shadowColor: "rgba(0,0,0,0.3)",
      },
    },
  })),
}));

function onChartClick(params: any) {
  if (params.data) {
    store.selectedPoint = params.data;
  }
}
</script>

<template>
  <div
    style="
      background: var(--p-surface-0);
      border: 1px solid var(--p-surface-200);
      border-radius: 8px;
      padding: 0.5rem;
    "
  >
    <VChart
      :option="chartOption"
      autoresize
      style="height: 550px; width: 100%"
      @click="onChartClick"
    />
  </div>
</template>
