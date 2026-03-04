<script setup lang="ts">
import Card from 'primevue/card'
import Button from 'primevue/button'
import Tag from 'primevue/tag'

defineProps<{
  agents: string[]
}>()
const emit = defineEmits<{ stop: [agentId: string] }>()
</script>

<template>
  <Card>
    <template #title>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.95rem;">
        <span>Running Agents</span>
        <Tag :value="String(agents.length)" severity="info" />
      </div>
    </template>
    <template #content>
      <div v-if="agents.length === 0" style="font-size: 0.85rem; color: var(--p-text-muted-color); text-align: center; padding: 0.5rem;">
        No agents running
      </div>
      <div v-else style="display: flex; flex-direction: column; gap: 0.5rem;">
        <div
          v-for="id in agents"
          :key="id"
          style="display: flex; justify-content: space-between; align-items: center; padding: 0.375rem 0.5rem; background: var(--p-surface-100); border-radius: 6px;"
        >
          <code style="font-size: 0.8rem;">{{ id.slice(0, 8) }}</code>
          <Button
            icon="pi pi-stop-circle"
            severity="danger"
            text
            size="small"
            v-tooltip="'Stop agent'"
            @click="emit('stop', id)"
          />
        </div>
      </div>
    </template>
  </Card>
</template>
