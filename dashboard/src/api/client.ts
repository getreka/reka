import axios from "axios";

const client = axios.create({
  baseURL:
    localStorage.getItem("rag_api_url") ||
    import.meta.env.VITE_RAG_API_URL ||
    "",
  timeout: 15000,
});

client.interceptors.request.use((config) => {
  const apiKey =
    localStorage.getItem("rag_api_key") || import.meta.env.VITE_API_KEY;
  const project =
    localStorage.getItem("rag_project") || import.meta.env.VITE_DEFAULT_PROJECT;

  if (apiKey) {
    config.headers["X-API-Key"] = apiKey;
  }
  if (project) {
    config.headers["X-Project-Name"] = project;
  }

  // Demo mode: add session token
  const demoToken = localStorage.getItem("demo_token");
  if (demoToken) {
    config.headers["Authorization"] = `Bearer ${demoToken}`;
  }

  return config;
});

// Debounce toast dispatches — max once per 5s per category
const lastToast: Record<string, number> = {};
function dispatchToast(
  key: string,
  detail: { severity: string; summary: string; detail: string },
) {
  const now = Date.now();
  if (now - (lastToast[key] || 0) < 5000) return;
  lastToast[key] = now;
  window.dispatchEvent(new CustomEvent("rag-api-error", { detail }));
}

// Global error interceptor
client.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if (status === 400) {
      const msg = error.response?.data?.error || "";
      if (/project/i.test(msg)) {
        dispatchToast("project", {
          severity: "warn",
          summary: "Project Required",
          detail: "Set a project name in Settings",
        });
      }
    } else if (status === 401 || status === 403) {
      dispatchToast("auth", {
        severity: "error",
        summary: "Authentication Error",
        detail: "Check your API key in Settings",
      });
    } else if (status && status >= 500) {
      dispatchToast("server", {
        severity: "error",
        summary: "Server Error",
        detail: error.response?.data?.error || `HTTP ${status}`,
      });
    }
    return Promise.reject(error);
  },
);

export default client;
