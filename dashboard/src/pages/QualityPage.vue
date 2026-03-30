<script setup lang="ts">
import { onMounted, ref } from "vue";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import Message from "primevue/message";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import Button from "primevue/button";
import DuplicatesTable from "@/components/quality/DuplicatesTable.vue";
import DuplicateDiff from "@/components/quality/DuplicateDiff.vue";
import ExportButton from "@/components/common/ExportButton.vue";
import { useQualityStore } from "@/stores/quality";
import { useProjectWatch } from "@/composables/useProjectWatch";

const store = useQualityStore();
const pageRef = ref<HTMLElement>();

onMounted(() => {
  if (store.duplicates.length === 0) store.loadDuplicates();
});

useProjectWatch(() => {
  store.duplicates = [];
  store.clusters = [];
  store.selectedGroup = null;
  store.loadDuplicates();
});
</script>

<template>
  <div ref="pageRef" style="display: flex; flex-direction: column; gap: 1rem">
    <div style="display: flex; justify-content: flex-end">
      <ExportButton
        page="quality"
        :data="store.duplicates"
        :elementRef="pageRef"
      />
    </div>

    <Message v-if="store.error" severity="error" :closable="false">{{
      store.error
    }}</Message>

    <Tabs
      :value="store.activeTab"
      @update:value="(v: any) => (store.activeTab = v)"
    >
      <TabList>
        <Tab :value="0">
          Duplicates
          <Tag
            v-if="store.duplicates.length > 0"
            :value="String(store.duplicates.length)"
            severity="info"
            style="margin-left: 0.5rem"
          />
        </Tab>
        <Tab :value="1">Clusters</Tab>
      </TabList>
      <TabPanels>
        <TabPanel :value="0">
          <div
            style="
              display: flex;
              flex-direction: column;
              gap: 1rem;
              padding-top: 0.5rem;
            "
          >
            <DuplicatesTable />
            <DuplicateDiff
              v-if="store.selectedGroup"
              :group="store.selectedGroup"
              @close="store.selectedGroup = null"
            />
          </div>
        </TabPanel>
        <TabPanel :value="1">
          <div style="padding-top: 0.5rem">
            <Button
              v-if="store.clusters.length === 0"
              label="Load Clusters"
              icon="pi pi-sitemap"
              @click="store.loadClusters()"
              :loading="store.loading"
              style="margin-bottom: 1rem"
            />
            <DataTable
              v-if="store.clusters.length > 0"
              :value="store.clusters"
              :loading="store.loading"
              :rows="20"
              :paginator="store.clusters.length > 20"
              stripedRows
              size="small"
            >
              <Column header="Cluster" field="label" sortable />
              <Column header="Files" sortable sortField="files">
                <template #body="{ data }">
                  <div style="display: flex; flex-wrap: wrap; gap: 0.25rem">
                    <Tag
                      v-for="f in data.files.slice(0, 5)"
                      :key="f"
                      :value="f.split('/').pop() || f"
                      v-tooltip="f"
                      severity="secondary"
                      style="font-size: 0.7rem"
                    />
                    <Tag
                      v-if="data.files.length > 5"
                      :value="`+${data.files.length - 5}`"
                      severity="info"
                      style="font-size: 0.7rem"
                    />
                  </div>
                </template>
              </Column>
              <Column
                header="Similarity"
                field="similarity"
                sortable
                style="width: 8rem"
              >
                <template #body="{ data }">
                  {{ (data.similarity * 100).toFixed(1) }}%
                </template>
              </Column>
            </DataTable>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>
