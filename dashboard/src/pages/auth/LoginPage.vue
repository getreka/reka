<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Button from "primevue/button";
import Message from "primevue/message";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");

async function handleLogin() {
  error.value = "";
  loading.value = true;
  try {
    await auth.login(email.value, password.value);
    router.push("/overview");
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="auth-logo">
        <i
          class="pi pi-diamond"
          style="color: var(--p-primary-color); font-size: 1.5rem"
        />
        <span class="auth-logo-text">Reka</span>
      </div>

      <h2 class="auth-title">Welcome back</h2>
      <p class="auth-subtitle">Sign in to your demo account</p>

      <Message
        v-if="error"
        severity="error"
        :closable="false"
        style="width: 100%"
      >
        {{ error }}
      </Message>

      <form class="auth-form" @submit.prevent="handleLogin">
        <div class="auth-field">
          <label>Email</label>
          <InputText
            v-model="email"
            type="email"
            placeholder="you@example.com"
            fluid
          />
        </div>
        <div class="auth-field">
          <label>Password</label>
          <Password v-model="password" :feedback="false" toggleMask fluid />
        </div>
        <Button
          type="submit"
          label="Sign In"
          icon="pi pi-sign-in"
          :loading="loading"
          fluid
        />
      </form>

      <p class="auth-link">
        Don't have an account?
        <router-link to="/auth/device?code=">Sign up</router-link>
      </p>
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
.auth-link {
  text-align: center;
  font-size: 0.8125rem;
  color: var(--p-text-muted-color);
  margin: 0;
}
.auth-link a {
  color: var(--p-primary-color);
  text-decoration: none;
}
</style>
