import { defineStore } from "pinia";
import { ref } from "vue";
import {
  fetchAgentTypes,
  runReactAgent,
  runAutonomousAgent,
  stopAutonomousAgent,
  fetchRunningAgents,
  type AgentTypeInfo,
  type AgentResult,
  type RunReactAgentOpts,
  type RunAutonomousAgentOpts,
} from "@/api/agents";

export const useAgentsStore = defineStore("agents", () => {
  const agentTypes = ref<AgentTypeInfo[]>([]);
  const autonomousTypes = ref<AgentTypeInfo[]>([]);
  const results = ref<
    (AgentResult & {
      tab: "react" | "autonomous";
      task: string;
      timestamp: number;
    })[]
  >([]);
  const selectedResult = ref<
    | (AgentResult & {
        tab: "react" | "autonomous";
        task: string;
        timestamp: number;
      })
    | null
  >(null);
  const runningAgents = ref<string[]>([]);
  const activeTab = ref<"react" | "autonomous">("react");
  const loading = ref(false);
  const error = ref("");

  async function loadTypes() {
    try {
      const data = await fetchAgentTypes();
      agentTypes.value = data.agents ?? [];
      autonomousTypes.value = data.autonomous ?? [];
    } catch (e: unknown) {
      error.value = (e as Error).message || "Failed to load agent types";
    }
  }

  async function runReact(opts: RunReactAgentOpts) {
    loading.value = true;
    error.value = "";
    try {
      const result = await runReactAgent(opts);
      const entry = {
        ...result,
        tab: "react" as const,
        task: opts.task,
        timestamp: Date.now(),
      };
      results.value.unshift(entry);
      selectedResult.value = entry;
      return result;
    } catch (e: unknown) {
      error.value = (e as Error).message || "Agent run failed";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function runAutonomous(opts: RunAutonomousAgentOpts) {
    loading.value = true;
    error.value = "";
    try {
      const result = await runAutonomousAgent(opts);
      const entry = {
        ...result,
        tab: "autonomous" as const,
        task: opts.task,
        timestamp: Date.now(),
      };
      results.value.unshift(entry);
      selectedResult.value = entry;
      return result;
    } catch (e: unknown) {
      error.value = (e as Error).message || "Autonomous agent failed";
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function stopAgent(agentId: string) {
    await stopAutonomousAgent(agentId);
    runningAgents.value = runningAgents.value.filter((id) => id !== agentId);
  }

  async function pollRunning() {
    try {
      const data = await fetchRunningAgents();
      runningAgents.value = data.running ?? [];
    } catch {
      // silent — polling failure is non-critical
    }
  }

  function selectResult(entry: (typeof results.value)[number]) {
    selectedResult.value = entry;
  }

  function clearSelection() {
    selectedResult.value = null;
  }

  return {
    agentTypes,
    autonomousTypes,
    results,
    selectedResult,
    runningAgents,
    activeTab,
    loading,
    error,
    loadTypes,
    runReact,
    runAutonomous,
    stopAgent,
    pollRunning,
    selectResult,
    clearSelection,
  };
});
