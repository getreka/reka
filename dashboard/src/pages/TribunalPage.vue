<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import Button from "primevue/button";
import Card from "primevue/card";
import Tag from "primevue/tag";
import Message from "primevue/message";
import ProgressSpinner from "primevue/progressspinner";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import { fetchDebateHistory, fetchDebateDetail } from "@/api/tribunal";
import type { DebateSummary, DebateDetail } from "@/api/tribunal";
import { useProjectWatch } from "@/composables/useProjectWatch";

const debates = ref<DebateSummary[]>([]);
const selectedDebate = ref<DebateDetail | null>(null);
const loading = ref(false);
const detailLoading = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

async function loadHistory() {
  loading.value = true;
  error.value = null;
  try {
    debates.value = await fetchDebateHistory(20);
  } catch (e: any) {
    error.value = e?.response?.data?.error ?? "Failed to load debates";
  } finally {
    loading.value = false;
  }
}

async function selectDebate(debate: DebateSummary) {
  if (selectedId.value === debate.id) {
    selectedId.value = null;
    selectedDebate.value = null;
    return;
  }
  selectedId.value = debate.id;
  selectedDebate.value = null;
  detailLoading.value = true;
  try {
    selectedDebate.value = await fetchDebateDetail(debate.id);
  } catch {
    selectedDebate.value = null;
  } finally {
    detailLoading.value = false;
  }
}

function clearSelection() {
  selectedId.value = null;
  selectedDebate.value = null;
}

function statusSeverity(
  status: string,
): "success" | "danger" | "warn" | "secondary" | "info" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "pending":
      return "warn";
    default:
      return "secondary";
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const verdictRecommendation = computed(() => {
  const v = selectedDebate.value?.verdict;
  if (!v) return null;
  return v.recommendation ?? v.winner ?? v.decision ?? null;
});

const verdictConfidence = computed(() => {
  const v = selectedDebate.value?.verdict;
  if (!v) return null;
  const c = v.confidence ?? v.score;
  if (c == null) return null;
  return typeof c === "number" && c <= 1
    ? `${(c * 100).toFixed(0)}%`
    : String(c);
});

const scoresArray = computed<
  Array<{ position: string; score: number | string; justification?: string }>
>(() => {
  const s = selectedDebate.value?.scores;
  if (!s) return [];
  if (Array.isArray(s)) return s;
  // scores may be a keyed object: { "Position A": { score, justification } }
  return Object.entries(s).map(([position, val]: [string, any]) => ({
    position,
    score: val?.score ?? val,
    justification: val?.justification ?? "",
  }));
});

useProjectWatch(() => {
  debates.value = [];
  clearSelection();
  loadHistory();
});

