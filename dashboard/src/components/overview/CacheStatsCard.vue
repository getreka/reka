<script setup lang="ts">
import { computed } from "vue";
import Card from "primevue/card";
import Knob from "primevue/knob";
import Tag from "primevue/tag";
import type { CacheStats } from "@/types/api";

const props = defineProps<{ stats?: CacheStats | null }>();

const hitPct = computed(() => {
  if (!props.stats) return 0;
  if (props.stats.hitRate != null) return Math.round(props.stats.hitRate * 100);
  if (props.stats.totalRequests && props.stats.totalHits) {
    return Math.round(
      (props.stats.totalHits / props.stats.totalRequests) * 100,
    );
  }
  return 0;
});
</script>

<template>
  <Card>
    <template #title>Cache Stats</template>
    <template #content>
      <div
        v-if="!stats"
        style="color: var(--p-text-muted-color); font-size: 0.875rem"
      >
        No data
      </div>
      <div
        v-else
        style="
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          font-size: 0.875rem;
        "
      >
        <div style="display: flex; align-items: center; gap: 1rem">
          <Tag
            v-if="stats.connected != null"
            :severity="stats.connected ? 'success' : 'danger'"
            :value="stats.connected ? 'Connected' : 'Disconnected'"
          />
          <Tag
            v-if="stats.enabled != null"
            :severity="stats.enabled ? 'info' : 'secondary'"
            :value="stats.enabled ? 'Enabled' : 'Disabled'"
          />
        </div>

        <!-- Key-based stats (actual API shape) -->
        <div v-if="stats.totalKeys != null">
          <div>
            <b>{{ stats.totalKeys }}</b> total keys
          </div>
          <div v-if="stats.embeddingKeys">
            <b>{{ stats.embeddingKeys }}</b> embedding
          </div>
          <div v-if="stats.searchKeys">
            <b>{{ stats.searchKeys }}</b> search
          </div>
          <div v-if="stats.sessionKeys">
            <b>{{ stats.sessionKeys }}</b> session
          </div>
          <div v-if="stats.memoryUsage">
            Memory: <b>{{ stats.memoryUsage }}</b>
          </div>
        </div>

        <!-- Hit-rate stats (alternative shape) -->
        <div
          v-if="stats.totalRequests != null"
          style="display: flex; align-items: center; gap: 1.5rem"
        >
          <div style="text-align: center">
            <Knob
              :modelValue="hitPct"
              :size="80"
              readonly
              valueColor="#F59E0B"
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
          <div>
            <div>
              <b>{{ stats.totalRequests.toLocaleString() }}</b> requests
            </div>
            <div>
              <b>{{ (stats.totalHits ?? 0).toLocaleString() }}</b> hits
            </div>
          </div>
        </div>
      </div>
    </template>
  </Card>
</template>
