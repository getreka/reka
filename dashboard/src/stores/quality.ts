import { defineStore } from "pinia";
import { ref } from "vue";
import { fetchDuplicates, fetchClusters } from "@/api/quality";
import type { DuplicateGroup, CodeCluster } from "@/types/quality";

export const useQualityStore = defineStore("quality", () => {
  const duplicates = ref<DuplicateGroup[]>([]);
  const clusters = ref<CodeCluster[]>([]);
  const loading = ref(false);
  const error = ref("");
  const threshold = ref(0.9);
  const selectedGroup = ref<DuplicateGroup | null>(null);
  const activeTab = ref(0);

  async function loadDuplicates() {
    loading.value = true;
    error.value = "";
    try {
      duplicates.value = await fetchDuplicates(threshold.value);
    } catch (e: any) {
      error.value = e.message || "Failed to load duplicates";
    } finally {
      loading.value = false;
    }
  }

  async function loadClusters() {
    loading.value = true;
    error.value = "";
    try {
      clusters.value = await fetchClusters();
    } catch (e: any) {
      error.value = e.message || "Failed to load clusters";
    } finally {
      loading.value = false;
    }
  }

  return {
    duplicates,
    clusters,
    loading,
    error,
    threshold,
    selectedGroup,
    activeTab,
    loadDuplicates,
    loadClusters,
  };
});
