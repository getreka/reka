<script setup lang="ts">
import { onMounted, computed, ref } from "vue";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import Button from "primevue/button";
import Message from "primevue/message";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import Select from "primevue/select";
import Paginator from "primevue/paginator";
import Tag from "primevue/tag";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import MemoryStatsVue from "@/components/memory/MemoryStats.vue";
import MemoryFilters from "@/components/memory/MemoryFilters.vue";
import MemoryCardGrid from "@/components/memory/MemoryCardGrid.vue";
import QuarantineQueue from "@/components/memory/QuarantineQueue.vue";
import UnvalidatedList from "@/components/memory/UnvalidatedList.vue";
import { useMemoryStore } from "@/stores/memory";
import { useToast } from "@/composables/useToast";
import { useProjectWatch } from "@/composables/useProjectWatch";
import type { MemoryType } from "@/types/memory";

const store = useMemoryStore();
const toast = useToast();
const activeTab = ref("memories");

const quarantineLabel = computed(
  () => `Quarantine (${store.quarantine.length})`,
);
const unvalidatedLabel = computed(
  () => `Unvalidated (${store.unvalidated.length})`,
);

// Create memory dialog
const showCreateDialog = ref(false);
const newMemory = ref({
  type: "note" as MemoryType,
  content: "",
  relatedTo: "",
  tags: "",
});

const typeOptions = [
  { label: "Note", value: "note" },
  { label: "Decision", value: "decision" },
  { label: "Insight", value: "insight" },
  { label: "Context", value: "context" },
  { label: "Todo", value: "todo" },
  { label: "Conversation", value: "conversation" },
];

// Merge preview dialog
const showMergeDialog = ref(false);

function reload() {
  Promise.all([
    store.loadMemories(),
    store.loadStats(),
    store.loadQuarantine(),
    store.loadUnvalidated(),
    store.loadLTM(),
  ]);
}

useProjectWatch(reload);
onMounted(reload);

async function handleDelete(id: string) {
  try {
    await store.removeMemory(id);
    toast.success("Memory deleted");
  } catch {
    toast.error("Failed to delete memory");
  }
}

async function handleValidate(id: string, validated: boolean) {
  try {
    await store.validate(id, validated);
    toast.success(validated ? "Memory validated" : "Memory rejected");
  } catch {
    toast.error("Validation failed");
  }
}

async function handlePromote(id: string, reason: string) {
  try {
    await store.promote(id, reason);
    toast.success("Memory promoted to durable storage");
  } catch {
    toast.error("Promotion failed");
  }
}

async function handleCreate() {
  try {
    const tags = newMemory.value.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await store.createMemory({
      type: newMemory.value.type,
      content: newMemory.value.content,
      relatedTo: newMemory.value.relatedTo || undefined,
      tags,
    });
    toast.success("Memory created");
    showCreateDialog.value = false;
    newMemory.value = { type: "note", content: "", relatedTo: "", tags: "" };
  } catch {
    toast.error("Failed to create memory");
  }
}

async function handleMergePreview() {
  await store.loadMergePreview();
  showMergeDialog.value = true;
}

async function handleMergeExecute() {
  try {
    await store.executeMerge();
    toast.success("Memories merged");
    showMergeDialog.value = false;
    store.loadMemories();
  } catch {
    toast.error("Merge failed");
  }
}

async function handleBulkDelete(type: MemoryType) {
  try {
    await store.bulkDeleteByType(type);
    toast.success(`All ${type} memories deleted`);
    reload();
  } catch {
    toast.error("Bulk delete failed");
  }
}

async function handleBatchPromote(ids: string[], reason: string) {
  let ok = 0,
    fail = 0;
  for (const id of ids) {
    try {
      await store.promote(id, reason);
      ok++;
    } catch {
      fail++;
    }
  }
  toast.success(`Promoted ${ok}${fail ? `, ${fail} failed` : ""}`);
  reload();
}

