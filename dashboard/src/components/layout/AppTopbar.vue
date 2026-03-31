<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import Tag from "primevue/tag";
import Button from "primevue/button";
import Avatar from "primevue/avatar";
import { useAppStore } from "@/stores/app";
import { useAuthStore } from "@/stores/auth";

defineProps<{ showHamburger?: boolean }>();

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const auth = useAuthStore();

const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    "/overview": "Overview",
    "/memory": "Memory Browser",
    "/collections": "Collections",
    "/sessions": "Sessions",
    "/graph": "Graph Explorer",
    "/settings": "Settings",
  };
  return titles[route.path] || "Dashboard";
});
</script>

<template>
  <header
    style="
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.5rem;
      background: var(--p-surface-0);
      border-bottom: 1px solid var(--p-surface-200);
    "
  >
    <div style="display: flex; align-items: center; gap: 0.75rem">
      <Button
        v-if="showHamburger"
        icon="pi pi-bars"
        text
        size="small"
        @click="app.isSidebarOpen = !app.isSidebarOpen"
      />
      <h1 style="margin: 0; font-size: 1.25rem; font-weight: 600">
        {{ pageTitle }}
      </h1>
    </div>
    <div style="display: flex; align-items: center; gap: 0.75rem">
      <Tag
        v-if="app.currentProject"
        :value="app.currentProject"
        severity="info"
      />
      <Button
        :icon="app.isDark ? 'pi pi-sun' : 'pi pi-moon'"
        text
        size="small"
        @click="app.isDark = !app.isDark"
        v-tooltip="app.isDark ? 'Light mode' : 'Dark mode'"
      />
      <Button
        icon="pi pi-cog"
        text
        size="small"
        @click="router.push('/settings')"
        v-tooltip="'Settings'"
      />
      <template v-if="auth.isDemoMode && auth.isAuthenticated">
        <div
          style="
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-left: 0.5rem;
            padding-left: 0.75rem;
            border-left: 1px solid var(--p-surface-200);
          "
        >
          <Avatar
            :label="auth.user?.username?.charAt(0).toUpperCase()"
            shape="circle"
            size="small"
            style="background: var(--p-primary-color); color: white"
          />
          <span style="font-size: 0.875rem; color: var(--p-text-color)">{{
            auth.user?.username
          }}</span>
          <Button
            icon="pi pi-sign-out"
            text
            size="small"
            @click="auth.logout().then(() => router.push('/auth/login'))"
            v-tooltip="'Logout'"
          />
        </div>
      </template>
    </div>
  </header>
</template>
