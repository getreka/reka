import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      redirect: "/overview",
    },
    {
      path: "/auth/device",
      name: "device-auth",
      component: () => import("@/pages/auth/DeviceAuthPage.vue"),
      meta: { public: true },
    },
    {
      path: "/auth/login",
      name: "login",
      component: () => import("@/pages/auth/LoginPage.vue"),
      meta: { public: true },
    },
    {
      path: "/overview",
      name: "overview",
      component: () => import("@/pages/OverviewPage.vue"),
    },
    {
      path: "/search",
      name: "search",
      component: () => import("@/pages/SearchPage.vue"),
    },
    {
      path: "/memory",
      name: "memory",
      component: () => import("@/pages/MemoryPage.vue"),
    },
    {
      path: "/collections",
      name: "collections",
      component: () => import("@/pages/CollectionsPage.vue"),
    },
    {
      path: "/sessions",
      name: "sessions",
      component: () => import("@/pages/SessionsPage.vue"),
    },
    {
      path: "/graph",
      name: "graph",
      component: () => import("@/pages/GraphPage.vue"),
    },
    {
      path: "/quality",
      name: "quality",
      component: () => import("@/pages/QualityPage.vue"),
    },
    {
      path: "/vectors",
      name: "vectors",
      component: () => import("@/pages/VectorSpacePage.vue"),
    },
    {
      path: "/agents",
      name: "agents",
      component: () => import("@/pages/AgentsPage.vue"),
    },
    {
      path: "/tribunal",
      name: "tribunal",
      component: () => import("@/pages/TribunalPage.vue"),
    },
    {
      path: "/metrics",
      name: "metrics",
      component: () => import("@/pages/MetricsPage.vue"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("@/pages/SettingsPage.vue"),
    },
    {
      path: "/admin",
      name: "admin",
      component: () => import("@/pages/AdminPage.vue"),
    },
  ],
});

// Demo mode auth guard
router.beforeEach(async (to) => {
  const isDemoHost =
    window.location.hostname.includes("demo") ||
    import.meta.env.VITE_DEMO_MODE === "true";

  if (!isDemoHost) return; // self-hosted, no auth needed
  if (to.meta.public) return; // auth pages are public

  const auth = useAuthStore();
  if (!auth.isAuthenticated) {
    const restored = await auth.fetchMe();
    if (!restored) {
      return { name: "login" };
    }
  }
});

export default router;
