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
import QualityMetricsCard from "@/components/overview/QualityMetricsCard.vue";
import PredictionStatsCard from "@/components/overview/PredictionStatsCard.vue";
import PlatformStatsCard from "@/components/overview/PlatformStatsCard.vue";
import DeveloperProfileCard from "@/components/overview/DeveloperProfileCard.vue";
import CacheStatsCard from "@/components/overview/CacheStatsCard.vue";
import FeedbackTrendsCard from "@/components/overview/FeedbackTrendsCard.vue";
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

      <!-- Prediction Stats -->
      <div style="grid-column: span 6">
        <PredictionStatsCard :stats="store.predictionStats" />
      </div>

      <!-- Tool Usage Chart -->
      <Card style="grid-column: span 8">
        <template #title>Tool Usage by Hour</template>
        <template #content>
          <ToolUsageChart :calls-by-hour="store.toolStats?.callsByHour" />
        </template>
      </Card>

      <!-- Quality Metrics -->
      <div style="grid-column: span 4">
        <QualityMetricsCard :metrics="store.qualityMetrics" />
      </div>

      <!-- Developer Profile -->
      <div style="grid-column: span 4">
        <DeveloperProfileCard :profile="store.developerProfile" />
      </div>

      <!-- Top Tools -->
      <Card style="grid-column: span 4">
        <template #title>Top Tools</template>
        <template #content>
          <TopToolsChart :top-tools="store.toolStats?.topTools" />
        </template>
      </Card>

      <!-- Cache Stats -->
      <div style="grid-column: span 4">
        <CacheStatsCard :stats="store.cacheStats" />
      </div>

      <!-- Knowledge Gaps -->
      <Card style="grid-column: span 6">
        <template #title>Knowledge Gaps</template>
        <template #content>
          <KnowledgeGapsAlert :gaps="store.knowledgeGaps" />
        </template>
      </Card>

      <!-- Feedback Trends -->
      <div style="grid-column: span 6">
        <FeedbackTrendsCard :stats="store.feedbackStats" />
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
