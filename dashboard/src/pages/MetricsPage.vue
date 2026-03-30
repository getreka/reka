<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import VChart from "vue-echarts";
import { use } from "echarts/core";
import { BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import Card from "primevue/card";
import Tag from "primevue/tag";
import ProgressBar from "primevue/progressbar";
import Message from "primevue/message";
import Button from "primevue/button";
import {
  fetchPrometheusMetrics,
  fetchQueues,
  fetchActors,
} from "@/api/metrics";

use([
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

// --- Types ---
interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}

interface ActorStats {
  mailboxDepth: number;
  active: number;
  completed: number;
  failed: number;
}

// --- State ---
const prometheusText = ref("");
const queues = ref<Record<string, QueueStats>>({});
const actors = ref<Record<string, ActorStats>>({});
const error = ref<string | null>(null);
const loading = ref(true);
let intervalId: ReturnType<typeof setInterval> | null = null;

// --- Prometheus parser ---
function parsePrometheusMetric(
  text: string,
  metricName: string,
): Array<{ labels: Record<string, string>; value: number }> {
  const results: Array<{ labels: Record<string, string>; value: number }> = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("#") || !line.startsWith(metricName)) continue;
    const match = line.match(/^(\w+)(?:\{([^}]*)\})?\s+(\S+)/);
    if (match && match[1] === metricName) {
      const labels: Record<string, string> = {};
      if (match[2]) {
        for (const pair of match[2].split(",")) {
          const [k, v] = pair.split("=");
          labels[k.trim()] = v?.replace(/"/g, "").trim() || "";
        }
      }
      results.push({ labels, value: parseFloat(match[3]) });
    }
  }
  return results;
}

// --- Section 1: Event Throughput ---
const emittedByType = computed(() => {
  return parsePrometheusMetric(prometheusText.value, "rag_event_emitted_total");
});

const eventThroughputOption = computed(() => {
  const groups: Record<string, number> = {};
  for (const item of emittedByType.value) {
    const eventType = item.labels["event_type"] || "unknown";
    groups[eventType] = (groups[eventType] || 0) + item.value;
  }
  const types = Object.keys(groups);
  const values = types.map((t) => groups[t]);

  return {
    tooltip: { trigger: "axis" as const },
    grid: { left: 60, right: 20, top: 20, bottom: 80 },
    xAxis: {
      type: "category" as const,
      data: types,
      axisLabel: { rotate: 30, overflow: "truncate" as const, width: 100 },
    },
    yAxis: { type: "value" as const },
    series: [
      {
        type: "bar" as const,
        data: values,
        name: "Events Emitted",
        itemStyle: { color: "#6366f1" },
      },
    ],
  };
});

// --- Section 2: Event Processing ---
const processedByQueue = computed(() => {
  const queueData: Record<string, QueueStats> = queues.value;
  const names = Object.keys(queueData);
  return {
    names,
    completed: names.map((n) => queueData[n].completed),
    failed: names.map((n) => queueData[n].failed),
  };
});

const totalCompleted = computed(() =>
  Object.values(queues.value).reduce((sum, q) => sum + q.completed, 0),
);
const totalFailed = computed(() =>
  Object.values(queues.value).reduce((sum, q) => sum + q.failed, 0),
);

