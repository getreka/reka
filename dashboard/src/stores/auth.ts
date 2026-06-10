import { defineStore } from "pinia";
import { ref, computed } from "vue";
import client from "@/api/client";

export interface DemoUser {
  username: string;
  email: string;
  projectName: string;
  apiKeyPrefix: string;
  createdAt: string;
}

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("demo_token") || "");
  const user = ref<DemoUser | null>(null);
  const isAuthenticated = computed(() => !!token.value && !!user.value);
  const isDemoMode = computed(
    () =>
      window.location.hostname.includes("demo") ||
      import.meta.env.VITE_DEMO_MODE === "true",
  );

  function setToken(t: string) {
    token.value = t;
    localStorage.setItem("demo_token", t);
  }

  async function fetchMe(): Promise<boolean> {
    if (!token.value) return false;
    try {
      const { data } = await client.get("/api/auth/me", {
        headers: { Authorization: `Bearer ${token.value}` },
      });
      user.value = data;
      return true;
    } catch {
      clearAuth();
      return false;
    }
  }

  async function signup(
    email: string,
    username: string,
    password: string,
  ): Promise<{ apiKey: string; projectName: string }> {
    const { data } = await client.post("/api/auth/signup", {
      email,
      username,
      password,
    });
    setToken(data.token);
    user.value = {
      username: data.username,
      email,
      projectName: data.projectName,
      apiKeyPrefix: data.apiKey.slice(0, 20) + "...",
      createdAt: new Date().toISOString(),
    };
    return { apiKey: data.apiKey, projectName: data.projectName };
  }

  async function login(
    email: string,
    password: string,
  ): Promise<{ apiKey: string; projectName: string }> {
    const { data } = await client.post("/api/auth/login", { email, password });
    setToken(data.token);
    user.value = {
      username: data.username,
      email,
      projectName: data.projectName,
      apiKeyPrefix: data.apiKey.slice(0, 20) + "...",
      createdAt: new Date().toISOString(),
    };
    return { apiKey: data.apiKey, projectName: data.projectName };
  }

  async function completeDevice(userCode: string): Promise<void> {
    await client.post(
      "/api/auth/complete-device",
      { userCode },
      { headers: { Authorization: `Bearer ${token.value}` } },
    );
  }

  async function logout() {
    try {
      await client.post(
        "/api/auth/logout",
        {},
        { headers: { Authorization: `Bearer ${token.value}` } },
      );
    } catch {
      // ignore
    }
    clearAuth();
  }

  function clearAuth() {
    token.value = "";
    user.value = null;
    localStorage.removeItem("demo_token");
  }

  return {
    token,
    user,
    isAuthenticated,
    isDemoMode,
    setToken,
    fetchMe,
    signup,
    login,
    completeDevice,
    logout,
    clearAuth,
  };
});
