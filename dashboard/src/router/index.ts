import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/overview',
    },
    {
      path: '/overview',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/pages/SearchPage.vue'),
    },
    {
      path: '/memory',
      name: 'memory',
      component: () => import('@/pages/MemoryPage.vue'),
    },
    {
      path: '/collections',
      name: 'collections',
      component: () => import('@/pages/CollectionsPage.vue'),
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('@/pages/SessionsPage.vue'),
    },
    {
      path: '/graph',
      name: 'graph',
      component: () => import('@/pages/GraphPage.vue'),
    },
    {
      path: '/quality',
      name: 'quality',
      component: () => import('@/pages/QualityPage.vue'),
    },
    {
      path: '/vectors',
      name: 'vectors',
      component: () => import('@/pages/VectorSpacePage.vue'),
    },
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/pages/AgentsPage.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/SettingsPage.vue'),
    },
  ],
})

export default router