const processingChartOption = computed(() => {
  const { names, completed, failed } = processedByQueue.value;
  return {
    tooltip: { trigger: "axis" as const },
    legend: { bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: { type: "category" as const, data: names },
    yAxis: { type: "value" as const },
    series: [
      {
        name: "Completed",
        type: "bar" as const,
        data: completed,
        itemStyle: { color: "#22c55e" },
      },
      {
        name: "Failed",
        type: "bar" as const,
        data: failed,
        itemStyle: { color: "#ef4444" },
      },
    ],
  };
});

// --- Section 3: Actor Health ---
const actorList = computed(() =>
  Object.entries(actors.value).map(([name, stats]) => ({ name, ...stats })),
);

function mailboxPercent(depth: number): number {
  // Treat 100 as "full" for display purposes
  return Math.min(100, Math.round((depth / 100) * 100));
}

// --- Section 4: Lock Contentions ---
const totalLockContentions = computed(() => {
  const items = parsePrometheusMetric(
    prometheusText.value,
    "rag_actor_lock_contentions_total",
  );
  return items.reduce((sum, i) => sum + i.value, 0);
});

// --- Data loading ---
async function loadAll() {
  try {
    const [metricsText, queuesData, actorsData] = await Promise.all([
      fetchPrometheusMetrics(),
      fetchQueues(),
      fetchActors(),
    ]);
    prometheusText.value = metricsText;
    queues.value = queuesData;
    actors.value = actorsData;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load metrics";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadAll();
  intervalId = setInterval(loadAll, 10_000);
});

onUnmounted(() => {
  if (intervalId !== null) clearInterval(intervalId);
});
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div
      style="display: flex; justify-content: space-between; align-items: center"
    >
      <h2 style="margin: 0; font-size: 1.25rem; font-weight: 600">
        Metrics / Observability
      </h2>
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        text
        @click="loadAll()"
      />
    </div>

    <Message v-if="error" severity="warn" :closable="false">
      Some metrics may be unavailable: {{ error }}
    </Message>

    <!-- Section 1: Event Throughput -->
    <Card>
      <template #title>Event Throughput</template>
      <template #subtitle
        >Events emitted by type (rag_event_emitted_total)</template
      >
      <template #content>
        <VChart
          v-if="emittedByType.length > 0"
          :option="eventThroughputOption"
          style="height: 300px"
          autoresize
        />
        <div
          v-else
          style="
            height: 300px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--p-text-muted-color);
            font-size: 0.875rem;
          "
        >
          No event data — check that /metrics is reachable
        </div>
      </template>
    </Card>

    <!-- Section 2: Event Processing -->
    <Card>
      <template #title>Event Processing</template>
      <template #subtitle>Queue job counts by queue name</template>
      <template #content>
        <div style="display: flex; gap: 2rem; margin-bottom: 1rem">
          <div style="text-align: center">
            <div style="font-size: 2rem; font-weight: 700; color: #22c55e">
              {{ totalCompleted.toLocaleString() }}
            </div>
            <div style="font-size: 0.875rem; color: var(--p-text-muted-color)">
              Total Completed
            </div>
          </div>
          <div style="text-align: center">
            <div
              style="font-size: 2rem; font-weight: 700"
              :style="{
                color:
                  totalFailed > 0 ? '#ef4444' : 'var(--p-text-muted-color)',
              }"
            >
              {{ totalFailed.toLocaleString() }}
            </div>
            <div style="font-size: 0.875rem; color: var(--p-text-muted-color)">
              Total Failed
            </div>
          </div>
        </div>
        <VChart
          v-if="processedByQueue.names.length > 0"
          :option="processingChartOption"
          style="height: 260px"
          autoresize
        />
        <div
          v-else
          style="
            height: 260px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--p-text-muted-color);
            font-size: 0.875rem;
          "
        >
          No queue data — check that /api/admin/queues is reachable
        </div>
      </template>
    </Card>

    <!-- Section 3: Actor Health -->
    <Card>
      <template #title>Actor Health</template>
      <template #subtitle>Mailbox depth and job counts per actor</template>
      <template #content>
        <div
          v-if="actorList.length > 0"
          style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 1rem;
          "
        >
          <div
            v-for="actor in actorList"
            :key="actor.name"
            style="
              border: 1px solid var(--p-surface-200);
              border-radius: 8px;
              padding: 1rem;
              display: flex;
              flex-direction: column;
              gap: 0.5rem;
            "
          >
            <div
              style="
                font-weight: 600;
                font-size: 0.875rem;
                word-break: break-all;
              "
            >
              {{ actor.name }}
            </div>
            <div style="font-size: 0.75rem; color: var(--p-text-muted-color)">
              Mailbox depth: {{ actor.mailboxDepth }}
            </div>
            <ProgressBar
              :value="mailboxPercent(actor.mailboxDepth)"
              :pt="{
                value: {
                  style: {
                    background:
                      actor.mailboxDepth >= 10
                        ? '#ef4444'
                        : actor.mailboxDepth > 0
                          ? '#f59e0b'
                          : '#22c55e',
                  },
                },
              }"
              style="height: 6px"
            />
            <div
              style="
                display: flex;
                gap: 0.5rem;
                flex-wrap: wrap;
                margin-top: 0.25rem;
              "
            >
              <Tag
                severity="secondary"
                :value="`Active: ${actor.active}`"
                style="font-size: 0.7rem"
              />
              <Tag
                severity="success"
                :value="`Done: ${actor.completed}`"
                style="font-size: 0.7rem"
              />
              <Tag
                v-if="actor.failed > 0"
                severity="danger"
                :value="`Failed: ${actor.failed}`"
                style="font-size: 0.7rem"
              />
            </div>
          </div>
        </div>
        <div
          v-else
          style="
            padding: 2rem;
            text-align: center;
            color: var(--p-text-muted-color);
            font-size: 0.875rem;
          "
        >
          No actor data — check that /api/admin/actors is reachable
        </div>
      </template>
    </Card>

    <!-- Section 4: Lock Contentions -->
    <Card>
      <template #title>Lock Contentions</template>
      <template #subtitle>rag_actor_lock_contentions_total</template>
      <template #content>
        <div style="display: flex; align-items: center; gap: 1rem">
          <div
            style="font-size: 2.5rem; font-weight: 700"
            :style="{ color: totalLockContentions > 0 ? '#ef4444' : '#22c55e' }"
          >
            {{ totalLockContentions.toLocaleString() }}
          </div>
          <Tag
            v-if="totalLockContentions > 0"
            severity="danger"
            value="Contentions detected"
            icon="pi pi-exclamation-triangle"
          />
          <Tag
            v-else
            severity="success"
            value="No contentions"
            icon="pi pi-check"
          />
        </div>
        <div
          v-if="totalLockContentions > 0"
          style="
            margin-top: 0.75rem;
            font-size: 0.875rem;
            color: var(--p-text-muted-color);
          "
        >
          Lock contentions indicate actors are competing for shared state.
          Consider reviewing actor concurrency settings.
        </div>
      </template>
    </Card>

    <div
      style="
        font-size: 0.75rem;
        color: var(--p-text-muted-color);
        text-align: right;
      "
    >
      Auto-refreshes every 10s
    </div>
  </div>
</template>
