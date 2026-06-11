<script setup lang="ts">
import { onMounted } from "vue";
import Card from "primevue/card";
import Button from "primevue/button";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import HealthGauges from "@/components/overview/HealthGauges.vue";
import ToolUsageChart from "@/components/overview/ToolUsageChart.vue";
import TopToolsChart from "@/components/overview/TopToolsChart.vue";
import RecentSessionsList from "@/components/overview/RecentSessionsList.vue";
import KnowledgeGapsAlert from "@/components/overview/KnowledgeGapsAlert.vue";
import PlatformStatsCard from "@/components/overview/PlatformStatsCard.vue";
import DeveloperProfileCard from "@/components/overview/DeveloperProfileCard.vue";
import CacheStatsCard from "@/components/overview/CacheStatsCard.vue";
import { useOverviewStore } from "@/stores/overview";
import { useProjectWatch } from "@/composables/useProjectWatch";

const store = useOverviewStore();

useProjectWatch(() => store.loadAll());
onMounted(() => store.loadAll());
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div style="display: flex; justify-content: flex-end">
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        text
        @click="store.loadAll()"
      />
    </div>

    <Message v-if="store.error" severity="error" :closable="false">{{
      store.error
    }}</Message>

    <div
      v-if="store.loading"
      style="display: flex; justify-content: center; padding: 3rem"
    >
      <ProgressSpinner />
    </div>
    <div
      v-else
      style="display: grid; grid-template-columns: repeat(12, 1fr); gap: 1rem"
    >
      <!-- Health Gauges - full width -->
      <div style="grid-column: span 12">
        <HealthGauges :stats="store.toolStats" />
      </div>

      <!-- Platform Stats -->
      <div style="grid-column: span 6">
        <PlatformStatsCard :stats="store.platformStats" />
      </div>

      <!-- Developer Profile -->
      <div style="grid-column: span 6">
        <DeveloperProfileCard :profile="store.developerProfile" />
      </div>

      <!-- Tool Usage Chart -->
      <Card style="grid-column: span 8">
        <template #title>Tool Usage by Hour</template>
        <template #content>
          <ToolUsageChart :calls-by-hour="store.toolStats?.callsByHour" />
        </template>
      </Card>

      <!-- Top Tools -->
      <Card style="grid-column: span 4">
        <template #title>Top Tools</template>
        <template #content>
          <TopToolsChart :top-tools="store.toolStats?.topTools" />
        </template>
      </Card>

      <!-- Knowledge Gaps -->
      <Card style="grid-column: span 6">
        <template #title>Knowledge Gaps</template>
        <template #content>
          <KnowledgeGapsAlert :gaps="store.knowledgeGaps" />
        </template>
      </Card>

      <!-- Cache Stats -->
      <div style="grid-column: span 6">
        <CacheStatsCard :stats="store.cacheStats" />
      </div>

      <!-- Recent Sessions -->
      <Card style="grid-column: span 12">
        <template #title>Recent Sessions</template>
        <template #content>
          <RecentSessionsList :sessions="store.recentSessions" />
        </template>
      </Card>
    </div>
  </div>
</template>
