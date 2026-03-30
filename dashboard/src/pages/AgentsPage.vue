<script setup lang="ts">
import { onMounted, watch } from "vue";
import Button from "primevue/button";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import Tabs from "primevue/tabs";
import TabList from "primevue/tablist";
import Tab from "primevue/tab";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import RunAgentForm from "@/components/agents/RunAgentForm.vue";
import AgentResultCard from "@/components/agents/AgentResultCard.vue";
import RunningAgentsList from "@/components/agents/RunningAgentsList.vue";
import { useAgentsStore } from "@/stores/agents";
import { useProjectWatch } from "@/composables/useProjectWatch";
import { usePolling } from "@/composables/usePolling";
import { useToast } from "@/composables/useToast";

const store = useAgentsStore();
const toast = useToast();
const polling = usePolling(() => store.pollRunning(), 5000);

useProjectWatch(() => store.loadTypes());
onMounted(() => {
  store.loadTypes();
});

// Start/stop polling when switching to autonomous tab
watch(
  () => store.activeTab,
  (tab) => {
    if (tab === "autonomous") {
      polling.start();
    } else {
      polling.stop();
    }
  },
  { immediate: true },
);

function handleTabChange(val: string | number) {
  store.activeTab = String(val) as "react" | "autonomous";
}

async function handleRunReact(opts: {
  agentType: string;
  task: string;
  maxIterations?: number;
  includeThinking?: boolean;
}) {
  try {
    await store.runReact(opts);
    toast.success("Agent completed");
  } catch {
    toast.error("Agent run failed");
  }
}

async function handleRunAutonomous(opts: {
  type: string;
  task: string;
  projectPath: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: string;
}) {
  try {
    await store.runAutonomous(
      opts as Parameters<typeof store.runAutonomous>[0],
    );
    toast.success("Autonomous agent completed");
  } catch {
    toast.error("Autonomous agent failed");
  }
}

async function handleStop(agentId: string) {
  try {
    await store.stopAgent(agentId);
    toast.success("Agent stopped");
  } catch {
    toast.error("Failed to stop agent");
  }
}

function statusSeverity(
  status: string,
): "success" | "danger" | "warn" | "secondary" | "info" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "budget_exceeded":
      return "warn";
    case "interrupted":
      return "secondary";
    default:
      return "info";
  }
}

function truncate(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <div
      style="display: flex; justify-content: space-between; align-items: center"
    >
      <Tabs :value="store.activeTab" @update:value="handleTabChange">
        <TabList>
          <Tab value="react">ReAct Agents</Tab>
          <Tab value="autonomous">Autonomous Agents</Tab>
        </TabList>
      </Tabs>
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        text
        @click="store.loadTypes()"
      />
    </div>

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
      <!-- Left column: form + running + history -->
      <div
        style="
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        "
      >
        <RunAgentForm
          :tab="store.activeTab"
          :agent-types="store.agentTypes"
          :autonomous-types="store.autonomousTypes"
          :loading="store.loading"
          @run-react="handleRunReact"
          @run-autonomous="handleRunAutonomous"
        />

        <RunningAgentsList
          v-if="store.activeTab === 'autonomous'"
          :agents="store.runningAgents"
          @stop="handleStop"
        />

        <!-- Results history -->
        <DataTable
          :value="store.results.filter((r) => r.tab === store.activeTab)"
          :rowHover="true"
          @row-click="(e: any) => store.selectResult(e.data)"
          :paginator="store.results.length > 10"
          :rows="10"
          size="small"
        >
          <Column header="Status" style="width: 7rem">
            <template #body="{ data }">
              <Tag
                :severity="statusSeverity(data.status)"
                :value="data.status"
              />
            </template>
          </Column>
          <Column header="Type" style="width: 6rem">
            <template #body="{ data }">
              {{ data.agentType ?? data.type ?? "—" }}
            </template>
          </Column>
          <Column header="Task" style="min-width: 12rem">
            <template #body="{ data }">
              {{ truncate(data.task) }}
            </template>
          </Column>
          <Column header="Time" style="width: 10rem">
            <template #body="{ data }">
              {{ new Date(data.timestamp).toLocaleTimeString() }}
            </template>
          </Column>
        </DataTable>
      </div>

      <!-- Right column: detail panel -->
      <div v-if="store.selectedResult" style="width: 26rem; flex-shrink: 0">
        <AgentResultCard
          :result="store.selectedResult"
          @close="store.clearSelection()"
        />
      </div>
    </div>
  </div>
</template>
