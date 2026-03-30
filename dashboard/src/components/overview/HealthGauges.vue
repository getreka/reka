<script setup lang="ts">
import Knob from "primevue/knob";
import Card from "primevue/card";
import type { ToolStats } from "@/types/api";

const props = defineProps<{ stats: ToolStats | null }>();
</script>

<template>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem">
    <Card>
      <template #content>
        <div style="text-align: center">
          <div
            style="
              font-size: 2rem;
              font-weight: 700;
              color: var(--p-primary-color);
            "
          >
            {{ stats?.totalCalls?.toLocaleString() ?? "—" }}
          </div>
          <div style="color: var(--p-text-muted-color); margin-top: 0.25rem">
            Total Calls
          </div>
        </div>
      </template>
    </Card>
    <Card>
      <template #content>
        <div style="text-align: center">
          <Knob
            :model-value="Math.round((stats?.successRate ?? 0) * 100)"
            :max="100"
            :size="80"
            readonly
            value-template="{value}%"
          />
          <div style="color: var(--p-text-muted-color); margin-top: 0.25rem">
            Success Rate
          </div>
        </div>
      </template>
    </Card>
    <Card>
      <template #content>
        <div style="text-align: center">
          <div
            style="
              font-size: 2rem;
              font-weight: 700;
              color: var(--p-primary-color);
            "
          >
            {{
              stats?.avgLatencyMs != null ? Math.round(stats.avgLatencyMs) : "—"
            }}
          </div>
          <div style="color: var(--p-text-muted-color); margin-top: 0.25rem">
            Avg Latency (ms)
          </div>
        </div>
      </template>
    </Card>
  </div>
</template>
