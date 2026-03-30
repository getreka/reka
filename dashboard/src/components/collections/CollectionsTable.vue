<script setup lang="ts">
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import type { CollectionSummary, AliasInfo } from "@/types/collections";

const props = defineProps<{
  collections: CollectionSummary[];
  aliases: AliasInfo[];
}>();
const emit = defineEmits<{ select: [name: string] }>();

function getAlias(name: string): string | undefined {
  return props.aliases.find((a) => a.collectionName === name)?.aliasName;
}
</script>

<template>
  <DataTable
    :value="collections"
    size="small"
    stripedRows
    selectionMode="single"
    @row-click="emit('select', $event.data.name)"
    style="cursor: pointer"
  >
    <Column field="name" header="Collection">
      <template #body="{ data }">
        <span>{{ data.name }}</span>
        <i
          v-if="getAlias(data.name)"
          class="pi pi-link"
          style="
            margin-left: 0.5rem;
            font-size: 0.75rem;
            color: var(--p-primary-color);
          "
          :title="`Alias: ${getAlias(data.name)}`"
        />
      </template>
    </Column>
    <Column field="vectorsCount" header="Vectors" style="width: 8rem">
      <template #body="{ data }">{{
        data.vectorsCount?.toLocaleString()
      }}</template>
    </Column>
    <Column field="status" header="Status" style="width: 8rem">
      <template #body="{ data }">
        <Tag
          :severity="data.status === 'green' ? 'success' : 'warn'"
          :value="data.status"
        />
      </template>
    </Column>
  </DataTable>
</template>
