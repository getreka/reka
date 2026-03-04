<script setup lang="ts">
import Tag from 'primevue/tag'
import { useAppStore } from '@/stores/app'

const app = useAppStore()

const navItems = [
  { to: '/overview', icon: 'pi pi-chart-bar', label: 'Overview' },
  { to: '/search', icon: 'pi pi-search', label: 'Search' },
  { to: '/memory', icon: 'pi pi-database', label: 'Memory' },
  { to: '/collections', icon: 'pi pi-server', label: 'Collections' },
  { to: '/sessions', icon: 'pi pi-clock', label: 'Sessions' },
  { to: '/graph', icon: 'pi pi-sitemap', label: 'Graph' },
  { to: '/quality', icon: 'pi pi-check-circle', label: 'Quality' },
  { to: '/vectors', icon: 'pi pi-th-large', label: 'Vectors' },
  { to: '/agents', icon: 'pi pi-android', label: 'Agents' },
  { to: '/settings', icon: 'pi pi-cog', label: 'Settings' },
]
</script>

<template>
  <aside :class="['sidebar', { 'sidebar--open': app.isSidebarOpen }]">
    <div style="padding: 0 1rem 1rem; font-size: 1.25rem; font-weight: 700; color: var(--p-primary-color);">
      <i class="pi pi-bolt" style="margin-right: 0.5rem;" />RAG Dashboard
    </div>
    <nav style="display: flex; flex-direction: column; gap: 2px;">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        custom
        v-slot="{ isActive, href, navigate }"
      >
        <a
          :href="href"
          :class="['nav-item', { 'nav-item--active': isActive }]"
          @click.prevent="navigate(); app.isSidebarOpen = false"
        >
          <i :class="item.icon" style="width: 1.25rem; text-align: center;" />
          {{ item.label }}
        </a>
      </RouterLink>
    </nav>
    <div style="margin-top: auto; padding: 1rem; text-align: center;">
      <Tag :severity="app.isConnected ? 'success' : 'danger'" :value="app.isConnected ? 'Connected' : 'Disconnected'" />
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 15rem;
  background: var(--p-surface-0);
  border-right: 1px solid var(--p-surface-200);
  display: flex;
  flex-direction: column;
  padding: 1rem 0;
  flex-shrink: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  color: var(--p-text-color);
  text-decoration: none;
  font-size: 0.875rem;
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.nav-item:hover {
  background: var(--p-surface-100);
}
.nav-item--active {
  background: var(--p-primary-50);
  border-left-color: var(--p-primary-color);
  color: var(--p-primary-color);
  font-weight: 600;
}

@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .sidebar--open {
    transform: translateX(0);
  }
}
</style>
