<script setup lang="ts">
import Card from "primevue/card";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import type { PlatformStats } from "@/types/api";

defineProps<{ stats?: PlatformStats | null }>();
</script>

<template>
  <Card>
    <template #title>Platform Stats</template>
    <template #content>
      <div
        v-if="!stats"
        style="color: var(--p-text-muted-color); font-size: 0.875rem"
      >
        No data
      </div>
      <div v-else>
        <div
          style="
            display: flex;
            gap: 2rem;
            margin-bottom: 0.75rem;
            font-size: 0.875rem;
          "
        >
          <span
            ><b>{{ stats.totalProjects }}</b> projects</span
          >
          <span
            ><b>{{ stats.totalCollections }}</b> collections</span
          >
        </div>
        <DataTable
          :value="stats.projects"
          size="small"
          :rows="5"
          :paginator="stats.projects.length > 5"
        >
          <Column field="project" header="Project" />
          <Column
            field="collections"
            header="Collections"
            style="width: 6rem; text-align: right"
          />
          <Column header="Vectors" style="width: 8rem; text-align: right">
            <template #body="{ data }">{{
              data.totalVectors.toLocaleString()
            }}</template>
          </Column>
        </DataTable>
      </div>
    </template>
  </Card>
</template>