async function handleBatchReject(ids: string[]) {
  let ok = 0,
    fail = 0;
  for (const id of ids) {
    try {
      await store.validate(id, false);
      ok++;
    } catch {
      fail++;
    }
  }
  toast.success(`Rejected ${ok}${fail ? `, ${fail} failed` : ""}`);
  reload();
}

function truncate(text: string, len = 120) {
  if (!text) return "";
  return text.length > len ? text.slice(0, len) + "…" : text;
}

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div
      style="display: flex; justify-content: space-between; align-items: center"
    >
      <div style="display: flex; gap: 0.5rem">
        <Button
          label="New Memory"
          icon="pi pi-plus"
          size="small"
          @click="showCreateDialog = true"
        />
        <Button
          label="Merge Preview"
          icon="pi pi-objects-column"
          size="small"
          severity="secondary"
          outlined
          @click="handleMergePreview"
        />
      </div>
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

    <!-- LTM summary row -->
    <div
      style="display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center"
    >
      <div
        style="
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.75rem;
          background: var(--p-surface-50);
          border-radius: 6px;
          font-size: 0.8rem;
        "
      >
        <span style="color: var(--p-text-muted-color)">Durable</span>
        <Tag
          :value="String(store.stats?.total ?? 0)"
          severity="secondary"
          style="font-size: 0.75rem"
        />
      </div>
      <div
        style="
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.75rem;
          background: var(--p-surface-50);
          border-radius: 6px;
          font-size: 0.8rem;
        "
      >
        <span style="color: var(--p-text-muted-color)">Episodic</span>
        <Tag
          :value="
            String(
              store.ltmStats?.episodic?.count ?? store.episodicMemories.length,
            )
          "
          severity="info"
          style="font-size: 0.75rem"
        />
      </div>
      <div
        style="
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.75rem;
          background: var(--p-surface-50);
          border-radius: 6px;
          font-size: 0.8rem;
        "
      >
        <span style="color: var(--p-text-muted-color)">Semantic</span>
        <Tag
          :value="
            String(
              store.ltmStats?.semantic?.count ?? store.semanticMemories.length,
            )
          "
          severity="success"
          style="font-size: 0.75rem"
        />
      </div>
      <div
        style="
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.75rem;
          background: var(--p-surface-50);
          border-radius: 6px;
          font-size: 0.8rem;
        "
      >
        <span style="color: var(--p-text-muted-color)">Stale</span>
        <Tag
          :value="String(store.staleMemories.length)"
          :severity="store.staleMemories.length > 0 ? 'warn' : 'secondary'"
          style="font-size: 0.75rem"
        />
      </div>
    </div>

    <MemoryStatsVue :stats="store.stats" @bulk-delete="handleBulkDelete" />

    <Tabs v-model:value="activeTab">
      <TabList>
        <Tab value="memories">All Memories</Tab>
        <Tab value="quarantine">{{ quarantineLabel }}</Tab>
        <Tab value="unvalidated">{{ unvalidatedLabel }}</Tab>
        <Tab value="episodic">Episodic LTM</Tab>
        <Tab value="semantic">Semantic LTM</Tab>
        <Tab value="stale">
          Stale
          <Tag
            v-if="store.staleMemories.length > 0"
            :value="String(store.staleMemories.length)"
            severity="warn"
            style="margin-left: 0.35rem; font-size: 0.7rem"
          />
        </Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="memories">
          <div
            style="
              display: flex;
              flex-direction: column;
              gap: 1rem;
              padding-top: 0.5rem;
            "
          >
            <MemoryFilters />
            <MemoryCardGrid
              :memories="store.memories"
              :loading="store.loading"
              @delete="handleDelete"
            />
            <Paginator
              v-if="store.total > store.pageSize"
              :rows="store.pageSize"
              :totalRecords="store.total"
              :first="store.page * store.pageSize"
              @page="
                (e: any) => {
                  store.page = e.page;
                  store.loadMemories();
                }
              "
            />
          </div>
        </TabPanel>
        <TabPanel value="quarantine">
          <QuarantineQueue
            :memories="store.quarantine"
            @validate="handleValidate"
            @promote="handlePromote"
            @batch-promote="handleBatchPromote"
            @batch-reject="handleBatchReject"
          />
        </TabPanel>
        <TabPanel value="unvalidated">
          <UnvalidatedList
            :memories="store.unvalidated"
            @validate="handleValidate"
          />
        </TabPanel>

        <!-- Episodic LTM tab -->
        <TabPanel value="episodic">
          <div style="padding-top: 0.5rem">
            <DataTable
              :value="store.episodicMemories"
              :loading="store.ltmLoading"
              stripedRows
              size="small"
              style="font-size: 0.85rem"
              emptyMessage="No episodic memories found."
            >
              <Column field="content" header="Content" style="min-width: 300px">
                <template #body="{ data }">
                  <span :title="data.content">{{
                    truncate(data.content)
                  }}</span>
                </template>
              </Column>
              <Column field="type" header="Type" style="width: 110px">
                <template #body="{ data }">
                  <Tag :value="data.type" severity="secondary" />
                </template>
              </Column>
              <Column field="tags" header="Tags" style="width: 160px">
                <template #body="{ data }">
                  <span
                    v-for="tag in (data.tags ?? []).slice(0, 3)"
                    :key="tag"
                    style="
                      display: inline-block;
                      margin: 0 2px 2px 0;
                      padding: 1px 6px;
                      background: var(--p-surface-100);
                      border-radius: 4px;
                      font-size: 0.75rem;
                    "
                    >{{ tag }}</span
                  >
                </template>
              </Column>
              <Column field="score" header="Score" style="width: 80px">
                <template #body="{ data }">
                  {{ data.score != null ? data.score.toFixed(2) : "—" }}
                </template>
              </Column>
              <Column field="createdAt" header="Created" style="width: 110px">
                <template #body="{ data }">{{
                  formatDate(data.createdAt)
                }}</template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>

        <!-- Semantic LTM tab -->
        <TabPanel value="semantic">
          <div style="padding-top: 0.5rem">
            <DataTable
              :value="store.semanticMemories"
              :loading="store.ltmLoading"
              stripedRows
              size="small"
              style="font-size: 0.85rem"
              emptyMessage="No semantic memories found."
            >
              <Column field="content" header="Content" style="min-width: 300px">
                <template #body="{ data }">
                  <span :title="data.content">{{
                    truncate(data.content)
                  }}</span>
                </template>
              </Column>
              <Column field="type" header="Type" style="width: 110px">
                <template #body="{ data }">
                  <Tag :value="data.type" severity="success" />
                </template>
              </Column>
              <Column field="tags" header="Tags" style="width: 160px">
                <template #body="{ data }">
                  <span
                    v-for="tag in (data.tags ?? []).slice(0, 3)"
                    :key="tag"
                    style="
                      display: inline-block;
                      margin: 0 2px 2px 0;
                      padding: 1px 6px;
                      background: var(--p-surface-100);
                      border-radius: 4px;
                      font-size: 0.75rem;
                    "
                    >{{ tag }}</span
                  >
                </template>
              </Column>
              <Column field="score" header="Score" style="width: 80px">
                <template #body="{ data }">
                  {{ data.score != null ? data.score.toFixed(2) : "—" }}
                </template>
              </Column>
              <Column field="createdAt" header="Created" style="width: 110px">
                <template #body="{ data }">{{
                  formatDate(data.createdAt)
                }}</template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>

        <!-- Stale memories tab -->
        <TabPanel value="stale">
          <div style="padding-top: 0.5rem">
            <DataTable
              :value="store.staleMemories"
              :loading="store.ltmLoading"
              stripedRows
              size="small"
              style="font-size: 0.85rem"
              emptyMessage="No stale memories flagged."
            >
              <Column field="content" header="Content" style="min-width: 260px">
                <template #body="{ data }">
                  <span :title="data.content">{{
                    truncate(data.content)
                  }}</span>
                </template>
              </Column>
              <Column field="reason" header="Reason" style="min-width: 180px">
                <template #body="{ data }">
                  <span style="color: var(--p-red-500); font-size: 0.82rem">
                    {{ data.reason }}
                  </span>
                </template>
              </Column>
              <Column field="score" header="Score" style="width: 80px">
                <template #body="{ data }">
                  {{ data.score != null ? data.score.toFixed(2) : "—" }}
                </template>
              </Column>
              <Column
                field="lastAccessed"
                header="Last Accessed"
                style="width: 130px"
              >
                <template #body="{ data }">{{
                  formatDate(data.lastAccessed)
                }}</template>
              </Column>
              <Column field="createdAt" header="Created" style="width: 110px">
                <template #body="{ data }">{{
                  formatDate(data.createdAt)
                }}</template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <!-- Create Memory Dialog -->
    <Dialog
      v-model:visible="showCreateDialog"
      header="New Memory"
      modal
      style="width: 30rem"
    >
      <div style="display: flex; flex-direction: column; gap: 1rem">
        <div>
          <label style="font-size: 0.875rem; font-weight: 600">Type</label>
          <Select
            v-model="newMemory.type"
            :options="typeOptions"
            optionLabel="label"
            optionValue="value"
            style="width: 100%; margin-top: 0.25rem"
          />
        </div>
        <div>
          <label style="font-size: 0.875rem; font-weight: 600">Content</label>
          <Textarea
            v-model="newMemory.content"
            rows="5"
            style="width: 100%; margin-top: 0.25rem"
          />
        </div>
        <div>
          <label style="font-size: 0.875rem; font-weight: 600"
            >Related To</label
          >
          <InputText
            v-model="newMemory.relatedTo"
            placeholder="feature or topic"
            style="width: 100%; margin-top: 0.25rem"
          />
        </div>
        <div>
          <label style="font-size: 0.875rem; font-weight: 600"
            >Tags (comma-separated)</label
          >
          <InputText
            v-model="newMemory.tags"
            placeholder="tag1, tag2"
            style="width: 100%; margin-top: 0.25rem"
          />
        </div>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          severity="secondary"
          text
          @click="showCreateDialog = false"
        />
        <Button
          label="Create"
          icon="pi pi-check"
          :disabled="!newMemory.content"
          @click="handleCreate"
        />
      </template>
    </Dialog>

    <!-- Merge Preview Dialog -->
    <Dialog
      v-model:visible="showMergeDialog"
      header="Merge Preview"
      modal
      style="width: 40rem"
    >
      <div
        v-if="store.mergePreview.length === 0"
        style="padding: 1rem; color: var(--p-text-muted-color)"
      >
        No merge candidates found.
      </div>
      <div
        v-else
        style="
          display: flex;
          flex-direction: column;
          gap: 1rem;
          max-height: 400px;
          overflow-y: auto;
        "
      >
        <div
          v-for="(cluster, i) in store.mergePreview"
          :key="i"
          style="
            padding: 0.75rem;
            background: var(--p-surface-50);
            border-radius: 6px;
          "
        >
          <div style="font-weight: 600; margin-bottom: 0.5rem">
            Cluster {{ i + 1 }} ({{ cluster.count }} memories)
          </div>
          <div
            v-for="item in cluster.items"
            :key="item.id"
            style="
              font-size: 0.8rem;
              padding: 0.25rem 0;
              border-bottom: 1px solid var(--p-surface-200);
            "
          >
            {{ item.content?.slice(0, 100) }}...
          </div>
        </div>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          severity="secondary"
          text
          @click="showMergeDialog = false"
        />
        <Button
          label="Merge Now"
          icon="pi pi-check"
          severity="warn"
          :disabled="store.mergePreview.length === 0"
          @click="handleMergeExecute"
        />
      </template>
    </Dialog>
  </div>
</template>
