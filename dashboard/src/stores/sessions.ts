import { defineStore } from "pinia";
import { ref } from "vue";
import {
  fetchSessionsList,
  fetchSessionDetail,
  endSession as endSessionApi,
  startSession as startSessionApi,
  fetchWorkingMemory,
  fetchSensoryStats,
  fetchSessionRetrievals,
} from "@/api/sessions";
import type {
  WorkingMemoryState,
  SensoryStats,
  SessionRetrieval,
} from "@/types/session";
import { useAppStore } from "@/stores/app";

export const useSessionsStore = defineStore("sessions", () => {
  const sessions = ref<Record<string, any>[]>([]);
  const selectedSession = ref<Record<string, any> | null>(null);
  const workingMemory = ref<WorkingMemoryState | null>(null);
  const sensoryStats = ref<SensoryStats | null>(null);
  const retrievals = ref<SessionRetrieval[]>([]);
  const loading = ref(false);
  const error = ref("");
  const statusFilter = ref<"all" | "active" | "ended">("all");

  async function loadSessions() {
    loading.value = true;
    error.value = "";
    try {
      sessions.value = await fetchSessionsList({
        limit: 50,
        status: statusFilter.value,
      });
    } catch (e: any) {
      error.value = e.message || "Failed to load sessions";
    } finally {
      loading.value = false;
    }
  }

  async function selectSession(id: string) {
    workingMemory.value = null;
    sensoryStats.value = null;
    retrievals.value = [];
    try {
      selectedSession.value = await fetchSessionDetail(id);
      const app = useAppStore();
      const projectName =
        selectedSession.value?.projectName || app.currentProject || undefined;
      const [wm, ss, rt] = await Promise.allSettled([
        fetchWorkingMemory(id),
        fetchSensoryStats(id),
        fetchSessionRetrievals(id, projectName),
      ]);
      if (wm.status === "fulfilled") workingMemory.value = wm.value;
      if (ss.status === "fulfilled") sensoryStats.value = ss.value;
      if (rt.status === "fulfilled") retrievals.value = rt.value;
    } catch (e: any) {
      error.value = e.message || "Failed to load session detail";
    }
  }

  async function startSession(initialContext?: string) {
    const session = await startSessionApi(initialContext);
    await loadSessions();
    return session;
  }

  async function endSession(id: string, summary?: string) {
    await endSessionApi(id, summary);
    if (getId(selectedSession.value) === id) {
      selectedSession.value = { ...selectedSession.value, status: "ended" };
    }
    await loadSessions();
  }

  function clearSelection() {
    selectedSession.value = null;
    workingMemory.value = null;
    sensoryStats.value = null;
    retrievals.value = [];
  }

  return {
    sessions,
    selectedSession,
    workingMemory,
    sensoryStats,
    retrievals,
    loading,
    error,
    statusFilter,
    loadSessions,
    selectSession,
    startSession,
    endSession,
    clearSelection,
  };
});

function getId(session: Record<string, any> | null): string {
  return session?.sessionId ?? session?.id ?? "";
}
