<script setup lang="ts">
import { computed, ref } from "vue";
import VChart from "vue-echarts";
import Button from "primevue/button";
import { useGraphStore } from "@/stores/graph";

const store = useGraphStore();
const chartRef = ref<InstanceType<typeof VChart> | null>(null);

const EDGE_COLORS: Record<string, string> = {
  imports: "#3B82F6",
  extends: "#22C55E",
  implements: "#F97316",
  calls: "#A855F7",
  depends_on: "#06B6D4",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  scip: "#22c55e",
  "tree-sitter": "#f59e0b",
  heuristic: "#9ca3af",
};

const filteredLinks = computed(() => {
  let links = store.links;

  if (store.edgeTypeFilter !== "all") {
    links = links.filter((l) => (l.type || "imports") === store.edgeTypeFilter);
  }

  if (store.confidenceFilter !== "all") {
    if (store.confidenceFilter === "scip") {
      links = links.filter((l) => l.confidence === "scip");
    } else if (store.confidenceFilter === "tree-sitter+") {
      links = links.filter(
        (l) => l.confidence === "scip" || l.confidence === "tree-sitter",
      );
    }
    // "any" keeps all links that have any confidence field set (no-op since
    // backward-compat edges without confidence still display normally)
  }

  return links;
});

const filteredNodeIds = computed(() => {
  const ids = new Set<string>();
  for (const l of filteredLinks.value) {
    ids.add(l.source);
    ids.add(l.target);
  }
  return ids;
});

const filteredNodes = computed(() => {
  if (store.edgeTypeFilter === "all" && !store.filePatternFilter)
    return store.nodes;
  return store.nodes.filter((n) => {
    if (store.edgeTypeFilter !== "all" && !filteredNodeIds.value.has(n.id))
      return false;
    if (store.filePatternFilter && !n.id.includes(store.filePatternFilter))
      return false;
    return true;
  });
});

const layoutConfig = computed(() => {
  switch (store.layoutMode) {
    case "circular":
      return {
        layout: "circular",
        circular: { rotateLabel: true },
        force: undefined,
      };
    case "tree":
      return {
        layout: "force",
        force: { repulsion: 400, edgeLength: [100, 200], gravity: 0.05 },
      };
    default:
      return {
        layout: "force",
        force: { repulsion: 250, edgeLength: [80, 180], gravity: 0.08 },
      };
  }
});

const categories = [
  { name: "imports", itemStyle: { color: "#3B82F6" } },
  { name: "extends", itemStyle: { color: "#22C55E" } },
  { name: "implements", itemStyle: { color: "#F97316" } },
  { name: "calls", itemStyle: { color: "#A855F7" } },
  { name: "depends_on", itemStyle: { color: "#06B6D4" } },
  { name: "selected", itemStyle: { color: "#EF4444" } },
];

const chartOption = computed(() => ({
  tooltip: {
    formatter: (params: any) => {
      if (params.dataType === "edge") {
        const type = params.data.type || "imports";
        const confidence = params.data.confidence;
        const symbol = params.data.symbolDescriptor;
        let tip = `<b>${type}</b><br/>${params.data.source} → ${params.data.target}`;
        if (confidence) tip += `<br/>Confidence: <b>${confidence}</b>`;
        if (symbol) tip += `<br/>Symbol: ${symbol}`;
        return tip;
      }
      return `<b>${params.data.id}</b><br/>Connections: ${params.data.connectionCount || 0}`;
    },
  },
  legend: {
    data: ["imports", "extends", "implements", "calls", "depends_on"],
    bottom: 0,
    textStyle: { fontSize: 11 },
  },
  animationDurationUpdate: 400,
  series: [
    {
      type: "graph",
      ...layoutConfig.value,
      roam: true,
      draggable: true,
      categories,
      label: {
        show: true,
        fontSize: 10,
        position: "right",
      },
      edgeLabel: {
        show: store.links.length < 60,
        fontSize: 9,
        formatter: (params: any) => params.data.type || "",
      },
      data: filteredNodes.value.map((n) => {
        const isSelected = n.id === store.selectedNode;
        const isSearch = n.id === store.searchFile;
        const baseSize = Math.min(8 + (n.connectionCount || 1) * 3, 40);
        return {
          name: n.name,
          id: n.id,
          connectionCount: n.connectionCount || 0,
          symbolSize: isSearch ? 35 : isSelected ? 30 : baseSize,
          category: isSearch || isSelected ? 3 : 0,
          itemStyle: isSearch
            ? { color: "#EF4444", borderColor: "#fff", borderWidth: 2 }
            : isSelected
              ? { color: "#F59E0B", borderColor: "#fff", borderWidth: 2 }
              : { color: "#64748B" },
        };
      }),
      links: filteredLinks.value.map((l) => {
        const edgeType = l.type || "imports";
        const baseColor = EDGE_COLORS[edgeType] || "#94A3B8";
        const color = l.confidence
          ? (CONFIDENCE_COLORS[l.confidence] ?? baseColor)
          : baseColor;
        return {
          source: l.source,
          target: l.target,
          type: edgeType,
          confidence: l.confidence,
          symbolDescriptor: l.symbolDescriptor,
          lineStyle: {
            color,
            width: 1.5,
            curveness: 0.15,
            type: edgeType === "calls" ? "dashed" : "solid",
          },
        };
      }),
      emphasis: {
        focus: "adjacency",
        lineStyle: { width: 3 },
      },
    },
  ],
}));

function onChartClick(params: any) {
  if (params.dataType === "node" && params.data?.id) {
    store.selectNode(params.data.id);
  }
}

function fitToScreen() {
  chartRef.value?.chart?.dispatchAction({ type: "restore" });
}
</script>

<template>
  <div
    style="
      background: var(--p-surface-0);
      border: 1px solid var(--p-surface-200);
      border-radius: 8px;
      padding: 0.5rem;
      position: relative;
    "
  >
    <div
      style="
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        z-index: 10;
        display: flex;
        gap: 0.25rem;
      "
    >
      <Button
        icon="pi pi-arrows-alt"
        text
        size="small"
        v-tooltip="'Fit to screen'"
        @click="fitToScreen"
      />
    </div>
    <VChart
      ref="chartRef"
      :option="chartOption"
      autoresize
      style="height: 600px; width: 100%"
      @click="onChartClick"
    />
  </div>
</template>
