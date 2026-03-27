<script setup lang="ts">
import { onMounted, computed, ref } from 'vue'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Paginator from 'primevue/paginator'
import MemoryStatsVue from '@/components/memory/MemoryStats.vue'
import MemoryFilters from '@/components/memory/MemoryFilters.vue'
import MemoryCardGrid from '@/components/memory/MemoryCardGrid.vue'
import QuarantineQueue from '@/components/memory/QuarantineQueue.vue'
import UnvalidatedList from '@/components/memory/UnvalidatedList.vue'
import { useMemoryStore } from '@/stores/memory'
import { useToast } from '@/composables/useToast'
import { useProjectWatch } from '@/composables/useProjectWatch'
import type { MemoryType } from '@/types/memory'

const store = useMemoryStore()
const toast = useToast()
const activeTab = ref('memories')

const quarantineLabel = computed(() => `Quarantine (${store.quarantine.length})`)
const unvalidatedLabel = computed(() => `Unvalidated (${store.unvalidated.length})`)

// Create memory dialog
const showCreateDialog = ref(false)
const newMemory = ref({ type: 'note' as MemoryType, content: '', relatedTo: '', tags: '' })

const typeOptions = [
  { label: 'Note', value: 'note' },
  { label: 'Decision', value: 'decision' },
  { label: 'Insight', value: 'insight' },
  { label: 'Context', value: 'context' },
  { label: 'Todo', value: 'todo' },
  { label: 'Conversation', value: 'conversation' },
]

// Merge preview dialog
const showMergeDialog = ref(false)

function reload() {
  Promise.all([store.loadMemories(), store.loadStats(), store.loadQuarantine(), store.loadUnvalidated()])
}

useProjectWatch(reload)
onMounted(reload)

async function handleDelete(id: string) {
  try {
    await store.removeMemory(id)
    toast.success('Memory deleted')
  } catch {
    toast.error('Failed to delete memory')
  }
}

async function handleValidate(id: string, validated: boolean) {
  try {
    await store.validate(id, validated)
    toast.success(validated ? 'Memory validated' : 'Memory rejected')
  } catch {
    toast.error('Validation failed')
  }
}

async function handlePromote(id: string, reason: string) {
  try {
    await store.promote(id, reason)
    toast.success('Memory promoted to durable storage')
  } catch {
    toast.error('Promotion failed')
  }
}

async function handleCreate() {
  try {
    const tags = newMemory.value.tags.split(',').map(t => t.trim()).filter(Boolean)
    await store.createMemory({
      type: newMemory.value.type,
      content: newMemory.value.content,
      relatedTo: newMemory.value.relatedTo || undefined,
      tags,
    })
    toast.success('Memory created')
    showCreateDialog.value = false
    newMemory.value = { type: 'note', content: '', relatedTo: '', tags: '' }
  } catch {
    toast.error('Failed to create memory')
  }
}

async function handleMergePreview() {
  await store.loadMergePreview()
  showMergeDialog.value = true
}

async function handleMergeExecute() {
  try {
    await store.executeMerge()
    toast.success('Memories merged')
    showMergeDialog.value = false
    store.loadMemories()
  } catch {
    toast.error('Merge failed')
  }
}

async function handleBulkDelete(type: MemoryType) {
  try {
    await store.bulkDeleteByType(type)
    toast.success(`All ${type} memories deleted`)
    reload()
  } catch {
    toast.error('Bulk delete failed')
  }
}

async function handleBatchPromote(ids: string[], reason: string) {
  let ok = 0, fail = 0
  for (const id of ids) {
    try { await store.promote(id, reason); ok++ } catch { fail++ }
  }
  toast.success(`Promoted ${ok}${fail ? `, ${fail} failed` : ''}`)
  reload()
}

