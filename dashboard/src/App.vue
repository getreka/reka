<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import Toast from "primevue/toast";
import ConfirmDialog from "primevue/confirmdialog";
import AppLayout from "@/components/layout/AppLayout.vue";
import { useAppStore } from "@/stores/app";
import { usePolling } from "@/composables/usePolling";
import { useToast } from "primevue/usetoast";

const app = useAppStore();
const toast = useToast();
const { start } = usePolling(() => app.checkHealth(), 30000);

function handleApiError(e: Event) {
  const { severity, summary, detail } = (e as CustomEvent).detail;
  toast.add({ severity, summary, detail, life: 5000 });
}

onMounted(() => {
  start();
  app.initDarkMode();
  window.addEventListener("rag-api-error", handleApiError);
});

onUnmounted(() => {
  window.removeEventListener("rag-api-error", handleApiError);
});
</script>

<template>
  <Toast />
  <ConfirmDialog />
  <AppLayout>
    <router-view />
  </AppLayout>
</template>
