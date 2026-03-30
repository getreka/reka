import { defineStore } from "pinia";
import { ref } from "vue";
import { useAppStore } from "./app";
import {
  fetchToolAnalytics,
  fetchKnowledgeGaps,
  fetchQualityMetrics,
  fetchSessions,
  fetchPredictionStats,
  fetchPlatformStats,
  fetchDeveloperProfile,
  fetchCacheAnalytics,
  fetchFeedbackStats,
} from "@/api/overview";
import type {
  ToolStats,
  KnowledgeGap,
  Session,
  PlatformStats,
  DeveloperProfile,
  CacheStats,
} from "@/types/api";

export const useOverviewStore = defineStore("overview", () => {
  const toolStats = ref<ToolStats | null>(null);
  const knowledgeGaps = ref<KnowledgeGap[]>([]);
  const qualityMetrics = ref<Record<string, any> | null>(null);
  const recentSessions = ref<Session[]>([]);
  const predictionStats = ref<Record<string, any> | null>(null);
  const platformStats = ref<PlatformStats | null>(null);
  const developerProfile = ref<DeveloperProfile | null>(null);
  const cacheStats = ref<CacheStats | null>(null);
  const feedbackStats = ref<Record<string, any> | null>(null);
  const loading = ref(false);
  const error = ref("");

  async function loadAll() {
    const app = useAppStore();
    loading.value = true;
    error.value = "";

    const results = await Promise.allSettled([
      fetchToolAnalytics(7),
      fetchKnowledgeGaps(20),
      app.currentProject
        ? fetchQualityMetrics(app.currentProject)
        : Promise.resolve(null),
      fetchSessions(5),
      fetchPredictionStats(),
      fetchPlatformStats(),
      fetchDeveloperProfile(),
      fetchCacheAnalytics(),
      app.currentProject
        ? fetchFeedbackStats(app.currentProject)
        : Promise.resolve(null),
    ]);

    if (results[0].status === "fulfilled") toolStats.value = results[0].value;
    if (results[1].status === "fulfilled")
      knowledgeGaps.value = results[1].value;
    if (results[2].status === "fulfilled" && results[2].value)
      qualityMetrics.value = results[2].value;
    if (results[3].status === "fulfilled")
      recentSessions.value = results[3].value;
    if (results[4].status === "fulfilled")
      predictionStats.value = results[4].value;
    if (results[5].status === "fulfilled")
      platformStats.value = results[5].value;
    if (results[6].status === "fulfilled")
      developerProfile.value = results[6].value;
    if (results[7].status === "fulfilled") cacheStats.value = results[7].value;
    if (results[8].status === "fulfilled" && results[8].value)
      feedbackStats.value = results[8].value;

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length) {
      error.value = "Failed to load overview data";
    }

    loading.value = false;
  }

  return {
    toolStats,
    knowledgeGaps,
    qualityMetrics,
    recentSessions,
    predictionStats,
    platformStats,
    developerProfile,
    cacheStats,
    feedbackStats,
    loading,
    error,
    loadAll,
  };
});
