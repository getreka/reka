<script setup lang="ts">
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import Slider from "primevue/slider";
import Button from "primevue/button";
import { useQualityStore } from "@/stores/quality";

const store = useQualityStore();

function selectGroup(group: any) {
  store.selectedGroup = group;
}

function severityForScore(s: number): "danger" | "warn" | "info" {
  if (s >= 0.95) return "danger";
  if (s >= 0.9) return "warn";
  return "info";
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.75rem">
    <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap">
      <div
        style="
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex: 1;
          min-width: 15rem;
        "
      >
        <span
          style="
            font-size: 0.85rem;
            color: var(--p-text-muted-color);
            white-space: nowrap;
          "
          >Threshold: {{ store.threshold.toFixed(2) }}</span
        >
        <Slider
          v-model="store.threshold"
          :min="0.8"
          :max="1.0"
          :step="0.01"
          style="flex: 1"
        />
      </div>
      <Button
        label="Search"
        icon="pi pi-search"
        size="small"
        @click="store.loadDuplicates()"
        :loading="store.loading"
      />
      <Tag
        v-if="store.duplicates.length > 0"
        :value="`${store.duplicates.length} groups`"
        severity="info"
      />
    </div>

    <DataTable
      :value="store.duplicates"
      :loading="store.loading"
      selectionMode="single"
      @rowSelect="(e: any) => selectGroup(e.data)"
      dataKey="id"
      :rows="20"
      :paginator="store.duplicates.length > 20"
      stripedRows
      size="small"
      sortField="similarity"
      :sortOrder="-1"
    >
      <Column header="Files" sortable sortField="files">
        <template #body="{ data }">
          <div style="display: flex; flex-direction: column; gap: 0.15rem">
            <span
              v-for="f in data.files"
              :key="f.file"
              style="font-size: 0.8rem; font-family: monospace"
            >
              {{ f.file.split("/").pop() || f.file }}
            </span>
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
          <Tag
            :value="`${(data.similarity * 100).toFixed(1)}%`"
            :severity="severityForScore(data.similarity)"
          />
        </template>
      </Column>
      <Column header="Preview" style="width: 20rem">
        <template #body="{ data }">
          <code
            v-if="data.snippet"
            style="
              font-size: 0.75rem;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              display: block;
              max-width: 18rem;
            "
            >{{ data.snippet }}</code
          >
          <span
            v-else
            style="color: var(--p-text-muted-color); font-size: 0.8rem"
            >{{ data.files.length }} files</span
          >
        </template>
      </Column>
      <Column style="width: 4rem">
        <template #body="{ data }">
          <Button
            icon="pi pi-eye"
            text
            size="small"
            @click="selectGroup(data)"
          />
        </template>
      </Column>
    </DataTable>
  </div>
</template>
