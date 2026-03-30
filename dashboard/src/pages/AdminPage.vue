<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import Card from "primevue/card";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import Button from "primevue/button";
import ConfirmDialog from "primevue/confirmdialog";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import { useConfirm } from "primevue/useconfirm";
import { useToast } from "@/composables/useToast";
import { usePolling } from "@/composables/usePolling";
import {
  fetchQueues,
  fetchDLQ,
  fetchActors,
  retryDLQJob,
  deleteDLQJob,
} from "@/api/admin";
import type { QueueStats, DLQJob, ActorStatus } from "@/api/admin";

const confirm = useConfirm();
const toast = useToast();

const actors = ref<ActorStatus[]>([]);
const queues = ref<QueueStats[]>([]);
const dlqJobs = ref<DLQJob[]>([]);
const totalFailed = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);

async function loadAll() {
  try {
    const [actorsData, queuesData, dlqData] = await Promise.all([
      fetchActors(),
      fetchQueues(),
      fetchDLQ(50),
    ]);
    actors.value = actorsData;
    queues.value = queuesData;
    dlqJobs.value = dlqData.jobs;
    totalFailed.value = dlqData.totalFailed;
    error.value = null;
  } catch (e: any) {
    error.value =
      e?.response?.data?.error || e?.message || "Failed to load admin data";
  }
}

async function initialLoad() {
  loading.value = true;
  await loadAll();
  loading.value = false;
}

const { start: startPolling } = usePolling(loadAll, 15_000);

onMounted(() => {
  initialLoad().then(() => startPolling());
});

function mailboxSeverity(depth: number): "success" | "warn" | "danger" {
  if (depth < 10) return "success";
  if (depth < 50) return "warn";
  return "danger";
}

function mailboxLabel(depth: number): string {
  if (depth < 10) return "Healthy";
  if (depth < 50) return "Busy";
  return "Overloaded";
}

