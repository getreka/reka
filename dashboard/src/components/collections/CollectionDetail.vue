<script setup lang="ts">
import { computed } from "vue";
import Card from "primevue/card";
import Button from "primevue/button";
import Chip from "primevue/chip";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import TabPanels from "primevue/tabpanels";
import TabPanel from "primevue/tabpanel";
import IndexingProgress from "./IndexingProgress.vue";
import CollectionAnalytics from "./CollectionAnalytics.vue";
import type {
  CollectionInfo,
  IndexStatus,
  VectorParams,
  Snapshot,
  CollectionAnalytics as AnalyticsType,
} from "@/types/collections";

const props = defineProps<{
  info: CollectionInfo;
  indexStatus?: IndexStatus | null;
  analytics?: AnalyticsType | null;
  snapshots?: Snapshot[];
}>();
const emit = defineEmits<{
  close: [];
  reindex: [];
  clear: [];
  delete: [];
  snapshot: [];
}>();

const isNamedVectors = computed(() => {
  const v = props.info.config?.params?.vectors;
  if (!v) return false;
  return !("size" in v || "distance" in v);
});

const namedVectors = computed(() => {
  if (!isNamedVectors.value) return [];
  const v = props.info.config?.params?.vectors as Record<string, VectorParams>;
  return Object.entries(v).map(([name, cfg]) => ({ name, ...cfg }));
});

const singleVector = computed(() => {
  if (isNamedVectors.value) return null;
  return props.info.config?.params?.vectors as VectorParams | undefined;
});
</script>

<template>
  <Card>
    <template #title>
      <div
        style="
          display: flex;
          justify-content: space-between;
          align-items: center;
        "
      >
        <span>{{ info.name }}</span>
        <Button icon="pi pi-times" text size="small" @click="emit('close')" />
      </div>
    </template>
    <template #content>
      <IndexingProgress
        v-if="indexStatus"
        :status="indexStatus"
        style="margin-bottom: 0.75rem"
      />

      <Tabs value="info">
        <TabList>
          <Tab value="info">Info</Tab>
          <Tab value="analytics">Analytics</Tab>
          <Tab value="snapshots">Snapshots</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="info">
            <div
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                font-size: 0.875rem;
                padding-top: 0.5rem;
              "
            >
              <div>
                <b>Vectors:</b> {{ info.vectorsCount?.toLocaleString() }}
              </div>
              <div>
                <b>Points:</b> {{ info.pointsCount?.toLocaleString() ?? "—" }}
              </div>
              <div><b>Status:</b> {{ info.status }}</div>
              <div><b>Segments:</b> {{ info.segments ?? "—" }}</div>

              <!-- Single vector config -->
              <div v-if="singleVector">
                <b>Vector Config:</b>
                <div style="padding-left: 0.75rem; margin-top: 0.25rem">
                  Size: {{ singleVector.size }}<br />
                  Distance: {{ singleVector.distance }}
                </div>
              </div>

              <!-- Named vectors config -->
              <div v-if="isNamedVectors">
                <b>Named Vectors:</b>
                <div
                  v-for="nv in namedVectors"
                  :key="nv.name"
                  style="padding-left: 0.75rem; margin-top: 0.25rem"
                >
                  <b>{{ nv.name }}:</b> size={{ nv.size }}, distance={{
                    nv.distance
                  }}
                </div>
              </div>

              <div><b>Optimizer:</b> {{ info.optimizerStatus ?? "ok" }}</div>
              <div v-if="info.indexedFields?.length">
                <b>Indexed Fields:</b>
                <div
                  style="
                    display: flex;
                    gap: 0.25rem;
                    flex-wrap: wrap;
                    margin-top: 0.25rem;
                  "
                >
                  <Chip
                    v-for="field in info.indexedFields"
                    :key="field"
                    :label="field"
                    style="font-size: 0.75rem"
                  />
                </div>
              </div>

              <!-- Action buttons -->
              <div
                style="
                  display: flex;
                  gap: 0.5rem;
                  flex-wrap: wrap;
                  margin-top: 0.5rem;
                "
              >
                <Button
                  label="Reindex"
                  icon="pi pi-refresh"
                  size="small"
                  severity="info"
                  outlined
                  @click="emit('reindex')"
                />
                <Button
                  label="Snapshot"
                  icon="pi pi-camera"
                  size="small"
                  severity="secondary"
                  outlined
                  @click="emit('snapshot')"
                />
                <Button
                  label="Clear"
                  icon="pi pi-eraser"
                  size="small"
                  severity="warn"
                  outlined
                  @click="emit('clear')"
                />
                <Button
                  label="Delete"
                  icon="pi pi-trash"
                  size="small"
                  severity="danger"
                  outlined
                  @click="emit('delete')"
                />
              </div>
            </div>
          </TabPanel>

          <TabPanel value="analytics">
            <CollectionAnalytics :analytics="analytics" />
          </TabPanel>

          <TabPanel value="snapshots">
            <div
              v-if="!snapshots?.length"
              style="
                padding: 1rem;
                color: var(--p-text-muted-color);
                font-size: 0.875rem;
              "
            >
              No snapshots yet.
            </div>
            <div
              v-else
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                padding-top: 0.5rem;
              "
            >
              <div
                v-for="snap in snapshots"
                :key="snap.name"
                style="
                  display: flex;
                  justify-content: space-between;
                  font-size: 0.875rem;
                  padding: 0.5rem;
                  background: var(--p-surface-50);
                  border-radius: 6px;
                "
              >
                <span>{{ snap.name }}</span>
                <span style="color: var(--p-text-muted-color)"
                  >{{ (snap.size / 1024 / 1024).toFixed(1) }} MB</span
                >
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </template>
  </Card>
</template>
