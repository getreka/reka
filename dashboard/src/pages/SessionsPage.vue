<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import SessionsTable from "@/components/sessions/SessionsTable.vue";
import SessionDetailPanel from "@/components/sessions/SessionDetailPanel.vue";
import TribunalHistory from "@/components/sessions/TribunalHistory.vue";
import { useSessionsStore } from "@/stores/sessions";
import { useProjectWatch } from "@/composables/useProjectWatch";
import { useToast } from "@/composables/useToast";

const store = useSessionsStore();
const toast = useToast();

const activeTab = ref<string>(store.statusFilter);

useProjectWatch(() => store.loadSessions());
onMounted(() => store.loadSessions());

function handleTabChange(val: string | number) {
  activeTab.value = String(val);
  if (activeTab.value === "tribunal") return;
  store.statusFilter = activeTab.value as "all" | "active" | "ended";
  store.loadSessions();
}

async function handleEndSession(id: string) {
  try {
    await store.endSession(id);
    toast.success("Session ended");
  } catch {
    toast.error("Failed to end session");
  }
}

async function handleStartSession() {
  try {
    await store.startSession();
    toast.success("Session started");
  } catch {
    toast.error("Failed to start session");
  }
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div
      style="display: flex; justify-content: space-between; align-items: center"
    >
      <Tabs :value="activeTab" @update:value="handleTabChange">
        <TabList>
          <Tab value="all">All</Tab>
          <Tab value="active">Active</Tab>
          <Tab value="ended">Ended</Tab>
          <Tab value="tribunal">Tribunal</Tab>
        </TabList>
      </Tabs>
      <div
        v-if="activeTab !== 'tribunal'"
        style="display: flex; gap: 0.5rem; align-items: center"
      >
        <Button
          icon="pi pi-play"
          label="Start Session"
          size="small"
          severity="success"
          outlined
          @click="handleStartSession"
        />
        <Button
          icon="pi pi-refresh"
          label="Refresh"
          size="small"
          text
          @click="store.loadSessions()"
        />
      </div>
    </div>

    <TribunalHistory v-if="activeTab === 'tribunal'" />

    <template v-else>
      <Message v-if="store.error" severity="error" :closable="false">{{
        store.error
      }}</Message>

      <div
        v-if="store.loading"
        style="display: flex; justify-content: center; padding: 3rem"
      >
        <ProgressSpinner />
      </div>
      <div v-else style="display: flex; gap: 1rem">
        <div style="flex: 1; min-width: 0">
          <SessionsTable
            :sessions="store.sessions"
            :selected-id="
              store.selectedSession?.sessionId ?? store.selectedSession?.id
            "
            @select="store.selectSession"
          />
        </div>
        <div v-if="store.selectedSession" style="width: 26rem; flex-shrink: 0">
          <SessionDetailPanel
            :session="store.selectedSession"
            :working-memory="store.workingMemory"
            :sensory-stats="store.sensoryStats"
            @close="store.clearSelection()"
            @end-session="handleEndSession"
          />
        </div>
      </div>
    </template>
  </div>
</template>
