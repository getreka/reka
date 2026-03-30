<script setup lang="ts">
import AppSidebar from "./AppSidebar.vue";
import AppTopbar from "./AppTopbar.vue";
import { useAppStore } from "@/stores/app";
import { useBreakpoint } from "@/composables/useBreakpoint";

const app = useAppStore();
const { matches: isNarrow } = useBreakpoint();
</script>

<template>
  <div style="display: flex; min-height: 100vh">
    <!-- Backdrop for mobile sidebar -->
    <div
      v-if="isNarrow && app.isSidebarOpen"
      style="
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 999;
      "
      @click="app.isSidebarOpen = false"
    />
    <AppSidebar />
    <div style="flex: 1; display: flex; flex-direction: column; min-width: 0">
      <AppTopbar :show-hamburger="isNarrow" />
      <main
        style="
          flex: 1;
          padding: 1.5rem;
          background: var(--p-surface-50);
          overflow-x: hidden;
        "
      >
        <slot />
      </main>
    </div>
  </div>
</template>
