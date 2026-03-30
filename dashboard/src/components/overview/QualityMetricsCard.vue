<script setup lang="ts">
import Card from "primevue/card";

defineProps<{ metrics: Record<string, any> | null }>();

function pct(val: unknown): string {
  if (typeof val !== "number") return "—";
  return `${Math.round(val * 100)}%`;
}
</script>

<template>
  <Card>
    <template #title>Quality Metrics</template>
    <template #content>
      <div v-if="!metrics" style="color: var(--p-text-muted-color)">
        No data available
      </div>
      <div
        v-else
        style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem"
      >
        <div>
          <h4 style="margin: 0 0 0.5rem">Search</h4>
          <div
            style="
              display: flex;
              flex-direction: column;
              gap: 0.25rem;
              font-size: 0.875rem;
            "
          >
            <span
              >Feedback:
              <b>{{
                metrics.searchQuality?.totalFeedback ??
                metrics.search?.totalFeedback ??
                0
              }}</b></span
            >
            <span
              >Helpful:
              <b>{{
                pct(
                  metrics.searchQuality?.helpfulRate ??
                    metrics.search?.helpfulRate,
                )
              }}</b></span
            >
          </div>
        </div>
        <div>
          <h4 style="margin: 0 0 0.5rem">Memory</h4>
          <div
            style="
              display: flex;
              flex-direction: column;
              gap: 0.25rem;
              font-size: 0.875rem;
            "
          >
            <span
              >Feedback:
              <b>{{
                metrics.memoryQuality?.totalFeedback ??
                metrics.memory?.totalFeedback ??
                0
              }}</b></span
            >
            <span
              >Accurate:
              <b>{{
                pct(
                  metrics.memoryQuality?.accuracyRate ??
                    metrics.memory?.accurateRate,
                )
              }}</b></span
            >
            <span
              >Outdated:
              <b>{{
                pct(
                  metrics.memoryQuality?.outdatedRate ??
                    metrics.memory?.outdatedRate,
                )
              }}</b></span
            >
          </div>
        </div>
        <div
          v-if="metrics.trends"
          style="
            grid-column: span 2;
            font-size: 0.8rem;
            color: var(--p-text-muted-color);
          "
        >
          Trend: {{ metrics.trends.trend ?? "stable" }} (7d:
          {{ metrics.trends.last7Days ?? 0 }}, 30d:
          {{ metrics.trends.last30Days ?? 0 }})
        </div>
      </div>
    </template>
  </Card>
</template>
