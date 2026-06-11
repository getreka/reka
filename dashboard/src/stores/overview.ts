import { defineStore } from "pinia";
import { ref } from "vue";
import {
  fetchToolAnalytics,
  fetchKnowledgeGaps,
  fetchSessions,
  fetchPlatformStats,
  fetchDeveloperProfile,
  fetchCacheAnalytics,
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
  const recentSessions = ref<Session[]>([]);
  const platformStats = ref<PlatformStats | null>(null);
  const developerProfile = ref<DeveloperProfile | null>(null);
  const cacheStats = ref<CacheStats | null>(null);
  const loading = ref(false);
  const error = ref("");

  async function loadAll() {
    loading.value = true;
    error.value = "";

    const results = await Promise.allSettled([
      fetchToolAnalytics(7),
      fetchKnowledgeGaps(20),
      fetchSessions(5),
      fetchPlatformStats(),
      fetchDeveloperProfile(),
      fetchCacheAnalytics(),
    ]);

    if (results[0].status === "fulfilled") toolStats.value = results[0].value;
    if (results[1].status === "fulfilled")
      knowledgeGaps.value = results[1].value;
    if (results[2].status === "fulfilled")
      recentSessions.value = results[2].value;
    if (results[3].status === "fulfilled")
      platformStats.value = results[3].value;
    if (results[4].status === "fulfilled")
      developerProfile.value = results[4].value;
    if (results[5].status === "fulfilled") cacheStats.value = results[5].value;

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === results.length) {
      error.value = "Failed to load overview data";
    }

    loading.value = false;
  }

  return {
    toolStats,
    knowledgeGaps,
    recentSessions,
    platformStats,
    developerProfile,
    cacheStats,
    loading,
    error,
    loadAll,
  };
});
