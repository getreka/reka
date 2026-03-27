<script setup lang="ts">
import { ref, computed } from 'vue'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import type { QuarantineMemory } from '@/types/memory'

defineProps<{ memories: QuarantineMemory[] }>()
const emit = defineEmits<{
  validate: [id: string, validated: boolean]
  promote: [id: string, reason: string]
  batchPromote: [ids: string[], reason: string]
  batchReject: [ids: string[]]
}>()

// Selection
const selected = ref<QuarantineMemory[]>([])
const hasSelection = computed(() => selected.value.length > 0)
const selectionLabel = computed(() => `${selected.value.length} selected`)

// Single promote dialog
const showPromoteDialog = ref(false)
const promoteId = ref('')
const promoteReason = ref('human_validated')
const isBatchPromote = ref(false)

const reasonOptions = [
  { label: 'Human Validated', value: 'human_validated' },
  { label: 'PR Merged', value: 'pr_merged' },
  { label: 'Tests Passed', value: 'tests_passed' },
]

function openPromote(id: string) {
  promoteId.value = id
  promoteReason.value = 'human_validated'
  isBatchPromote.value = false
  showPromoteDialog.value = true
}

function openBatchPromote() {
  promoteReason.value = 'human_validated'
  isBatchPromote.value = true
  showPromoteDialog.value = true
}

function confirmPromote() {
  if (isBatchPromote.value) {
    emit('batchPromote', selected.value.map(m => m.id), promoteReason.value)
    selected.value = []
  } else {
    emit('promote', promoteId.value, promoteReason.value)
  }
  showPromoteDialog.value = false
}

function batchReject() {
  emit('batchReject', selected.value.map(m => m.id))
  selected.value = []
}

// Confidence color
function confidenceClass(confidence?: number): string {
  if (!confidence) return ''
  if (confidence >= 0.7) return 'color: var(--p-green-500)'
  if (confidence >= 0.4) return 'color: var(--p-yellow-500)'
  return 'color: var(--p-red-500)'
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 0.5rem;">
    <!-- Batch actions bar -->
    <div v-if="hasSelection" style="display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--p-surface-50); border-radius: 6px;">
      <span style="font-size: 0.875rem; font-weight: 600;">{{ selectionLabel }}</span>
      <div style="flex: 1;" />
      <Button label="Promote All" icon="pi pi-arrow-up" size="small" severity="info" @click="openBatchPromote" />
      <Button label="Reject All" icon="pi pi-times" size="small" severity="danger" outlined @click="batchReject" />
    </div>

    <DataTable v-model:selection="selected" :value="memories" size="small" stripedRows dataKey="id">
      <Column selectionMode="multiple" headerStyle="width: 3rem" />
      <Column field="content" header="Content" style="max-width: 30rem;">
        <template #body="{ data }">
          <span style="font-size: 0.875rem;">{{ data.content?.slice(0, 150) }}{{ (data.content?.length ?? 0) > 150 ? '...' : '' }}</span>
        </template>
      </Column>
      <Column field="type" header="Type" style="width: 7rem;">
        <template #body="{ data }">
          <Tag :value="data.type" />
        </template>
      </Column>
      <Column field="source" header="Source" style="width: 8rem;">
        <template #body="{ data }">
          <span style="font-size: 0.8rem; color: var(--p-text-muted-color);">{{ data.source || '—' }}</span>
        </template>
      </Column>
      <Column field="confidence" header="Conf." style="width: 5rem;">
        <template #body="{ data }">
          <span :style="confidenceClass(data.confidence)">
            {{ data.confidence != null ? (data.confidence * 100).toFixed(0) + '%' : '—' }}
          </span>
        </template>
      </Column>
      <Column header="Actions" style="width: 10rem;">
        <template #body="{ data }">
          <div style="display: flex; gap: 0.25rem;">
            <Button icon="pi pi-check" severity="success" text size="small" title="Validate & Keep" @click="emit('validate', data.id, true)" />
            <Button icon="pi pi-times" severity="danger" text size="small" title="Reject" @click="emit('validate', data.id, false)" />
            <Button icon="pi pi-arrow-up" severity="info" text size="small" title="Promote to Durable" @click="openPromote(data.id)" />
          </div>
        </template>
      </Column>
    </DataTable>

    <div v-if="memories.length === 0" style="padding: 2rem; text-align: center; color: var(--p-text-muted-color);">
      No memories in quarantine. Auto-generated memories will appear here for review.
    </div>
  </div>

  <!-- Promote Dialog -->
  <Dialog v-model:visible="showPromoteDialog" :header="isBatchPromote ? `Promote ${selected.length} Memories` : 'Promote Memory'" modal style="width: 24rem;">
    <div style="display: flex; flex-direction: column; gap: 1rem;">
      <label>Reason for promotion:</label>
      <Select v-model="promoteReason" :options="reasonOptions" optionLabel="label" optionValue="value" />
    </div>
    <template #footer>
      <Button label="Cancel" text @click="showPromoteDialog = false" />
      <Button :label="isBatchPromote ? `Promote ${selected.length}` : 'Promote'" @click="confirmPromote" />
    </template>
  </Dialog>
</template>
