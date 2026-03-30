import { ref, onUnmounted } from "vue";

export function useSSE<T = any>(urlFn: () => string | null) {
  const data = ref<T | null>(null);
  const connected = ref(false);
  const error = ref("");
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    const url = urlFn();
    if (!url) return;
    disconnect();

    const baseUrl =
      localStorage.getItem("rag_api_url") ||
      import.meta.env.VITE_RAG_API_URL ||
      "";
    const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;

    source = new EventSource(fullUrl);
    connected.value = true;
    error.value = "";

    source.onmessage = (event) => {
      try {
        data.value = JSON.parse(event.data) as T;
      } catch {}
    };

    source.onerror = () => {
      connected.value = false;
      source?.close();
      source = null;
      // Auto-reconnect after 5s
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (source) {
      source.close();
      source = null;
    }
    connected.value = false;
  }

  onUnmounted(disconnect);

  return { data, connected, error, connect, disconnect };
}
