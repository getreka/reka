<script setup lang="ts">
import { onMounted, ref } from "vue";
import ProgressSpinner from "primevue/progressspinner";
import Button from "primevue/button";
import Message from "primevue/message";
import CollectionsTable from "@/components/collections/CollectionsTable.vue";
import CollectionDetail from "@/components/collections/CollectionDetail.vue";
import ClusterHealthCard from "@/components/collections/ClusterHealthCard.vue";
import { useCollectionsStore } from "@/stores/collections";
import { useAppStore } from "@/stores/app";
import { useProjectWatch } from "@/composables/useProjectWatch";
import { useToast } from "@/composables/useToast";
import { useConfirm } from "primevue/useconfirm";

const store = useCollectionsStore();
const app = useAppStore();
const toast = useToast();
const confirm = useConfirm();

function reload() {
  store.loadCollections(app.currentProject || undefined);
}

useProjectWatch(reload);
onMounted(reload);

function handleSelect(name: string) {
  store.selectCollection(name);
}

function handleReindex() {
  confirm.require({
    message: `Reindex collection "${store.selectedCollection?.name}"?`,
    header: "Confirm Reindex",
    acceptLabel: "Reindex",
    rejectLabel: "Cancel",
    accept: async () => {
      try {
        await store.reindexCollection();
        toast.success("Reindex started");
      } catch {
        toast.error("Reindex failed");
      }
    },
  });
}

function handleClear() {
  confirm.require({
    message: `Clear all vectors from "${store.selectedCollection?.name}"? This cannot be undone.`,
    header: "Confirm Clear",
    acceptLabel: "Clear",
    rejectLabel: "Cancel",
    accept: async () => {
      try {
        await store.clearCollection();
        toast.success("Collection cleared");
      } catch {
        toast.error("Clear failed");
      }
    },
  });
}

function handleDelete() {
  confirm.require({
    message: `Delete collection "${store.selectedCollection?.name}"? This cannot be undone.`,
    header: "Confirm Delete",
    acceptLabel: "Delete",
    rejectLabel: "Cancel",
    accept: async () => {
      try {
        await store.deleteCollection();
        toast.success("Collection deleted");
        reload();
      } catch {
        toast.error("Delete failed");
      }
    },
  });
}

async function handleSnapshot() {
  try {
    await store.createSnapshot();
    toast.success("Snapshot created");
  } catch {
    toast.error("Snapshot failed");
  }
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div style="display: flex; justify-content: flex-end">
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        text
        @click="reload"
      />
    </div>

    <Message v-if="store.error" severity="error" :closable="false">{{
      store.error
    }}</Message>

    <ClusterHealthCard :health="store.clusterHealth" />

    <div
      v-if="store.loading"
      style="display: flex; justify-content: center; padding: 3rem"
    >
      <ProgressSpinner />
    </div>
    <div v-else style="display: flex; gap: 1rem">
      <div style="flex: 1; min-width: 0">
        <CollectionsTable
          :collections="store.collections"
          :aliases="store.aliases"
          @select="handleSelect"
        />
      </div>
      <div v-if="store.selectedCollection" style="width: 28rem; flex-shrink: 0">
        <CollectionDetail
          :info="store.selectedCollection"
          :index-status="store.indexStatus"
          :analytics="store.analytics"
          :snapshots="store.snapshots"
          @close="store.clearSelection()"
          @reindex="handleReindex"
          @clear="handleClear"
          @delete="handleDelete"
          @snapshot="handleSnapshot"
        />
      </div>
    </div>
  </div>
</template>
