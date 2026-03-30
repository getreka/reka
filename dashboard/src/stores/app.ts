import { defineStore } from "pinia";
import { ref, watch } from "vue";
import client from "@/api/client";

export const useAppStore = defineStore("app", () => {
  const currentProject = ref(
    localStorage.getItem("rag_project") ||
      import.meta.env.VITE_DEFAULT_PROJECT ||
      "",
  );
  const apiKey = ref(
    localStorage.getItem("rag_api_key") || import.meta.env.VITE_API_KEY || "",
  );
  const apiUrl = ref(
    localStorage.getItem("rag_api_url") ||
      import.meta.env.VITE_RAG_API_URL ||
      "",
  );
  const isConnected = ref(false);
  const healthError = ref("");

  // Dark mode
  const isDark = ref(localStorage.getItem("rag_dark") === "true");

  // Auto-refresh interval (ms): 0 = off
  const autoRefreshInterval = ref(
    Number(localStorage.getItem("rag_refresh_interval") || "0"),
  );

  // Responsive sidebar
  const isSidebarOpen = ref(false);

  watch(currentProject, (v) => localStorage.setItem("rag_project", v));
  watch(apiKey, (v) => localStorage.setItem("rag_api_key", v));
  watch(apiUrl, (v) => {
    localStorage.setItem("rag_api_url", v);
    if (v) client.defaults.baseURL = v;
  });
  watch(isDark, (v) => {
    localStorage.setItem("rag_dark", String(v));
    document.documentElement.classList.toggle("dark", v);
  });
  watch(autoRefreshInterval, (v) =>
    localStorage.setItem("rag_refresh_interval", String(v)),
  );

  function initDarkMode() {
    document.documentElement.classList.toggle("dark", isDark.value);
  }

  async function checkHealth() {
    try {
      await client.get("/health");
      isConnected.value = true;
      healthError.value = "";
    } catch (e: any) {
      isConnected.value = false;
      healthError.value = e.message;
    }
  }

  function clearAllStorage() {
    localStorage.removeItem("rag_project");
    localStorage.removeItem("rag_api_key");
    localStorage.removeItem("rag_api_url");
    localStorage.removeItem("rag_dark");
    localStorage.removeItem("rag_refresh_interval");
    currentProject.value = "";
    apiKey.value = "";
    apiUrl.value = "";
    isDark.value = false;
    autoRefreshInterval.value = 0;
  }

  return {
    currentProject,
    apiKey,
    apiUrl,
    isConnected,
    healthError,
    isDark,
    autoRefreshInterval,
    isSidebarOpen,
    checkHealth,
    initDarkMode,
    clearAllStorage,
  };
});
