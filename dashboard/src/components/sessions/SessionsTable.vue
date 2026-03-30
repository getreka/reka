<script setup lang="ts">
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";

defineProps<{
  sessions: Record<string, any>[];
  selectedId?: string;
}>();
const emit = defineEmits<{ select: [id: string] }>();

function formatDuration(session: Record<string, any>): string {
  const start = new Date(session.startedAt).getTime();
  const end = session.endedAt
    ? new Date(session.endedAt).getTime()
    : Date.now();
  const mins = Math.floor((end - start) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getId(session: Record<string, any>): string {
  return session.sessionId ?? session.id ?? "";
}
</script>

<template>
  <DataTable
    :value="sessions"
    :rowHover="true"
    @row-click="(e: any) => emit('select', getId(e.data))"
    :paginator="sessions.length > 20"
    :rows="20"
    size="small"
  >
    <Column header="ID" style="width: 8rem">
      <template #body="{ data }">
        <code style="font-size: 0.8rem">{{ getId(data).slice(0, 8) }}</code>
      </template>
    </Column>
    <Column header="Context" style="min-width: 12rem">
      <template #body="{ data }">
        {{ data.initialContext || "—" }}
      </template>
    </Column>
    <Column header="Status" style="width: 6rem">
      <template #body="{ data }">
        <Tag
          :severity="data.status === 'active' ? 'success' : 'secondary'"
          :value="data.status"
        />
      </template>
    </Column>
    <Column header="Started" style="width: 10rem">
      <template #body="{ data }">
        {{ formatDate(data.startedAt) }}
      </template>
    </Column>
    <Column header="Duration" style="width: 6rem">
      <template #body="{ data }">
        {{ formatDuration(data) }}
      </template>
    </Column>
  </DataTable>
</template>