async function handleBatchReject(ids: string[]) {
  let ok = 0, fail = 0
  for (const id of ids) {
    try { await store.validate(id, false); ok++ } catch { fail++ }
  }
  toast.success(`Rejected ${ok}${fail ? `, ${fail} failed` : ''}`)
  reload()
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem;">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div style="display: flex; gap: 0.5rem;">
        <Button label="New Memory" icon="pi pi-plus" size="small" @click="showCreateDialog = true" />
        <Button label="Merge Preview" icon="pi pi-objects-column" size="small" severity="secondary" outlined @click="handleMergePreview" />
      </div>
      <Button icon="pi pi-refresh" label="Refresh" size="small" text @click="reload" />
    </div>

    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>

    <MemoryStatsVue :stats="store.stats" @bulk-delete="handleBulkDelete" />

    <Tabs v-model:value="activeTab">
      <TabList>
        <Tab value="memories">All Memories</Tab>
        <Tab value="quarantine">{{ quarantineLabel }}</Tab>
        <Tab value="unvalidated">{{ unvalidatedLabel }}</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="memories">
          <div style="display: flex; flex-direction: column; gap: 1rem; padding-top: 0.5rem;">
            <MemoryFilters />
            <MemoryCardGrid :memories="store.memories" :loading="store.loading" @delete="handleDelete" />
            <Paginator
              v-if="store.total > store.pageSize"
              :rows="store.pageSize"
              :totalRecords="store.total"
              :first="store.page * store.pageSize"
              @page="(e: any) => { store.page = e.page; store.loadMemories() }"
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
      </TabPanels>
    </Tabs>

    <!-- Create Memory Dialog -->
    <Dialog v-model:visible="showCreateDialog" header="New Memory" modal style="width: 30rem;">
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div>
          <label style="font-size: 0.875rem; font-weight: 600;">Type</label>
          <Select v-model="newMemory.type" :options="typeOptions" optionLabel="label" optionValue="value" style="width: 100%; margin-top: 0.25rem;" />
        </div>
        <div>
          <label style="font-size: 0.875rem; font-weight: 600;">Content</label>
          <Textarea v-model="newMemory.content" rows="5" style="width: 100%; margin-top: 0.25rem;" />
        </div>
        <div>
          <label style="font-size: 0.875rem; font-weight: 600;">Related To</label>
          <InputText v-model="newMemory.relatedTo" placeholder="feature or topic" style="width: 100%; margin-top: 0.25rem;" />
        </div>
        <div>
          <label style="font-size: 0.875rem; font-weight: 600;">Tags (comma-separated)</label>
          <InputText v-model="newMemory.tags" placeholder="tag1, tag2" style="width: 100%; margin-top: 0.25rem;" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="showCreateDialog = false" />
        <Button label="Create" icon="pi pi-check" :disabled="!newMemory.content" @click="handleCreate" />
      </template>
    </Dialog>

    <!-- Merge Preview Dialog -->
    <Dialog v-model:visible="showMergeDialog" header="Merge Preview" modal style="width: 40rem;">
      <div v-if="store.mergePreview.length === 0" style="padding: 1rem; color: var(--p-text-muted-color);">
        No merge candidates found.
      </div>
      <div v-else style="display: flex; flex-direction: column; gap: 1rem; max-height: 400px; overflow-y: auto;">
        <div v-for="(cluster, i) in store.mergePreview" :key="i" style="padding: 0.75rem; background: var(--p-surface-50); border-radius: 6px;">
          <div style="font-weight: 600; margin-bottom: 0.5rem;">Cluster {{ i + 1 }} ({{ cluster.count }} memories)</div>
          <div v-for="item in cluster.items" :key="item.id" style="font-size: 0.8rem; padding: 0.25rem 0; border-bottom: 1px solid var(--p-surface-200);">
            {{ item.content?.slice(0, 100) }}...
          </div>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="showMergeDialog = false" />
        <Button label="Merge Now" icon="pi pi-check" severity="warn" :disabled="store.mergePreview.length === 0" @click="handleMergeExecute" />
      </template>
    </Dialog>
  </div>
</template>
