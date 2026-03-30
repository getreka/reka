<script setup lang="ts">
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import type { Session } from "@/types/api";

defineProps<{ sessions: Session[] }>();

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}
</script>

<template>
  <DataTable :value="sessions" size="small" stripedRows>
    <Column field="id" header="Session" style="max-width: 10rem">
      <template #body="{ data }">
        <span style="font-family: monospace; font-size: 0.8rem"
          >{{ data.id?.slice(0, 8) }}...</span
        >
      </template>
    </Column>
    <Column field="initialContext" header="Context" style="max-width: 20rem">
      <template #body="{ data }">
        {{ data.initialContext?.slice(0, 60) || "—" }}
      </template>
    </Column>
    <Column field="status" header="Status">
      <template #body="{ data }">
        <Tag
          :severity="data.status === 'active' ? 'success' : 'secondary'"
          :value="data.status"
        />
      </template>
    </Column>
    <Column field="startedAt" header="Started">
      <template #body="{ data }">{{ formatDate(data.startedAt) }}</template>
    </Column>
  </DataTable>
</template>