function failedSeverity(count: number): "success" | "danger" {
  return count > 0 ? "danger" : "success";
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(str: string, max = 80): string {
  return str && str.length > max ? str.slice(0, max) + "…" : str;
}

function handleRetry(job: DLQJob) {
  confirm.require({
    message: `Retry job "${job.name}" (${job.id}) from queue "${job.queue}"?`,
    header: "Confirm Retry",
    icon: "pi pi-refresh",
    acceptLabel: "Retry",
    rejectLabel: "Cancel",
    accept: async () => {
      try {
        await retryDLQJob(job.queue, job.id);
        toast.success("Job retried", `${job.name} re-queued`);
        await loadAll();
      } catch (e: any) {
        toast.error("Retry failed", e?.response?.data?.error || e?.message);
      }
    },
  });
}

function handleDelete(job: DLQJob) {
  confirm.require({
    message: `Permanently delete job "${job.name}" (${job.id})? This cannot be undone.`,
    header: "Confirm Delete",
    icon: "pi pi-trash",
    acceptLabel: "Delete",
    rejectLabel: "Cancel",
    acceptClass: "p-button-danger",
    accept: async () => {
      try {
        await deleteDLQJob(job.queue, job.id);
        toast.success("Job deleted");
        await loadAll();
      } catch (e: any) {
        toast.error("Delete failed", e?.response?.data?.error || e?.message);
      }
    },
  });
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1.5rem">
    <ConfirmDialog />

    <div
      style="display: flex; align-items: center; justify-content: space-between"
    >
      <h1 style="margin: 0; font-size: 1.5rem; font-weight: 700">
        System Administration
      </h1>
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        text
        :loading="loading"
        @click="loadAll"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false">{{
      error
    }}</Message>

    <div
      v-if="loading && actors.length === 0"
      style="display: flex; justify-content: center; padding: 3rem"
    >
      <ProgressSpinner />
    </div>

    <template v-else>
      <!-- Actor System -->
      <section>
        <h2 style="margin: 0 0 0.75rem; font-size: 1.1rem; font-weight: 600">
          <i class="pi pi-users" style="margin-right: 0.5rem" />Actor System
        </h2>
        <div
          v-if="actors.length === 0"
          style="color: var(--p-text-muted-color); font-size: 0.875rem"
        >
          No actor data available.
        </div>
        <div
          v-else
          style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
            gap: 1rem;
          "
        >
          <Card v-for="actor in actors" :key="actor.actorType">
            <template #title>
              <div
                style="
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  font-size: 0.95rem;
                "
              >
                <span>{{ actor.actorType }}</span>
                <Tag
                  :severity="mailboxSeverity(actor.mailboxDepth)"
                  :value="mailboxLabel(actor.mailboxDepth)"
                  style="font-size: 0.7rem"
                />
              </div>
            </template>
            <template #content>
              <div
                style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.35rem;
                  font-size: 0.85rem;
                "
              >
                <div style="display: flex; justify-content: space-between">
                  <span style="color: var(--p-text-muted-color)"
                    >Mailbox depth</span
                  >
                  <strong>{{ actor.mailboxDepth }}</strong>
                </div>
                <div style="display: flex; justify-content: space-between">
                  <span style="color: var(--p-text-muted-color)">Active</span>
                  <strong>{{ actor.activeJobs }}</strong>
                </div>
                <div style="display: flex; justify-content: space-between">
                  <span style="color: var(--p-text-muted-color)"
                    >Completed</span
                  >
                  <strong>{{ actor.completedJobs }}</strong>
                </div>
                <div style="display: flex; justify-content: space-between">
                  <span style="color: var(--p-text-muted-color)">Failed</span>
                  <strong
                    :style="
                      actor.failedJobs > 0 ? 'color: var(--p-red-500)' : ''
                    "
                  >
                    {{ actor.failedJobs }}
                  </strong>
                </div>
              </div>
            </template>
          </Card>
        </div>
      </section>

      <!-- Queue Health -->
      <section>
        <h2 style="margin: 0 0 0.75rem; font-size: 1.1rem; font-weight: 600">
          <i class="pi pi-list" style="margin-right: 0.5rem" />Event Queues
        </h2>
        <DataTable
          :value="queues"
          size="small"
          stripedRows
          :rows="20"
          :paginator="queues.length > 20"
        >
          <template #empty>
            <span style="color: var(--p-text-muted-color)"
              >No queues found.</span
            >
          </template>
          <Column field="name" header="Queue" sortable />
          <Column
            field="waiting"
            header="Waiting"
            sortable
            style="width: 7rem; text-align: right"
          />
          <Column
            field="active"
            header="Active"
            sortable
            style="width: 7rem; text-align: right"
          />
          <Column
            field="completed"
            header="Completed"
            sortable
            style="width: 8rem; text-align: right"
          />
          <Column
            field="delayed"
            header="Delayed"
            sortable
            style="width: 7rem; text-align: right"
          />
          <Column field="failed" header="Failed" sortable style="width: 7rem">
            <template #body="{ data }">
              <Tag
                :value="String(data.failed)"
                :severity="failedSeverity(data.failed)"
                style="font-size: 0.75rem"
              />
            </template>
          </Column>
        </DataTable>
      </section>

      <!-- Dead Letter Queue -->
      <section>
        <h2 style="margin: 0 0 0.75rem; font-size: 1.1rem; font-weight: 600">
          <i class="pi pi-exclamation-triangle" style="margin-right: 0.5rem" />
          Dead Letter Queue
          <Tag
            v-if="totalFailed > 0"
            :value="String(totalFailed)"
            severity="danger"
            style="margin-left: 0.5rem; font-size: 0.75rem"
          />
        </h2>
        <DataTable
          :value="dlqJobs"
          size="small"
          stripedRows
          :rows="20"
          :paginator="dlqJobs.length > 20"
        >
          <template #empty>
            <span style="color: var(--p-text-muted-color)"
              >No failed jobs.</span
            >
          </template>
          <Column field="queue" header="Queue" sortable style="width: 9rem" />
          <Column field="name" header="Job" sortable style="width: 10rem" />
          <Column field="failedReason" header="Reason">
            <template #body="{ data }">
              <span
                v-tooltip.top="data.failedReason"
                style="font-size: 0.8rem; color: var(--p-text-muted-color)"
              >
                {{ truncate(data.failedReason) }}
              </span>
            </template>
          </Column>
          <Column
            field="attemptsMade"
            header="Attempts"
            sortable
            style="width: 7rem; text-align: right"
          />
          <Column field="timestamp" header="Time" sortable style="width: 8rem">
            <template #body="{ data }">
              <span
                v-tooltip.top="new Date(data.timestamp).toLocaleString()"
                style="font-size: 0.8rem"
              >
                {{ relativeTime(data.timestamp) }}
              </span>
            </template>
          </Column>
          <Column header="Actions" style="width: 8rem">
            <template #body="{ data }">
              <div style="display: flex; gap: 0.25rem">
                <Button
                  icon="pi pi-refresh"
                  size="small"
                  text
                  severity="info"
                  v-tooltip.top="'Retry job'"
                  @click="handleRetry(data)"
                />
                <Button
                  icon="pi pi-trash"
                  size="small"
                  text
                  severity="danger"
                  v-tooltip.top="'Delete job'"
                  @click="handleDelete(data)"
                />
              </div>
            </template>
          </Column>
        </DataTable>
      </section>
    </template>
  </div>
</template>
