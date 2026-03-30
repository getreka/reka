<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import Card from "primevue/card";
import Panel from "primevue/panel";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import Select from "primevue/select";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import Tag from "primevue/tag";
import VChart from "vue-echarts";
import { use } from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useAppStore } from "@/stores/app";
import { useToast } from "@/composables/useToast";
import { useConfirm } from "primevue/useconfirm";
import {
  fetchApiKeys,
  createApiKey,
  deleteApiKey,
  fetchUsage,
  fetchQueues,
  fetchActors,
} from "@/api/settings";
import type {
  ApiKey,
  ApiKeyCreated,
  UsageStats,
  QueueInfo,
  ActorInfo,
} from "@/api/settings";

use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

const app = useAppStore();
const toast = useToast();
const confirm = useConfirm();

// --- Existing settings ---

const refreshOptions = [
  { label: "Off", value: 0 },
  { label: "30 seconds", value: 30000 },
  { label: "1 minute", value: 60000 },
  { label: "5 minutes", value: 300000 },
];

async function testConnection() {
  await app.checkHealth();
  if (app.isConnected) {
    toast.success("Connection successful");
  } else {
    toast.error("Connection failed", app.healthError);
  }
}

function handleClearStorage() {
  confirm.require({
    message:
      "This will clear all localStorage data (project, API key, preferences). Continue?",
    header: "Clear localStorage",
    acceptLabel: "Clear",
    rejectLabel: "Cancel",
    accept: () => {
      app.clearAllStorage();
      toast.info("localStorage cleared");
    },
  });
}

// --- API Keys ---

const apiKeys = ref<ApiKey[]>([]);
const apiKeysLoading = ref(false);
const apiKeysError = ref("");

const createKeyVisible = ref(false);
const newKeyName = ref("");
const newKeyCreating = ref(false);
const createdKey = ref<ApiKeyCreated | null>(null);
const createdKeyVisible = ref(false);

async function loadApiKeys() {
  apiKeysLoading.value = true;
  apiKeysError.value = "";
  try {
    apiKeys.value = await fetchApiKeys();
  } catch (e: any) {
    const status = e.response?.status;
    if (status === 404) {
      apiKeysError.value = "API key management not available on this server.";
    } else {
      apiKeysError.value =
        e.response?.data?.error || e.message || "Failed to load API keys";
    }
  } finally {
    apiKeysLoading.value = false;
  }
}

function openCreateKey() {
  newKeyName.value = "";
  createKeyVisible.value = true;
}

async function handleCreateKey() {
  if (!newKeyName.value.trim()) return;
  newKeyCreating.value = true;
  try {
    const result = await createApiKey(newKeyName.value.trim());
    createdKey.value = result;
    createKeyVisible.value = false;
    createdKeyVisible.value = true;
    await loadApiKeys();
  } catch (e: any) {
    toast.error("Failed to create key", e.response?.data?.error || e.message);
  } finally {
    newKeyCreating.value = false;
  }
}

async function handleDeleteKey(key: ApiKey) {
  confirm.require({
    message: `Delete API key "${key.name}" (${key.prefix}...)? This cannot be undone.`,
    header: "Delete API Key",
    acceptLabel: "Delete",
    rejectLabel: "Cancel",
    acceptClass: "p-button-danger",
    accept: async () => {
      try {
        await deleteApiKey(key.id);
        toast.success("Key deleted");
        await loadApiKeys();
      } catch (e: any) {
        toast.error(
          "Failed to delete key",
          e.response?.data?.error || e.message,
        );
      }
    },
  });
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Copy failed", "Use Ctrl+C to copy manually");
  }
}

// --- Usage & Billing ---

const usage = ref<UsageStats | null>(null);
const usageLoading = ref(false);
const usageUnavailable = ref(false);

const usageChartOption = computed(() => {
  const days = usage.value?.byDay ?? [];
  return {
    tooltip: { trigger: "axis" as const },
    grid: { left: 40, right: 20, top: 10, bottom: 30 },
    xAxis: {
      type: "category" as const,
      data: days.map((d) => d.date.slice(5)),
    },
    yAxis: { type: "value" as const },
    series: [
      {
        type: "bar" as const,
        data: days.map((d) => d.requests),
        itemStyle: { color: "var(--p-primary-500, #6366f1)" },
      },
    ],
  };
});

