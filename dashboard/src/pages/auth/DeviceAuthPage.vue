<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Button from "primevue/button";
import Message from "primevue/message";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const auth = useAuthStore();

const userCode = computed(() => (route.query.code as string) || "");
const activeTab = ref<"register" | "login">("register");
const loading = ref(false);
const error = ref("");
const completed = ref(false);

// Register fields
const regEmail = ref("");
const regUsername = ref("");
const regPassword = ref("");

// Login fields
const loginEmail = ref("");
const loginPassword = ref("");

onMounted(async () => {
  // If already authenticated, auto-complete device session
  if (auth.isAuthenticated && userCode.value) {
    await completeDevice();
  }
});

async function handleRegister() {
  error.value = "";
  loading.value = true;
  try {
    await auth.signup(regEmail.value, regUsername.value, regPassword.value);
    if (userCode.value) await completeDevice();
    else completed.value = true;
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}

async function handleLogin() {
  error.value = "";
  loading.value = true;
  try {
    await auth.login(loginEmail.value, loginPassword.value);
    if (userCode.value) await completeDevice();
    else completed.value = true;
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}

async function completeDevice() {
  try {
    await auth.completeDevice(userCode.value);
    completed.value = true;
  } catch (e: any) {
    error.value =
      "Failed to link device session: " +
      (e.response?.data?.error || e.message);
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <!-- Logo -->
      <div class="auth-logo">
        <i
          class="pi pi-diamond"
          style="color: var(--p-primary-color); font-size: 1.5rem"
        />
        <span class="auth-logo-text">Reka</span>
      </div>

      <!-- Completed state -->
      <template v-if="completed">
        <div class="auth-success">
          <i
            class="pi pi-check-circle"
            style="font-size: 3rem; color: var(--p-green-500)"
          />
          <h2>Connected!</h2>
          <p>Return to your terminal — the CLI has your API key.</p>
        </div>
      </template>

      <!-- Auth form -->
      <template v-else>
        <h2 class="auth-title">Connect to Reka Demo</h2>
        <p class="auth-subtitle">Sign in to link your AI assistant</p>

        <!-- Verification code -->
        <div v-if="userCode" class="auth-code-badge">
          <i class="pi pi-desktop" style="color: var(--p-primary-color)" />
          <span class="auth-code-label">Your code:</span>
          <span class="auth-code-value">{{ userCode }}</span>
        </div>

        <!-- Tabs -->
        <div class="auth-tabs">
          <button
            :class="['auth-tab', { active: activeTab === 'register' }]"
            @click="activeTab = 'register'"
          >
            Create Account
          </button>
          <button
            :class="['auth-tab', { active: activeTab === 'login' }]"
            @click="activeTab = 'login'"
          >
            Sign In
          </button>
        </div>

        <!-- Error -->
        <Message
          v-if="error"
          severity="error"
          :closable="false"
          style="width: 100%"
        >
          {{ error }}
        </Message>

        <!-- Register form -->
        <form
          v-if="activeTab === 'register'"
          class="auth-form"
          @submit.prevent="handleRegister"
        >
          <div class="auth-field">
            <label>Email</label>
            <InputText
              v-model="regEmail"
              type="email"
              placeholder="you@example.com"
              fluid
            />
          </div>
          <div class="auth-field">
            <label>Username</label>
            <InputText v-model="regUsername" placeholder="johndoe" fluid />
          </div>
          <div class="auth-field">
            <label>Password</label>
            <Password
              v-model="regPassword"
              :feedback="false"
              toggleMask
              fluid
            />
          </div>
          <Button
            type="submit"
            label="Create Account"
            icon="pi pi-user-plus"
            :loading="loading"
            fluid
          />
          <p class="auth-terms">
            By signing up you agree to the Terms of Service
          </p>
        </form>

        <!-- Login form -->
        <form
          v-if="activeTab === 'login'"
          class="auth-form"
          @submit.prevent="handleLogin"
        >
          <div class="auth-field">
            <label>Email</label>
            <InputText
              v-model="loginEmail"
              type="email"
              placeholder="you@example.com"
              fluid
            />
          </div>
          <div class="auth-field">
            <label>Password</label>
            <Password
              v-model="loginPassword"
              :feedback="false"
              toggleMask
              fluid
            />
          </div>
          <Button
            type="submit"
            label="Sign In"
            icon="pi pi-sign-in"
            :loading="loading"
            fluid
          />
        </form>
      </template>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--p-surface-ground);
}
.auth-card {
  width: 420px;
  max-width: 90vw;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 16px;
  padding: 40px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.auth-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.auth-logo-text {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--p-text-color);
}
.auth-title {
  text-align: center;
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
  color: var(--p-text-color);
}
.auth-subtitle {
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
  margin: -12px 0 0;
}
.auth-code-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  background: var(--p-surface-100);
  border: 1px solid var(--p-surface-border);
  border-radius: 12px;
}
.auth-code-label {
  color: var(--p-text-muted-color);
  font-size: 0.8125rem;
}
.auth-code-value {
  color: var(--p-primary-color);
  font-family: "JetBrains Mono", monospace;
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: 2px;
}
.auth-tabs {
  display: flex;
  border-bottom: 1px solid var(--p-surface-border);
}
.auth-tab {
  flex: 1;
  padding: 10px 0;
  text-align: center;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--p-text-muted-color);
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}
.auth-tab.active {
  color: var(--p-text-color);
  border-bottom-color: var(--p-primary-color);
  font-weight: 500;
}
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.auth-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.auth-field label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--p-text-muted-color);
}
.auth-terms {
  text-align: center;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  margin: 0;
}
.auth-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 20px 0;
}
.auth-success h2 {
  margin: 0;
  color: var(--p-text-color);
}
.auth-success p {
  color: var(--p-text-muted-color);
  text-align: center;
}
</style>
