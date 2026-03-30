<script setup lang="ts">
import { computed } from "vue";
import Card from "primevue/card";
import Button from "primevue/button";
import Tag from "primevue/tag";
import SelectButton from "primevue/selectbutton";
import VChart from "vue-echarts";
import { useGraphStore } from "@/stores/graph";

const store = useGraphStore();

const viewOptions = [
  { label: "List", value: "list" },
  { label: "Graph", value: "graph" },
];

const HOP_COLORS = ["#EF4444", "#F97316", "#EAB308", "#94A3B8", "#64748B"];

const groupedByHop = computed(() => {
  if (!store.blastRadius) return [];
  const map = new Map<number, string[]>();
  for (const f of store.blastRadius.affectedFiles) {
    const list = map.get(f.hop) || [];
    list.push(f.file);
    map.set(f.hop, list);
  }
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
});

const treeChartOption = computed(() => {
  if (!store.blastRadius || store.blastRadius.affectedFiles.length === 0)
    return {};

  const nodes: any[] = [];
  const links: any[] = [];
  const sourceFile = store.searchFile;

  // Center node
  nodes.push({
    name: sourceFile.split("/").pop() || sourceFile,
    id: sourceFile,
    symbolSize: 30,
    itemStyle: { color: "#EF4444" },
    x: 0,
    y: 0,
    fixed: true,
    label: { show: true, fontSize: 11, fontWeight: "bold" },
  });

  // Group by hop and place radially
  const hopGroups = groupedByHop.value;
  for (const [hop, files] of hopGroups) {
    const radius = hop * 150;
    const angleStep = (2 * Math.PI) / Math.max(files.length, 1);
    files.forEach((file, i) => {
      const angle = i * angleStep - Math.PI / 2;
      const colorIdx = Math.min(hop - 1, HOP_COLORS.length - 1);
      nodes.push({
        name: file.split("/").pop() || file,
        id: file,
        symbolSize: Math.max(20 - hop * 3, 8),
        itemStyle: { color: HOP_COLORS[colorIdx] },
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        label: { show: hop <= 2, fontSize: 9 },
      });
      links.push({ source: sourceFile, target: file });
    });
  }

  return {
    tooltip: {
      formatter: (params: any) => {
        if (params.dataType === "node") {
          const hop = store.blastRadius?.affectedFiles.find(
            (f) => f.file === params.data.id,
          )?.hop;
          return `<b>${params.data.id}</b>${hop != null ? `<br/>Hop: ${hop}` : ""}`;
        }
        return "";
      },
    },
    series: [
      {
        type: "graph",
        layout: "none",
        roam: true,
        data: nodes,
        links,
        lineStyle: { color: "#CBD5E1", width: 1, curveness: 0.1 },
        emphasis: { focus: "adjacency" },
      },
    ],
  };
});

function navigateToFile(file: string) {
  store.searchFile = file;
  store.search();
}
</script>

<template>
  <Card v-if="store.searchFile">
    <template #title>
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.5rem;
        "
      >
        <span>Blast Radius</span>
        <div style="display: flex; gap: 0.5rem; align-items: center">
          <SelectButton
            v-if="store.blastRadius"
            v-model="store.blastViewMode"
            :options="viewOptions"
            optionLabel="label"
            optionValue="value"
            :allowEmpty="false"
            size="small"
          />
          <Button
            label="Analyze"
            icon="pi pi-bolt"
            size="small"
            severity="warn"
            :loading="store.blastLoading"
            @click="store.analyzeBlastRadius()"
          />
        </div>
      </div>
    </template>
    <template #content>
      <div
        v-if="!store.blastRadius"
        style="color: var(--p-text-muted-color); font-size: 0.875rem"
      >
        Click Analyze to see how many files would be affected by changes.
      </div>

      <!-- List View -->
      <div
        v-else-if="store.blastViewMode === 'list'"
        style="display: flex; flex-direction: column; gap: 0.75rem"
      >
        <div style="font-size: 0.875rem">
          <b>{{ store.blastRadius.totalAffected }}</b> files affected
        </div>
        <div v-for="[hop, files] in groupedByHop" :key="hop">
          <div
            style="
              display: flex;
              align-items: center;
              gap: 0.5rem;
              margin-bottom: 0.25rem;
            "
          >
            <Tag
              :value="`Hop ${hop}`"
              :style="{
                background:
                  HOP_COLORS[Math.min(hop - 1, HOP_COLORS.length - 1)],
                color: '#fff',
              }"
            />
            <span style="font-size: 0.8rem; color: var(--p-text-muted-color)"
              >{{ files.length }} files</span
            >
          </div>
          <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.8rem">
            <li
              v-for="f in files"
              :key="f"
              style="cursor: pointer"
              @click="navigateToFile(f)"
            >
              {{ f }}
            </li>
          </ul>
        </div>
      </div>

      <!-- Graph View -->
      <div v-else>
        <div style="font-size: 0.875rem; margin-bottom: 0.5rem">
          <b>{{ store.blastRadius.totalAffected }}</b> files affected
          <span
            style="
              margin-left: 1rem;
              font-size: 0.8rem;
              color: var(--p-text-muted-color);
            "
          >
            <span
              v-for="(color, i) in HOP_COLORS.slice(0, 4)"
              :key="i"
              style="margin-right: 0.75rem"
            >
              <span
                :style="{
                  display: 'inline-block',
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  background: color,
                  marginRight: '4px',
                }"
              />
              Hop {{ i + 1 }}{{ i === 3 ? "+" : "" }}
            </span>
          </span>
        </div>
        <VChart
          :option="treeChartOption"
          autoresize
          style="height: 400px; width: 100%"
        />
      </div>
    </template>
  </Card>
</template>
