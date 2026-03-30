import { defineStore } from "pinia";
import { ref, watch } from "vue";
import {
  fetchCollections,
  fetchCollectionInfo,
  fetchAliases,
  fetchIndexStatus,
  triggerReindex,
  clearCollectionApi,
  deleteCollectionApi,
  createSnapshotApi,
  listSnapshotsApi,
  fetchCollectionAnalytics,
  fetchClusterHealth,
} from "@/api/collections";
import type {
  CollectionSummary,
  CollectionInfo,
  AliasInfo,
  IndexStatus,
  Snapshot,
  CollectionAnalytics,
  ClusterHealth,
} from "@/types/collections";

export const useCollectionsStore = defineStore("collections", () => {
  const collections = ref<CollectionSummary[]>([]);
  const selectedCollection = ref<CollectionInfo | null>(null);
  const aliases = ref<AliasInfo[]>([]);
  const loading = ref(false);
  const error = ref("");
  const indexStatus = ref<IndexStatus | null>(null);
  const analytics = ref<CollectionAnalytics | null>(null);
  const snapshots = ref<Snapshot[]>([]);
  const clusterHealth = ref<ClusterHealth | null>(null);

  // Poll indexing status when a collection is selected
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  watch(selectedCollection, (col) => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    indexStatus.value = null;
    analytics.value = null;
    snapshots.value = [];
    if (col) {
      loadCollectionExtras(col.name);
    }
  });

  async function loadCollectionExtras(name: string) {
    const [idx, anal, snaps] = await Promise.allSettled([
      fetchIndexStatus(name),
      fetchCollectionAnalytics(name),
      listSnapshotsApi(name),
    ]);
    if (idx.status === "fulfilled") {
      indexStatus.value = idx.value;
      if (idx.value.status === "indexing") startPolling(name);
    }
    if (anal.status === "fulfilled") analytics.value = anal.value;
    if (snaps.status === "fulfilled") snapshots.value = snaps.value;
  }

  function startPolling(name: string) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const status = await fetchIndexStatus(name);
        indexStatus.value = status;
        if (status.status !== "indexing") {
          clearInterval(pollTimer!);
          pollTimer = null;
        }
      } catch {
        /* ignore */
      }
    }, 3000);
  }

  async function loadCollections(project?: string) {
    loading.value = true;
    error.value = "";
    try {
      const [cols, als, health] = await Promise.all([
        fetchCollections(project),
        fetchAliases(),
        fetchClusterHealth().catch(() => null),
      ]);
      collections.value = cols;
      aliases.value = als;
      if (health) clusterHealth.value = health;
    } catch (e: any) {
      error.value = e.message || "Failed to load collections";
    } finally {
      loading.value = false;
    }
  }

  async function selectCollection(name: string) {
    selectedCollection.value = await fetchCollectionInfo(name);
  }

  function clearSelection() {
    selectedCollection.value = null;
  }

  async function reindexCollection() {
    if (!selectedCollection.value) return;
    await triggerReindex(selectedCollection.value.name);
    startPolling(selectedCollection.value.name);
  }

  async function clearCollection() {
    if (!selectedCollection.value) return;
    await clearCollectionApi(selectedCollection.value.name);
    selectedCollection.value = await fetchCollectionInfo(
      selectedCollection.value.name,
    );
  }

  async function deleteCollection() {
    if (!selectedCollection.value) return;
    await deleteCollectionApi(selectedCollection.value.name);
    selectedCollection.value = null;
  }

  async function createSnapshot() {
    if (!selectedCollection.value) return;
    await createSnapshotApi(selectedCollection.value.name);
    snapshots.value = await listSnapshotsApi(selectedCollection.value.name);
  }

  return {
    collections,
    selectedCollection,
    aliases,
    loading,
    error,
    indexStatus,
    analytics,
    snapshots,
    clusterHealth,
    loadCollections,
    selectCollection,
    clearSelection,
    reindexCollection,
    clearCollection,
    deleteCollection,
    createSnapshot,
  };
});