onMounted(() => loadHistory());
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 1rem">
    <!-- Header -->
    <div
      style="display: flex; justify-content: space-between; align-items: center"
    >
      <div style="display: flex; align-items: center; gap: 0.75rem">
        <span style="font-size: 1.125rem; font-weight: 600">
          Tribunal Debates
        </span>
        <Tag
          v-if="debates.length > 0"
          :value="String(debates.length)"
          severity="info"
        />
      </div>
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        text
        :loading="loading"
        @click="loadHistory()"
      />
    </div>

    <Message v-if="error" severity="error" :closable="false">{{
      error
    }}</Message>

    <!-- Loading -->
    <div
      v-if="loading"
      style="display: flex; justify-content: center; padding: 3rem"
    >
      <ProgressSpinner />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="debates.length === 0"
      style="
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding: 4rem 2rem;
        color: var(--p-text-muted-color);
      "
    >
      <i class="pi pi-comments" style="font-size: 3rem; opacity: 0.3" />
      <span>No debates yet</span>
    </div>

    <!-- Master-detail layout -->
    <div v-else style="display: flex; gap: 1rem; align-items: flex-start">
      <!-- Left: debate list -->
      <div style="flex: 1; min-width: 0">
        <DataTable
          :value="debates"
          :rowHover="true"
          :rowClass="
            (row: DebateSummary) =>
              row.id === selectedId ? 'row-selected' : ''
          "
          @row-click="(e: any) => selectDebate(e.data)"
          size="small"
          stripedRows
        >
          <Column header="Topic" style="min-width: 14rem">
            <template #body="{ data }">
              <span
                :style="
                  data.id === selectedId
                    ? 'font-weight: 600; color: var(--p-primary-color)'
                    : ''
                "
              >
                {{ truncate(data.topic) }}
              </span>
            </template>
          </Column>

          <Column header="Positions" style="min-width: 12rem">
            <template #body="{ data }">
              <div style="display: flex; flex-wrap: wrap; gap: 0.25rem">
                <Tag
                  v-for="pos in data.positions"
                  :key="pos"
                  :value="truncate(pos, 30)"
                  severity="secondary"
                  style="font-size: 0.7rem"
                  v-tooltip="pos"
                />
              </div>
            </template>
          </Column>

          <Column header="Status" style="width: 7rem">
            <template #body="{ data }">
              <Tag
                :severity="statusSeverity(data.status)"
                :value="data.status"
              />
            </template>
          </Column>

          <Column header="Verdict" style="min-width: 8rem">
            <template #body="{ data }">
              <span
                v-if="data.verdict?.recommendation || data.verdict?.winner"
                style="font-size: 0.8rem; color: var(--p-text-muted-color)"
              >
                {{
                  truncate(
                    data.verdict?.recommendation ?? data.verdict?.winner ?? "—",
                    40,
                  )
                }}
              </span>
              <span v-else style="color: var(--p-text-muted-color)">—</span>
            </template>
          </Column>

          <Column header="Duration" style="width: 7rem">
            <template #body="{ data }">
              {{ formatDuration(data.durationMs) }}
            </template>
          </Column>

          <Column header="When" style="width: 7rem">
            <template #body="{ data }">
              <span
                style="font-size: 0.8rem; color: var(--p-text-muted-color)"
                v-tooltip="new Date(data.createdAt).toLocaleString()"
              >
                {{ relativeTime(data.createdAt) }}
              </span>
            </template>
          </Column>
        </DataTable>
      </div>

      <!-- Right: detail panel -->
      <div v-if="selectedId" style="width: 28rem; flex-shrink: 0">
        <Card>
          <template #title>
            <div
              style="
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 0.5rem;
              "
            >
              <span style="font-size: 0.95rem; font-weight: 600; flex: 1">
                Debate Detail
              </span>
              <Button
                icon="pi pi-times"
                text
                size="small"
                @click="clearSelection()"
              />
            </div>
          </template>

          <template #content>
            <!-- Loading detail -->
            <div
              v-if="detailLoading"
              style="display: flex; justify-content: center; padding: 2rem"
            >
              <ProgressSpinner style="width: 2rem; height: 2rem" />
            </div>

            <div
              v-else-if="selectedDebate"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
                font-size: 0.875rem;
              "
            >
              <!-- Topic -->
              <div>
                <div
                  style="
                    font-size: 0.7rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--p-text-muted-color);
                    margin-bottom: 0.25rem;
                  "
                >
                  Topic
                </div>
                <div style="font-weight: 500">{{ selectedDebate.topic }}</div>
              </div>

              <!-- Positions -->
              <div v-if="selectedDebate.positions?.length">
                <div
                  style="
                    font-size: 0.7rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--p-text-muted-color);
                    margin-bottom: 0.375rem;
                  "
                >
                  Positions
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 0.375rem">
                  <Tag
                    v-for="pos in selectedDebate.positions"
                    :key="pos"
                    :value="pos"
                    severity="info"
                    style="font-size: 0.75rem"
                  />
                </div>
              </div>

              <!-- Verdict block -->
              <div
                v-if="selectedDebate.verdict"
                style="
                  background: var(--p-surface-50);
                  border: 1px solid var(--p-surface-200);
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                "
              >
                <div style="font-weight: 600; font-size: 0.9rem">
                  <i
                    class="pi pi-check-circle"
                    style="
                      margin-right: 0.375rem;
                      color: var(--p-primary-color);
                    "
                  />
                  Verdict
                </div>

                <div v-if="verdictRecommendation">
                  <span style="color: var(--p-text-muted-color)">
                    Recommendation:
                  </span>
                  <span style="font-weight: 500; margin-left: 0.25rem">
                    {{ verdictRecommendation }}
                  </span>
                </div>

                <div v-if="verdictConfidence">
                  <span style="color: var(--p-text-muted-color)">
                    Confidence:
                  </span>
                  <span style="font-weight: 500; margin-left: 0.25rem">
                    {{ verdictConfidence }}
                  </span>
                </div>

                <div
                  v-if="selectedDebate.verdict.reasoning"
                  style="
                    margin-top: 0.25rem;
                    color: var(--p-text-muted-color);
                    font-size: 0.8rem;
                    line-height: 1.5;
                  "
                >
                  <div
                    style="
                      font-weight: 600;
                      color: var(--p-text-color);
                      margin-bottom: 0.25rem;
                    "
                  >
                    Reasoning
                  </div>
                  {{ selectedDebate.verdict.reasoning }}
                </div>

                <div
                  v-if="selectedDebate.verdict.dissent"
                  style="
                    margin-top: 0.25rem;
                    border-top: 1px solid var(--p-surface-200);
                    padding-top: 0.5rem;
                    font-size: 0.8rem;
                    line-height: 1.5;
                  "
                >
                  <div style="font-weight: 600; margin-bottom: 0.25rem">
                    Dissent
                  </div>
                  {{ selectedDebate.verdict.dissent }}
                </div>
              </div>

              <!-- Scores table -->
              <div v-if="scoresArray.length">
                <div
                  style="
                    font-size: 0.7rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--p-text-muted-color);
                    margin-bottom: 0.375rem;
                  "
                >
                  Scores
                </div>
                <table
                  style="
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 0.8rem;
                  "
                >
                  <thead>
                    <tr
                      style="
                        border-bottom: 1px solid var(--p-surface-200);
                        text-align: left;
                        color: var(--p-text-muted-color);
                      "
                    >
                      <th style="padding: 0.25rem 0.5rem 0.25rem 0">
                        Position
                      </th>
                      <th style="padding: 0.25rem 0.5rem; width: 4rem">
                        Score
                      </th>
                      <th style="padding: 0.25rem 0">Justification</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in scoresArray"
                      :key="row.position"
                      style="border-bottom: 1px solid var(--p-surface-100)"
                    >
                      <td
                        style="
                          padding: 0.375rem 0.5rem 0.375rem 0;
                          font-weight: 500;
                          vertical-align: top;
                        "
                      >
                        {{ row.position }}
                      </td>
                      <td
                        style="
                          padding: 0.375rem 0.5rem;
                          vertical-align: top;
                          font-variant-numeric: tabular-nums;
                        "
                      >
                        <Tag
                          :value="String(row.score)"
                          severity="secondary"
                          style="font-size: 0.75rem"
                        />
                      </td>
                      <td
                        style="
                          padding: 0.375rem 0;
                          color: var(--p-text-muted-color);
                          vertical-align: top;
                          line-height: 1.4;
                        "
                      >
                        {{ row.justification || "—" }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Phases -->
              <div v-if="selectedDebate.phases?.length">
                <div
                  style="
                    font-size: 0.7rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--p-text-muted-color);
                    margin-bottom: 0.5rem;
                  "
                >
                  Phases
                </div>
                <div style="display: flex; flex-direction: column; gap: 0.5rem">
                  <div
                    v-for="(phase, i) in selectedDebate.phases"
                    :key="i"
                    style="
                      border-left: 3px solid var(--p-primary-200);
                      padding-left: 0.75rem;
                      font-size: 0.8rem;
                    "
                  >
                    <div
                      style="
                        font-weight: 600;
                        margin-bottom: 0.2rem;
                        text-transform: capitalize;
                      "
                    >
                      {{ phase.name ?? phase.phase ?? `Phase ${i + 1}` }}
                    </div>
                    <div
                      v-if="phase.content || phase.summary"
                      style="color: var(--p-text-muted-color); line-height: 1.5"
                    >
                      {{ phase.content ?? phase.summary }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- Metadata -->
              <div
                style="
                  font-size: 0.75rem;
                  color: var(--p-text-muted-color);
                  border-top: 1px solid var(--p-surface-200);
                  padding-top: 0.5rem;
                "
              >
                <span>{{
                  new Date(selectedDebate.createdAt).toLocaleString()
                }}</span>
              </div>
            </div>
          </template>
        </Card>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.row-selected td) {
  background: var(--p-primary-50) !important;
}
</style>