async function loadUsage() {
  usageLoading.value = true;
  usageUnavailable.value = false;
  try {
    usage.value = await fetchUsage();
  } catch (e: any) {
    usageUnavailable.value = true;
  } finally {
    usageLoading.value = false;
  }
}

function formatCost(n: number) {
  return `$${n.toFixed(4)}`;
}

function formatNumber(n: number) {
  return n.toLocaleString();
}

// --- Platform Configuration ---

const queues = ref<QueueInfo[]>([]);
const actors = ref<ActorInfo[]>([]);
const platformLoading = ref(false);
const platformUnavailable = ref(false);

async function loadPlatformConfig() {
  platformLoading.value = true;
  platformUnavailable.value = false;
  try {
    const [q, a] = await Promise.allSettled([fetchQueues(), fetchActors()]);
    queues.value = q.status === "fulfilled" ? q.value : [];
    actors.value = a.status === "fulfilled" ? a.value : [];
    if (q.status === "rejected" && a.status === "rejected") {
      platformUnavailable.value = true;
    }
  } finally {
    platformLoading.value = false;
  }
}

onMounted(() => {
  loadApiKeys();
  loadUsage();
  loadPlatformConfig();
});
</script>

<template>
  <div
    style="display: flex; flex-direction: column; gap: 1.5rem; max-width: 48rem"
  >
    <!-- API Connection -->
    <Card>
      <template #title>API Connection</template>
      <template #content>
        <div style="display: flex; flex-direction: column; gap: 1rem">
          <div>
            <label
              style="
                font-size: 0.875rem;
                font-weight: 600;
                display: block;
                margin-bottom: 0.25rem;
              "
              >API URL</label
            >
            <InputText
              v-model="app.apiUrl"
              placeholder="http://localhost:3100"
              style="width: 100%"
            />
          </div>
          <div>
            <label
              style="
                font-size: 0.875rem;
                font-weight: 600;
                display: block;
                margin-bottom: 0.25rem;
              "
              >API Key</label
            >
            <Password
              v-model="app.apiKey"
              :feedback="false"
              toggleMask
              style="width: 100%"
              :inputStyle="{ width: '100%' }"
            />
          </div>
          <div>
            <label
              style="
                font-size: 0.875rem;
                font-weight: 600;
                display: block;
                margin-bottom: 0.25rem;
              "
              >Project Name</label
            >
            <InputText
              v-model="app.currentProject"
              placeholder="my-project"
              style="width: 100%"
            />
          </div>
          <Button
            label="Test Connection"
            icon="pi pi-check-circle"
            size="small"
            @click="testConnection"
          />
        </div>
      </template>
    </Card>

    <!-- Appearance -->
    <Card>
      <template #title>Appearance</template>
      <template #content>
        <div style="display: flex; flex-direction: column; gap: 1rem">
          <div
            style="
              display: flex;
              align-items: center;
              justify-content: space-between;
            "
          >
            <span style="font-size: 0.875rem">Dark Mode</span>
            <ToggleSwitch v-model="app.isDark" />
          </div>
          <div>
            <label
              style="
                font-size: 0.875rem;
                font-weight: 600;
                display: block;
                margin-bottom: 0.25rem;
              "
              >Auto-Refresh Interval</label
            >
            <Select
              v-model="app.autoRefreshInterval"
              :options="refreshOptions"
              optionLabel="label"
              optionValue="value"
              style="width: 100%"
            />
          </div>
        </div>
      </template>
    </Card>

    <!-- API Keys -->
    <Panel header="API Keys" toggleable>
      <div style="display: flex; flex-direction: column; gap: 1rem">
        <div
          v-if="apiKeysError"
          style="font-size: 0.875rem; color: var(--p-text-muted-color)"
        >
          {{ apiKeysError }}
        </div>
        <template v-else>
          <DataTable
            :value="apiKeys"
            :loading="apiKeysLoading"
            size="small"
            :rows="10"
          >
            <Column field="name" header="Name" />
            <Column header="Key Prefix">
              <template #body="{ data }">
                <code style="font-size: 0.8rem">{{ data.prefix }}...</code>
              </template>
            </Column>
            <Column header="Created">
              <template #body="{ data }">
                {{ new Date(data.createdAt).toLocaleDateString() }}
              </template>
            </Column>
            <Column header="Last Used">
              <template #body="{ data }">
                <span v-if="data.lastUsed">
                  {{ new Date(data.lastUsed).toLocaleDateString() }}
                </span>
                <span v-else style="color: var(--p-text-muted-color)"
                  >Never</span
                >
              </template>
            </Column>
            <Column header="" style="width: 4rem">
              <template #body="{ data }">
                <Button
                  icon="pi pi-trash"
                  severity="danger"
                  text
                  size="small"
                  @click="handleDeleteKey(data)"
                />
              </template>
            </Column>
            <template #empty>
              <span
                style="color: var(--p-text-muted-color); font-size: 0.875rem"
              >
                No API keys found.
              </span>
            </template>
          </DataTable>
          <div>
            <Button
              label="Create Key"
              icon="pi pi-plus"
              size="small"
              @click="openCreateKey"
            />
          </div>
        </template>
      </div>
    </Panel>

    <!-- Usage & Billing -->
    <Panel header="Usage & Billing" toggleable>
      <div
        v-if="usageLoading"
        style="font-size: 0.875rem; color: var(--p-text-muted-color)"
      >
        Loading...
      </div>
      <div
        v-else-if="usageUnavailable"
        style="font-size: 0.875rem; color: var(--p-text-muted-color)"
      >
        Billing not configured on this server.
      </div>
      <div
        v-else-if="usage"
        style="display: flex; flex-direction: column; gap: 1.25rem"
      >
        <div
          style="
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1rem;
          "
        >
          <div style="display: flex; flex-direction: column; gap: 0.25rem">
            <span
              style="
                font-size: 0.75rem;
                color: var(--p-text-muted-color);
                text-transform: uppercase;
                letter-spacing: 0.05em;
              "
              >Total Requests</span
            >
            <span style="font-size: 1.5rem; font-weight: 600">{{
              formatNumber(usage.totalRequests)
            }}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 0.25rem">
            <span
              style="
                font-size: 0.75rem;
                color: var(--p-text-muted-color);
                text-transform: uppercase;
                letter-spacing: 0.05em;
              "
              >Total Tokens</span
            >
            <span style="font-size: 1.5rem; font-weight: 600">{{
              formatNumber(usage.totalTokens)
            }}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 0.25rem">
            <span
              style="
                font-size: 0.75rem;
                color: var(--p-text-muted-color);
                text-transform: uppercase;
                letter-spacing: 0.05em;
              "
              >Est. Cost</span
            >
            <span style="font-size: 1.5rem; font-weight: 600">{{
              formatCost(usage.costEstimate)
            }}</span>
          </div>
        </div>
        <div v-if="usage.byDay && usage.byDay.length > 0">
          <div
            style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem"
          >
            Requests (last 7 days)
          </div>
          <VChart :option="usageChartOption" style="height: 200px" autoresize />
        </div>
      </div>
    </Panel>

    <!-- Platform Configuration -->
    <Panel header="Platform Configuration" toggleable>
      <div
        v-if="platformLoading"
        style="font-size: 0.875rem; color: var(--p-text-muted-color)"
      >
        Loading...
      </div>
      <div
        v-else-if="platformUnavailable"
        style="font-size: 0.875rem; color: var(--p-text-muted-color)"
      >
        Platform configuration endpoints not available on this server.
      </div>
      <div v-else style="display: flex; flex-direction: column; gap: 1.25rem">
        <div v-if="queues.length > 0">
          <div
            style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem"
          >
            EDA Queues
          </div>
          <DataTable :value="queues" size="small">
            <Column field="name" header="Queue" />
            <Column
              field="concurrency"
              header="Concurrency"
              style="width: 8rem"
            />
            <Column header="Waiting" style="width: 6rem">
              <template #body="{ data }">
                {{ data.waiting ?? "—" }}
              </template>
            </Column>
            <Column header="Active" style="width: 6rem">
              <template #body="{ data }">
                {{ data.active ?? "—" }}
              </template>
            </Column>
            <Column header="Failed" style="width: 6rem">
              <template #body="{ data }">
                <Tag
                  v-if="data.failed && data.failed > 0"
                  :value="String(data.failed)"
                  severity="danger"
                />
                <span v-else>{{ data.failed ?? "—" }}</span>
              </template>
            </Column>
          </DataTable>
        </div>
        <div v-if="actors.length > 0">
          <div
            style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem"
          >
            Actors
          </div>
          <DataTable :value="actors" size="small">
            <Column field="name" header="Actor" />
            <Column
              field="concurrency"
              header="Concurrency"
              style="width: 8rem"
            />
            <Column header="Status" style="width: 8rem">
              <template #body="{ data }">
                <Tag
                  v-if="data.status"
                  :value="data.status"
                  :severity="
                    data.status === 'running' ? 'success' : 'secondary'
                  "
                />
                <span v-else style="color: var(--p-text-muted-color)">—</span>
              </template>
            </Column>
          </DataTable>
        </div>
        <div
          v-if="queues.length === 0 && actors.length === 0"
          style="font-size: 0.875rem; color: var(--p-text-muted-color)"
        >
          No queue or actor data returned.
        </div>
      </div>
    </Panel>

    <!-- Danger Zone -->
    <Card>
      <template #title>
        <span style="color: var(--p-red-500)">Danger Zone</span>
      </template>
      <template #content>
        <Button
          label="Clear localStorage"
          icon="pi pi-trash"
          severity="danger"
          outlined
          @click="handleClearStorage"
        />
      </template>
    </Card>
  </div>

  <!-- Create API Key dialog -->
  <Dialog
    v-model:visible="createKeyVisible"
    header="Create API Key"
    modal
    style="width: 24rem"
  >
    <div style="display: flex; flex-direction: column; gap: 1rem">
      <div>
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Key Name</label
        >
        <InputText
          v-model="newKeyName"
          placeholder="e.g. CI pipeline"
          style="width: 100%"
          autofocus
          @keyup.enter="handleCreateKey"
        />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="createKeyVisible = false" />
      <Button
        label="Create"
        :loading="newKeyCreating"
        :disabled="!newKeyName.trim()"
        @click="handleCreateKey"
      />
    </template>
  </Dialog>

  <!-- Show created key dialog (one-time display) -->
  <Dialog
    v-model:visible="createdKeyVisible"
    header="API Key Created"
    modal
    style="width: 32rem"
    :closable="true"
  >
    <div style="display: flex; flex-direction: column; gap: 1rem">
      <div
        style="
          background: var(--p-yellow-50, #fefce8);
          border: 1px solid var(--p-yellow-300, #fde047);
          border-radius: 0.375rem;
          padding: 0.75rem 1rem;
          font-size: 0.875rem;
          color: var(--p-yellow-800, #854d0e);
        "
      >
        <strong>Copy this key now.</strong> It will not be shown again.
      </div>
      <div v-if="createdKey">
        <label
          style="
            font-size: 0.875rem;
            font-weight: 600;
            display: block;
            margin-bottom: 0.25rem;
          "
          >Key: {{ createdKey.name }}</label
        >
        <div style="display: flex; gap: 0.5rem; align-items: center">
          <InputText
            :value="createdKey.key"
            readonly
            style="width: 100%; font-family: monospace; font-size: 0.8rem"
          />
          <Button
            icon="pi pi-copy"
            size="small"
            @click="copyToClipboard(createdKey!.key)"
          />
        </div>
      </div>
    </div>
    <template #footer>
      <Button label="Done" @click="createdKeyVisible = false" />
    </template>
  </Dialog>
</template>
